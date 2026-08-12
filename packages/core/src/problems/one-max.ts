import type { JSONSchema } from "@genebaer/shared-types";
import { FitnessProblem, type VisualFrame } from "../operators/problem/base.js";

/** Classic OneMax: fitness = number of 1-bits. Genome: number[] of 0/1. */
export class OneMax extends FitnessProblem<number[]> {
  static override readonly operatorId = "one-max";
  static override readonly displayName = "OneMax";
  static override readonly description =
    "Maximise the number of 1-bits. The 'hello world' of GAs.";
  static override readonly paramsSchema: Record<string, JSONSchema> = {};
  static override readonly compatibleEncodings = ["binary"] as const;

  override evaluate(genome: number[]): number {
    let s = 0;
    for (const b of genome) s += b;
    return s;
  }

  override visualize(best: number[]): VisualFrame {
    return { problemId: OneMax.operatorId, data: [...best] };
  }
}
