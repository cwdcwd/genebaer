import { BaseOperator } from "../../base.js";
import type { RandomSource } from "../../random.js";

/** Recombines two parent genomes into two children. */
export abstract class CrossoverOperator<G = unknown> extends BaseOperator {
  /** Returns exactly two children. */
  abstract crossover(a: G, b: G, rng: RandomSource): [G, G];
}
