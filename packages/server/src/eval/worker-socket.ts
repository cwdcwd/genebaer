import type {
  EvalJobPayload,
  WorkerClientMessage,
  WorkerServerMessage,
} from "@genebaer/shared-types";
import type { JobQueue } from "./job-queue.js";
import type { WorkerRegistry } from "./worker-registry.js";

export interface WorkerSocketOptions {
  queue: JobQueue;
  registry: WorkerRegistry;
  leaseMs: number;
  kind?: string;
}

/**
 * Drive one worker connection.
 *
 * Transport-agnostic on purpose: it takes a `send` function and consumes
 * already-parsed messages, so the WebSocket route is a thin shell around it and
 * the whole protocol can be tested without opening a socket.
 *
 * By this point a browser tab is an ADAPTER, not an architecture. It speaks the
 * same register/claim/score/heartbeat vocabulary as a worker thread; only the
 * bytes travel differently. Browser workers are inherently unreliable — tabs get
 * closed, backgrounded and throttled — but that is already handled by lease
 * expiry and re-dispatch, which is exactly why those were made mandatory rather
 * than optional.
 */
export class WorkerConnection {
  private readonly opts: WorkerSocketOptions;
  private readonly send: (msg: WorkerServerMessage) => void;
  private workerId: string | null = null;

  constructor(send: (msg: WorkerServerMessage) => void, opts: WorkerSocketOptions) {
    this.send = send;
    this.opts = opts;
  }

  get id(): string | null {
    return this.workerId;
  }

  handle(message: WorkerClientMessage): void {
    switch (message.type) {
      case "worker.register": {
        const worker = this.opts.registry.register(
          message.capabilities,
          this.opts.kind ?? "browser",
        );
        this.workerId = worker.workerId;
        this.send({
          type: "worker.registered",
          workerId: worker.workerId,
          leaseMs: this.opts.leaseMs,
        });
        return;
      }

      case "worker.claim": {
        if (!this.workerId) return this.notRegistered();
        this.opts.registry.touch(this.workerId);
        const lease = this.opts.queue.claimWithLease(
          this.workerId,
          this.opts.registry.capabilityKeys(this.workerId),
          message.max,
          this.opts.leaseMs,
        );
        if (!lease) {
          this.send({ type: "worker.idle" });
          return;
        }
        const jobs: EvalJobPayload[] = lease.jobs.map((j) => ({
          evaluationId: j.evaluationId,
          index: j.index,
          genome: j.genome,
          evaluatorId: j.evaluatorId,
          params: j.params,
        }));
        this.send({
          type: "worker.lease",
          leaseId: lease.leaseId,
          expiresAt: lease.expiresAt,
          jobs,
        });
        return;
      }

      case "worker.score": {
        if (!this.workerId) return this.notRegistered();
        this.opts.registry.touch(this.workerId);
        // Not gated on the lease still being live: if the job is unscored, a
        // late answer is good work. The queue refuses to overwrite.
        this.opts.queue.submitScore(message.evaluationId, message.index, message.score);
        return;
      }

      case "worker.heartbeat": {
        if (!this.workerId) return this.notRegistered();
        this.opts.registry.touch(this.workerId);
        const extended = this.opts.queue.heartbeat(message.leaseId, this.opts.leaseMs);
        if (!extended) {
          // Its jobs were re-dispatched. Say so, so the tab stops grinding on
          // work another worker now owns.
          this.send({
            type: "worker.leaseLost",
            leaseId: message.leaseId,
            reason: "Lease expired and the jobs were re-dispatched; claim again.",
          });
        }
        return;
      }

      case "worker.fail": {
        if (!this.workerId) return this.notRegistered();
        this.opts.registry.touch(this.workerId);
        this.opts.queue.failEvaluation(
          message.evaluationId,
          new Error(`Worker reported failure: ${message.reason}`),
        );
        return;
      }
    }
  }

  /**
   * The tab went away.
   *
   * Releasing leases here is what makes closing a browser cheap: the jobs go
   * straight back to the queue instead of waiting out a lease.
   */
  close(): void {
    if (!this.workerId) return;
    this.opts.queue.releaseWorker(this.workerId);
    this.opts.registry.deregister(this.workerId);
    this.workerId = null;
  }

  private notRegistered(): void {
    this.send({
      type: "worker.leaseLost",
      leaseId: "",
      reason: "Not registered; send worker.register first.",
    });
  }
}

/** Narrow an unknown frame to a worker message, or null. */
export function parseWorkerMessage(raw: string): WorkerClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== "string" || !type.startsWith("worker.")) return null;
  return parsed as WorkerClientMessage;
}
