import {
  BaseOperator,
  FitnessEvaluator,
  type EvaluationContext,
} from "@genebaer/core";
import type { JobQueue } from "./job-queue.js";

/**
 * The queue a queued evaluator submits to.
 *
 * Module-level because the registry constructs operators with `new ctor(params)`
 * and has no way to inject a service. Everything runs in one process, so a
 * single active queue is the whole truth; the server sets it during startup and
 * clears it on close.
 */
let activeQueue: JobQueue | null = null;

export function setActiveQueue(queue: JobQueue | null): void {
  activeQueue = queue;
}

export function getActiveQueue(): JobQueue | null {
  return activeQueue;
}

/**
 * Base for any evaluator whose work is done by external workers.
 *
 * Subclasses supply only identity: the concrete class's `operatorId` IS the
 * scoring contract that workers advertise capability for. That is what keeps a
 * RunConfig portable — it names "clip-similarity", never a machine — and what
 * makes server threads and browser tabs interchangeable.
 */
export abstract class QueuedEvaluator extends FitnessEvaluator<unknown> {
  /** The contract id workers must advertise to be offered these jobs. */
  get contract(): string {
    return (this.constructor as typeof BaseOperator).operatorId;
  }

  override evaluateBatch(
    genomes: readonly unknown[],
    _context: EvaluationContext<unknown>,
  ): Promise<number[]> {
    const queue = activeQueue;
    if (!queue) {
      return Promise.reject(
        new Error(
          `Evaluator '${this.contract}' needs a job queue, but none is active. ` +
            `Queued evaluators only work inside a running server.`,
        ),
      );
    }
    return queue.submit(this.contract, this.params, genomes);
  }
}
