import type { RandomSource } from "../../random.js";
import { SelectionOperator } from "./base.js";
import { numberParam } from "../../random.js";

/**
 * Rank selection: probability ∝ rank (linear by default), robust to fitness
 * scaling and negative values.
 */
export class RankSelection extends SelectionOperator<unknown> {
  static override readonly operatorId = "rank";
  static override readonly displayName = "Rank";
  static override readonly description =
    "Probability proportional to fitness rank. Robust to scaling/negatives.";
  static override readonly paramsSchema = {
    pressure: {
      type: "number",
      minimum: 1,
      maximum: 2,
      default: 1.5,
      title: "Selection pressure (1–2)",
      description: "Expected value of the best individual (linear ranking).",
    },
  } as const;

  private readonly pressure: number;

  constructor(params: Record<string, unknown> = {}) {
    super(params);
    this.pressure = numberParam(RankSelection.paramsSchema, params, "pressure", 1.5);
  }

  override select(
    population: readonly unknown[],
    fitnesses: readonly number[],
    count: number,
    rng: RandomSource,
  ): unknown[] {
    const n = population.length;
    if (n === 0) return [];

    // Indices sorted ascending by fitness → rank 0 is worst, n-1 best.
    const order = Array.from({ length: n }, (_, i) => i).sort(
      (a, b) => (fitnesses[a] as number) - (fitnesses[b] as number),
    );

    // Linear ranking (Baker): expected value of rank r (0=worst..n-1=best) =
    // (2 - s) / n + (2 * r * (s - 1)) / (n * (n - 1)), s = pressure ∈ [1,2]
    const s = this.pressure;
    const probs = new Array<number>(n);
    let total = 0;
    for (let rank = 0; rank < n; rank++) {
      const p =
        (2 - s) / n + (n === 1 ? 0 : (2 * rank * (s - 1)) / (n * (n - 1)));
      probs[rank] = p;
      total += p;
    }

    const out: unknown[] = new Array(count);
    for (let c = 0; c < count; c++) {
      let r = rng.next() * total;
      let rank = 0;
      while (rank < n - 1 && r > (probs[rank] as number)) {
        r -= probs[rank] as number;
        rank++;
      }
      out[c] = population[order[rank] as number];
    }
    return out;
  }
}
