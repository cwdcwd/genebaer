import { BaseOperator } from "../../base.js";
import type { RandomSource } from "../../random.js";

/**
 * Picks parents from the current population, favoring higher fitness.
 * `select` returns `count` genome references (may contain duplicates);
 * the engine clones before crossing over.
 */
export abstract class SelectionOperator<G = unknown> extends BaseOperator {
  abstract select(
    population: readonly G[],
    fitnesses: readonly number[],
    count: number,
    rng: RandomSource,
  ): G[];
}
