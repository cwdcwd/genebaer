import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { WorkerCapability } from "@genebaer/shared-types";
import type { EvalJob, JobQueue } from "./job-queue.js";
import type { WorkerRegistry } from "./worker-registry.js";

interface ThreadResult {
  index: number;
  score?: number;
  error?: string;
}

interface PendingBatch {
  jobs: EvalJob[];
  leaseId: string;
  resolve: (results: ThreadResult[]) => void;
  reject: (err: Error) => void;
}

export interface WorkerPoolOptions {
  queue: JobQueue;
  registry: WorkerRegistry;
  /** Contracts these threads can serve. */
  capabilities: WorkerCapability[];
  /** Number of threads. Defaults to 2; scoring is CPU-bound. */
  threads?: number;
  /** Jobs handed to one thread at a time. */
  batchSize?: number;
  /** How long a claim stays valid. */
  leaseMs?: number;
  /** Idle poll interval when there is no work. */
  pollMs?: number;
}

/**
 * A pool of Node worker threads claiming from the same queue, over the same
 * protocol, as any external worker.
 *
 * This is the piece that dissolves the original "server or browser?" question.
 * A worker thread is not a fast path or a special case: it registers its
 * capabilities, claims a lease, scores, and submits, exactly as a browser tab
 * does over WebSocket. Whichever workers you happen to have is a deployment
 * choice, not an architecture.
 *
 * Threads matter specifically because the engine drives its generation loop on
 * setImmediate. CPU-bound scoring on the main thread would starve that loop and
 * stall the very run it is trying to advance.
 */
export class WorkerPool {
  private readonly opts: Required<Omit<WorkerPoolOptions, "capabilities">> & {
    capabilities: WorkerCapability[];
  };
  private readonly threads: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly pending = new Map<string, PendingBatch>();
  private workerId: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(options: WorkerPoolOptions) {
    this.opts = {
      queue: options.queue,
      registry: options.registry,
      capabilities: options.capabilities,
      threads: options.threads ?? 2,
      batchSize: options.batchSize ?? 8,
      leaseMs: options.leaseMs ?? 30_000,
      pollMs: options.pollMs ?? 10,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    const entry = fileURLToPath(new URL("./score-thread.mjs", import.meta.url));
    for (let i = 0; i < this.opts.threads; i++) {
      const thread = new Worker(entry);
      thread.on("message", (msg: { batchId: string; results: ThreadResult[] }) => {
        const batch = this.pending.get(msg.batchId);
        this.pending.delete(msg.batchId);
        this.idle.push(thread);
        batch?.resolve(msg.results);
      });
      thread.on("error", (err) => {
        // One thread dying must not strand its jobs: the lease expires and the
        // work is re-dispatched, which is the same path a crashed browser tab
        // takes.
        for (const [batchId, batch] of [...this.pending]) {
          this.pending.delete(batchId);
          batch.reject(err);
        }
      });
      // A pool thread must never hold the process open.
      thread.unref();
      this.threads.push(thread);
      this.idle.push(thread);
    }

    this.workerId = this.opts.registry.register(
      this.opts.capabilities,
      "worker-thread",
    ).workerId;

    this.timer = setInterval(() => void this.pump(), this.opts.pollMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.workerId) {
      this.opts.queue.releaseWorker(this.workerId);
      this.opts.registry.deregister(this.workerId);
      this.workerId = null;
    }
    await Promise.all(this.threads.map((t) => t.terminate()));
    this.threads.length = 0;
    this.idle.length = 0;
    this.pending.clear();
  }

  /** Claim what we can and hand it to free threads. */
  private async pump(): Promise<void> {
    if (!this.running || !this.workerId) return;
    const workerId = this.workerId;
    this.opts.registry.touch(workerId);

    while (this.idle.length > 0) {
      const lease = this.opts.queue.claimWithLease(
        workerId,
        this.opts.registry.capabilityKeys(workerId),
        this.opts.batchSize,
        this.opts.leaseMs,
      );
      if (!lease) return;

      const thread = this.idle.pop();
      if (!thread) {
        // No thread after all: hand the work straight back rather than sitting
        // on a lease we cannot service.
        this.opts.queue.releaseLease(lease.leaseId, true);
        return;
      }

      const batchId = randomUUID();
      const jobs = [...lease.jobs];
      const done = new Promise<ThreadResult[]>((resolve, reject) => {
        this.pending.set(batchId, { jobs, leaseId: lease.leaseId, resolve, reject });
      });
      thread.postMessage({
        batchId,
        jobs: jobs.map((j) => ({
          index: j.index,
          genome: j.genome,
          evaluatorId: j.evaluatorId,
          params: j.params,
        })),
      });

      try {
        const results = await done;
        for (const result of results) {
          const job = jobs.find((j) => j.index === result.index);
          if (!job) continue;
          if (result.error !== undefined) {
            // A scorer that cannot score this genome fails the evaluation
            // rather than leaving the generation short a value forever.
            this.opts.queue.failEvaluation(
              job.evaluationId,
              new Error(`Worker thread: ${result.error}`),
            );
            continue;
          }
          this.opts.queue.submitScore(job.evaluationId, job.index, result.score as number);
        }
        this.opts.queue.releaseLease(lease.leaseId, false);
      } catch (err) {
        this.opts.queue.releaseLease(lease.leaseId, true);
        for (const job of jobs) {
          this.opts.queue.failEvaluation(
            job.evaluationId,
            err instanceof Error ? err : new Error(String(err)),
          );
        }
      }
    }
  }

  /** Currently registered worker id, or null when stopped. */
  get id(): string | null {
    return this.workerId;
  }
}
