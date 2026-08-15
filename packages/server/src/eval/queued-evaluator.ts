import {
  BaseOperator,
  FitnessEvaluator,
  type EvaluationContext,
} from "@genebaer/core";
import type { JobQueue } from "./job-queue.js";
import { getActiveScoreCache, scoreKey } from "./score-cache.js";

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
  /**
   * Contract version. Bump it whenever the meaning of the score changes —
   * a different model, different preprocessing, different normalisation.
   * Scores across versions are not comparable, so this keeps a v1 worker from
   * ever being handed a v2 job.
   */
  static readonly version: string = "1";

  /** The contract id workers must advertise to be offered these jobs. */
  get contract(): string {
    return (this.constructor as typeof BaseOperator).operatorId;
  }

  get version(): string {
    return (this.constructor as typeof QueuedEvaluator).version;
  }

  /** Full identity: what a score means, and therefore what it caches under. */
  get identity(): string {
    return `${this.contract}@${this.version}`;
  }

  override async evaluateBatch(
    genomes: readonly unknown[],
    _context: EvaluationContext<unknown>,
  ): Promise<number[]> {
    const queue = activeQueue;
    if (!queue) {
      throw new Error(
        `Evaluator '${this.identity}' needs a job queue, but none is active. ` +
          `Queued evaluators only work inside a running server.`,
      );
    }

    const cache = getActiveScoreCache();
    if (!cache) {
      return queue.submit(this.contract, this.version, this.params, genomes);
    }

    // Resolve what we already know, and collapse repeats. Elitism clones the
    // top N genomes verbatim into every generation, so without this the same
    // genomes are re-scored at full cost forever.
    const scores = new Array<number | undefined>(genomes.length);
    const missIndicesByKey = new Map<string, number[]>();
    for (let i = 0; i < genomes.length; i++) {
      const key = scoreKey(this.contract, this.version, this.params, genomes[i]);
      const hit = cache.get(key);
      if (hit !== undefined) {
        scores[i] = hit;
        continue;
      }
      const existing = missIndicesByKey.get(key);
      if (existing) {
        // Same genome twice in one batch: score it once, fan the result out.
        existing.push(i);
      } else {
        missIndicesByKey.set(key, [i]);
      }
    }

    const uniqueMisses = [...missIndicesByKey.entries()];
    const dedupedCount =
      uniqueMisses.reduce((n, [, idxs]) => n + idxs.length, 0) - uniqueMisses.length;
    if (dedupedCount > 0) cache.countDeduped?.(dedupedCount);

    if (uniqueMisses.length > 0) {
      const missGenomes = uniqueMisses.map(([, idxs]) => genomes[idxs[0] as number]);
      const fresh = await queue.submit(
        this.contract,
        this.version,
        this.params,
        missGenomes,
      );
      uniqueMisses.forEach(([key, idxs], slot) => {
        const score = fresh[slot] as number;
        cache.set(key, score);
        for (const idx of idxs) scores[idx] = score;
      });
    }

    return scores as number[];
  }
}
