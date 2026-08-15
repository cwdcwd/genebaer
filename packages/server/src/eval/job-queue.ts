import { randomUUID } from "node:crypto";

/** One genome awaiting a score. */
export interface EvalJob {
  /** Groups every job belonging to one generation of one run. */
  readonly evaluationId: string;
  /**
   * Position in the population. Scores are reassembled by this, never by
   * arrival order — workers finish out of order by nature.
   */
  readonly index: number;
  readonly genome: unknown;
  /** Scoring contract this job needs, e.g. "clip-similarity". */
  readonly evaluatorId: string;
  /** Evaluator params, e.g. the prompt. Part of what a worker needs. */
  readonly params: Record<string, unknown>;
}

interface PendingEvaluation {
  readonly evaluatorId: string;
  readonly total: number;
  readonly scores: (number | undefined)[];
  remaining: number;
  resolve: (scores: number[]) => void;
  reject: (err: Error) => void;
  settled: boolean;
}

/** Jobs handed to one worker, valid until `expiresAt`. */
export interface Lease {
  readonly leaseId: string;
  readonly workerId: string;
  readonly jobs: readonly EvalJob[];
  expiresAt: number;
}

export interface QueueStats {
  /** Jobs waiting to be claimed. */
  readonly pending: number;
  /** Evaluations still waiting on at least one score. */
  readonly openEvaluations: number;
  /** Leases currently held by workers. */
  readonly activeLeases: number;
  /** Times a lease expired and its jobs went back to the queue. */
  readonly expiredLeases: number;
}

function jobKey(evaluationId: string, index: number): string {
  return `${evaluationId}:${String(index)}`;
}

/**
 * Holds genomes awaiting scores and resolves a generation only once every one
 * of its jobs has reported.
 *
 * The engine stays generational: selection needs a complete, consistently
 * scored population, so the barrier is the point. What the queue adds is that
 * the N jobs behind that barrier can be served by any number of workers, in
 * any order, rather than by one evaluator in sequence.
 *
 * Jobs are held in memory only. Runs do not survive a restart — RunManager
 * reconciles them to stopped on boot — so persisting a queue whose run will
 * never resume would buy nothing.
 */
export class JobQueue {
  private readonly pending: EvalJob[] = [];
  private readonly evaluations = new Map<string, PendingEvaluation>();
  private readonly leases = new Map<string, Lease>();
  /** jobKey -> leaseId, so a submitted score can clear its lease entry. */
  private readonly leaseByJob = new Map<string, string>();
  private expiredLeaseCount = 0;

  /**
   * Enqueue a whole population and return a promise for its scores, in
   * population order.
   */
  submit(
    evaluatorId: string,
    params: Record<string, unknown>,
    genomes: readonly unknown[],
  ): Promise<number[]> {
    const evaluationId = randomUUID();

    // An empty population has nothing to wait for; resolving here keeps
    // callers from hanging on a barrier that can never be crossed.
    if (genomes.length === 0) return Promise.resolve([]);

    return new Promise<number[]>((resolve, reject) => {
      this.evaluations.set(evaluationId, {
        evaluatorId,
        total: genomes.length,
        scores: new Array<number | undefined>(genomes.length),
        remaining: genomes.length,
        resolve,
        reject,
        settled: false,
      });
      for (let index = 0; index < genomes.length; index++) {
        this.pending.push({
          evaluationId,
          index,
          genome: genomes[index],
          evaluatorId,
          params,
        });
      }
    });
  }

  /**
   * Take up to `max` jobs a worker can serve.
   *
   * Only jobs whose evaluatorId the worker advertised are offered, so a
   * CLIP worker is never handed a job it cannot score.
   */
  claim(capabilities: readonly string[], max: number): EvalJob[] {
    if (max <= 0) return [];
    const able = new Set(capabilities);
    const taken: EvalJob[] = [];
    for (let i = 0; i < this.pending.length && taken.length < max; ) {
      const job = this.pending[i] as EvalJob;
      if (able.has(job.evaluatorId) && this.evaluations.has(job.evaluationId)) {
        taken.push(job);
        this.pending.splice(i, 1);
      } else {
        i++;
      }
    }
    return taken;
  }

  /**
   * Claim jobs under a lease.
   *
   * A lease is what stops one vanished worker from hanging a run forever.
   * Because the engine is generational it waits for EVERY score, so a worker
   * that claims jobs and then disappears — a closed tab, a killed thread, a
   * shut laptop — would otherwise hold the barrier open indefinitely. On
   * expiry the jobs go back to the queue for anyone else.
   *
   * Returns null when nothing matches, so callers can distinguish "no work"
   * from "work handed over".
   */
  claimWithLease(
    workerId: string,
    capabilities: readonly string[],
    max: number,
    leaseMs: number,
    now: number = Date.now(),
  ): Lease | null {
    const jobs = this.claim(capabilities, max);
    if (jobs.length === 0) return null;
    const lease: Lease = {
      leaseId: randomUUID(),
      workerId,
      jobs,
      expiresAt: now + leaseMs,
    };
    this.leases.set(lease.leaseId, lease);
    for (const job of jobs) {
      this.leaseByJob.set(jobKey(job.evaluationId, job.index), lease.leaseId);
    }
    return lease;
  }

  /**
   * Extend a lease a worker is still actively working on.
   *
   * Returns false for an unknown or already-expired lease, which tells the
   * worker its jobs have been re-dispatched and it should claim afresh rather
   * than keep grinding on work someone else now owns.
   */
  heartbeat(leaseId: string, leaseMs: number, now: number = Date.now()): boolean {
    const lease = this.leases.get(leaseId);
    if (!lease) return false;
    if (lease.expiresAt <= now) return false;
    lease.expiresAt = now + leaseMs;
    return true;
  }

  /**
   * Return jobs from any lease that has run out of time.
   *
   * Only jobs still unscored are requeued: a worker may have submitted some of
   * its batch before stalling, and re-scoring those would be wasted work.
   */
  expireLeases(now: number = Date.now()): number {
    let expired = 0;
    for (const [leaseId, lease] of [...this.leases]) {
      if (lease.expiresAt > now) continue;
      this.releaseLease(leaseId, true);
      expired += 1;
      this.expiredLeaseCount += 1;
    }
    return expired;
  }

  /** Drop a lease, optionally returning its unfinished jobs to the queue. */
  releaseLease(leaseId: string, requeueOutstanding: boolean): void {
    const lease = this.leases.get(leaseId);
    if (!lease) return;
    this.leases.delete(leaseId);
    const outstanding: EvalJob[] = [];
    for (const job of lease.jobs) {
      const key = jobKey(job.evaluationId, job.index);
      if (this.leaseByJob.get(key) === leaseId) {
        this.leaseByJob.delete(key);
        outstanding.push(job);
      }
    }
    if (requeueOutstanding) this.requeue(outstanding);
  }

  /** Release every lease held by a worker, e.g. when it disconnects. */
  releaseWorker(workerId: string): number {
    let released = 0;
    for (const [leaseId, lease] of [...this.leases]) {
      if (lease.workerId !== workerId) continue;
      this.releaseLease(leaseId, true);
      released += 1;
    }
    return released;
  }

  /** Put jobs back at the front, e.g. after a lease expired. */
  requeue(jobs: readonly EvalJob[]): void {
    for (const job of jobs) {
      // Drop jobs whose evaluation is already settled or cancelled.
      if (!this.evaluations.has(job.evaluationId)) continue;
      if (this.evaluations.get(job.evaluationId)?.scores[job.index] !== undefined) {
        continue;
      }
      this.pending.unshift(job);
    }
  }

  /**
   * Record one score.
   *
   * Returns true when the score was applied. A submission for an unknown or
   * already-settled evaluation, an out-of-range index, or a job that already
   * has a score is discarded — late and duplicate replies are normal in a
   * distributed system and must never corrupt a live generation.
   */
  submitScore(evaluationId: string, index: number, score: number): boolean {
    const evaluation = this.evaluations.get(evaluationId);
    if (!evaluation || evaluation.settled) return false;
    if (!Number.isInteger(index) || index < 0 || index >= evaluation.total) return false;
    if (evaluation.scores[index] !== undefined) return false;
    if (!Number.isFinite(score)) {
      this.failEvaluation(
        evaluationId,
        new Error(
          `Score for index ${index} of evaluation ${evaluationId} was ${String(score)}; ` +
            `a non-finite fitness would silently poison selection.`,
        ),
      );
      return false;
    }

    evaluation.scores[index] = score;
    evaluation.remaining -= 1;
    // The job is done, so it is no longer outstanding on whatever lease held
    // it. A later expiry of that lease must not requeue an already-scored job.
    this.leaseByJob.delete(jobKey(evaluationId, index));
    if (evaluation.remaining === 0) {
      evaluation.settled = true;
      this.evaluations.delete(evaluationId);
      // Any jobs for this evaluation still sitting unclaimed are now dead
      // work. Left in place they would accumulate and be handed to workers
      // for a generation that is already complete.
      this.dropPendingFor(evaluationId);
      evaluation.resolve(evaluation.scores as number[]);
    }
    return true;
  }

  /** Fail a whole evaluation, e.g. a worker reporting it cannot score a job. */
  failEvaluation(evaluationId: string, err: Error): void {
    const evaluation = this.evaluations.get(evaluationId);
    if (!evaluation || evaluation.settled) return;
    evaluation.settled = true;
    this.evaluations.delete(evaluationId);
    this.dropPendingFor(evaluationId);
    evaluation.reject(err);
  }

  /** Abandon everything, e.g. on shutdown. */
  cancelAll(reason: string): void {
    for (const id of [...this.evaluations.keys()]) {
      this.failEvaluation(id, new Error(reason));
    }
    this.pending.length = 0;
  }

  stats(): QueueStats {
    return {
      pending: this.pending.length,
      openEvaluations: this.evaluations.size,
      activeLeases: this.leases.size,
      expiredLeases: this.expiredLeaseCount,
    };
  }

  private dropPendingFor(evaluationId: string): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if ((this.pending[i] as EvalJob).evaluationId === evaluationId) {
        this.pending.splice(i, 1);
      }
    }
  }
}
