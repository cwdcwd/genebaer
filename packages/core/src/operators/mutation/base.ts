import { BaseOperator } from "../../base.js";
import type { RandomSource } from "../../random.js";

/** Mutates a genome in place or returns a mutated copy (implementations choose). */
export abstract class MutationOperator<G = unknown> extends BaseOperator {
  abstract mutate(genome: G, rate: number, rng: RandomSource): G;
}
