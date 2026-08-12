import type { JSONSchema } from "@genebaer/shared-types";
import { FitnessProblem, type VisualFrame } from "../operators/problem/base.js";

/**
 * Sphere function: f(x) = Σ xᵢ², global minimum 0 at origin.
 * Fitness is negative value (GA maximises): f* = 0.
 */
export class Sphere extends FitnessProblem<number[]> {
  static override readonly operatorId = "sphere";
  static override readonly displayName = "Sphere";
  static override readonly description =
    "Minimise Σ xᵢ² (fitness = −value; optimum 0 at origin).";
  static override readonly paramsSchema: Record<string, JSONSchema> = {};
  static override readonly compatibleEncodings = ["numeric"] as const;

  override evaluate(genome: number[]): number {
    let s = 0;
    for (const x of genome) s += x * x;
    return -s;
  }

  override visualize(best: number[]): VisualFrame {
    return { problemId: Sphere.operatorId, data: [...best] };
  }
}

/**
 * Rastrigin function: f(x) = 10n + Σ (xᵢ² − 10 cos(2π xᵢ)), min 0 at origin.
 * Highly multimodal — a classic GA benchmark. Fitness = −f(x).
 */
export class Rastrigin extends FitnessProblem<number[]> {
  static override readonly operatorId = "rastrigin";
  static override readonly displayName = "Rastrigin";
  static override readonly description =
    "Minimise the multimodal Rastrigin function (fitness = −value; optimum 0).";
  static override readonly paramsSchema: Record<string, JSONSchema> = {};
  static override readonly compatibleEncodings = ["numeric"] as const;

  override evaluate(genome: number[]): number {
    const n = genome.length;
    let s = 10 * n;
    for (const x of genome) s += x * x - 10 * Math.cos(2 * Math.PI * x);
    return -s;
  }

  override visualize(best: number[]): VisualFrame {
    return { problemId: Rastrigin.operatorId, data: [...best] };
  }
}
