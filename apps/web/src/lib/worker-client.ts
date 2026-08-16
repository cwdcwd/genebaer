import type {
  EvalJobPayload,
  WorkerCapability,
  WorkerClientMessage,
  WorkerServerMessage,
} from "@genebaer/shared-types";

export type WorkerState =
  | "idle"
  | "connecting"
  | "registering"
  | "waiting"
  | "scoring"
  | "error";

export interface WorkerClientView {
  state: WorkerState;
  workerId: string | null;
  /** Jobs successfully scored this session. */
  completed: number;
  /** Jobs abandoned because the lease was lost mid-flight. */
  abandoned: number;
  error: string | null;
}

export interface WorkerClientOptions {
  capabilities: WorkerCapability[];
  /** Jobs to request per claim. */
  batchSize: number;
  /** Score one job. Rejecting fails the whole evaluation. */
  score: (job: EvalJobPayload) => Promise<number>;
  send: (msg: WorkerClientMessage) => void;
  onChange: (view: WorkerClientView) => void;
}

/**
 * The browser side of the worker protocol.
 *
 * Deliberately transport-agnostic: it takes a `send` function and consumes
 * already-parsed messages, so the WebSocket wrapper is a thin shell and the
 * whole loop is testable without a socket or a browser.
 *
 * A tab is an unreliable worker by nature — it gets closed, backgrounded and
 * throttled — which is why the server side has lease expiry and re-dispatch.
 * This side's job is to be honest about that: stop working the moment a lease
 * is lost, rather than spending inference on jobs someone else now owns.
 */
export class WorkerClient {
  private readonly opts: WorkerClientOptions;
  private view: WorkerClientView = {
    state: "idle",
    workerId: null,
    completed: 0,
    abandoned: 0,
    error: null,
  };
  /** Lease currently being worked. Cleared the instant it is lost. */
  private activeLease: string | null = null;

  constructor(opts: WorkerClientOptions) {
    this.opts = opts;
  }

  snapshot(): WorkerClientView {
    return { ...this.view };
  }

  /** Called once the transport is open. */
  start(): void {
    this.patch({ state: "registering", error: null });
    this.opts.send({ type: "worker.register", capabilities: this.opts.capabilities });
  }

  stop(): void {
    this.activeLease = null;
    this.patch({ state: "idle", workerId: null });
  }

  fail(message: string): void {
    this.activeLease = null;
    this.patch({ state: "error", error: message });
  }

  handle(msg: WorkerServerMessage): void {
    switch (msg.type) {
      case "worker.registered":
        this.patch({ state: "waiting", workerId: msg.workerId });
        this.claim();
        return;

      case "worker.idle":
        // Nothing to do right now. The caller re-claims on a timer rather than
        // spinning, so this is just a state report.
        this.patch({ state: "waiting" });
        return;

      case "worker.lease":
        this.activeLease = msg.leaseId;
        void this.work(msg.leaseId, msg.jobs);
        return;

      case "worker.leaseLost":
        // The jobs were re-dispatched. Abandon them: continuing would spend
        // inference on work another worker already owns.
        if (this.activeLease === msg.leaseId) this.activeLease = null;
        this.patch({ state: "waiting" });
        return;
    }
  }

  claim(): void {
    if (this.view.state === "error" || this.view.workerId === null) return;
    this.opts.send({ type: "worker.claim", max: this.opts.batchSize });
  }

  private async work(leaseId: string, jobs: EvalJobPayload[]): Promise<void> {
    this.patch({ state: "scoring" });
    for (const job of jobs) {
      // Re-check every iteration, not just once: a lease can be lost part-way
      // through a batch, and the remaining jobs are no longer ours.
      if (this.activeLease !== leaseId) {
        this.patch({ abandoned: this.view.abandoned + 1 });
        return;
      }
      try {
        const score = await this.opts.score(job);
        if (this.activeLease !== leaseId) {
          this.patch({ abandoned: this.view.abandoned + 1 });
          return;
        }
        this.opts.send({
          type: "worker.score",
          leaseId,
          evaluationId: job.evaluationId,
          index: job.index,
          score,
        });
        this.patch({ completed: this.view.completed + 1 });
      } catch (err) {
        // This worker cannot score this job at all — say so, rather than going
        // quiet and costing the run a full lease timeout.
        this.opts.send({
          type: "worker.fail",
          leaseId,
          evaluationId: job.evaluationId,
          reason: err instanceof Error ? err.message : String(err),
        });
        this.fail(err instanceof Error ? err.message : String(err));
        return;
      }
    }
    this.activeLease = null;
    this.patch({ state: "waiting" });
    this.claim();
  }

  private patch(next: Partial<WorkerClientView>): void {
    this.view = { ...this.view, ...next };
    this.opts.onChange(this.snapshot());
  }
}

/** Narrow an incoming frame to a worker-bound message, or null. */
export function parseServerMessage(raw: string): WorkerServerMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== "string" || !type.startsWith("worker.")) return null;
  return parsed as WorkerServerMessage;
}
