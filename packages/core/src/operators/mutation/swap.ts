import type { RandomSource } from "../../random.js";
import { MutationOperator } from "./base.js";

/** Swap two random positions with probability `rate` (per genome). */
export class SwapMutation extends MutationOperator<unknown> {
  static override readonly operatorId = "swap";
  static override readonly displayName = "Swap";
  static override readonly description = "Swap two random positions (per-genome probability).";
  static override readonly paramsSchema = {} as const;
  static readonly compatibleEncodings = ["binary", "numeric", "string"] as const;

  override mutate(genome: unknown, rate: number, rng: RandomSource): unknown {
    if (rng.next() >= rate) return genome;
    if (Array.isArray(genome)) {
      // Array.isArray() narrows `unknown` to `any[]`, not `unknown[]`, so bind
      // through an explicit type to keep the rest of this branch type-safe.
      const g: unknown[] = genome;
      if (g.length < 2) return g;
      const i = rng.int(0, g.length);
      const j = rng.int(0, g.length);
      const t = g[i];
      g[i] = g[j];
      g[j] = t;
      return g;
    }
    if (typeof genome === "string") {
      if (genome.length < 2) return genome;
      const i = rng.int(0, genome.length);
      const j = rng.int(0, genome.length);
      const chars = genome.split("");
      const t = chars[i] as string;
      chars[i] = chars[j] as string;
      chars[j] = t;
      return chars.join("");
    }
    throw new TypeError("SwapMutation: unsupported genome type");
  }
}
