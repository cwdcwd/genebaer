import type { RandomSource } from "../../random.js";
import { MutationOperator } from "./base.js";

/** Flip each bit with probability `rate`. Binary genomes (number[] 0/1). */
export class BitFlipMutation extends MutationOperator<unknown> {
  static override readonly operatorId = "bit-flip";
  static override readonly displayName = "Bit flip";
  static override readonly description = "Flip each bit with probability = mutation rate.";
  static override readonly paramsSchema = {} as const;
  static readonly compatibleEncodings = ["binary"] as const;

  override mutate(genome: unknown, rate: number, rng: RandomSource): unknown {
    if (!Array.isArray(genome)) {
      throw new TypeError("BitFlipMutation: array genome required");
    }
    const g = genome as number[];
    for (let i = 0; i < g.length; i++) {
      if (rng.next() < rate) g[i] = g[i] === 0 ? 1 : 0;
    }
    return g;
  }
}
