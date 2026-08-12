import type { RandomSource } from "../../random.js";
import { SelectionOperator } from "./base.js";
import { numberParam } from "../../random.js";

/** Classic tournament: sample k individuals uniformly, take the fittest. */
export class TournamentSelection extends SelectionOperator<unknown> {
  static override readonly operatorId = "tournament";
  static override readonly displayName = "Tournament";
  static override readonly description =
    "Sample k individuals uniformly at random; keep the fittest. Repeat until enough parents.";
  static override readonly paramsSchema = {
    k: {
      type: "integer",
      minimum: 2,
      maximum: 20,
      default: 3,
      title: "Tournament size (k)",
    },
  } as const;

  private readonly k: number;

  constructor(params: Record<string, unknown> = {}) {
    super(params);
    this.k = Math.max(
      2,
      Math.floor(numberParam(TournamentSelection.paramsSchema, params, "k", 3)),
    );
  }

  override select(
    population: readonly unknown[],
    fitnesses: readonly number[],
    count: number,
    rng: RandomSource,
  ): unknown[] {
    const n = population.length;
    if (n === 0) return [];
    const out: unknown[] = new Array(count);
    for (let c = 0; c < count; c++) {
      let bestIdx = rng.int(0, n);
      let bestFit = fitnesses[bestIdx] as number;
      for (let i = 1; i < this.k; i++) {
        const idx = rng.int(0, n);
        const f = fitnesses[idx] as number;
        if (f > bestFit) {
          bestFit = f;
          bestIdx = idx;
        }
      }
      out[c] = population[bestIdx];
    }
    return out;
  }
}
