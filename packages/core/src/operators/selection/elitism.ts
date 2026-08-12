import type { RandomSource } from "../../random.js";
import { SelectionOperator } from "./base.js";

/**
 * Truncation/"elitist" selection: always pick from the top `proportion` of the
 * population (cycled if more parents are needed than slots).
 */
export class ElitismSelection extends SelectionOperator<unknown> {
  static override readonly operatorId = "elitism";
  static override readonly displayName = "Truncation (elitist)";
  static override readonly description =
    "Pick parents only from the top fraction of the population.";
  static override readonly paramsSchema = {
    proportion: {
      type: "number",
      minimum: 0.01,
      maximum: 1,
      default: 0.5,
      title: "Top proportion",
    },
  } as const;

  private readonly proportion: number;

  constructor(params: Record<string, unknown> = {}) {
    super(params);
    const p = params["proportion"];
    this.proportion =
      typeof p === "number" && Number.isFinite(p)
        ? Math.min(1, Math.max(0.01, p))
        : 0.5;
  }

  override select(
    population: readonly unknown[],
    fitnesses: readonly number[],
    count: number,
    rng: RandomSource,
  ): unknown[] {
    const n = population.length;
    if (n === 0) return [];
    const order = Array.from({ length: n }, (_, i) => i).sort(
      (a, b) => (fitnesses[b] as number) - (fitnesses[a] as number),
    );
    const poolSize = Math.max(1, Math.ceil(n * this.proportion));
    const out: unknown[] = new Array(count);
    for (let c = 0; c < count; c++) {
      const idx = order[rng.int(0, poolSize)] as number;
      out[c] = population[idx];
    }
    return out;
  }
}
