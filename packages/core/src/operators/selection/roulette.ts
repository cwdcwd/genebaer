import type { RandomSource } from "../../random.js";
import { SelectionOperator } from "./base.js";

/**
 * Fitness-proportionate selection. Handles negative fitness by shifting to
 * [0, range] using the population minimum.
 */
export class RouletteWheelSelection extends SelectionOperator<unknown> {
  static override readonly operatorId = "roulette";
  static override readonly displayName = "Roulette wheel";
  static override readonly description =
    "Fitness-proportionate selection (negative fitnesses are shifted up).";
  static override readonly paramsSchema = {} as const;

  override select(
    population: readonly unknown[],
    fitnesses: readonly number[],
    count: number,
    rng: RandomSource,
  ): unknown[] {
    const n = population.length;
    if (n === 0) return [];

    // Shift so minimum fitness is 0 (eps so at least one slot exists).
    let min = Infinity;
    for (const f of fitnesses) if (f < min) min = f;
    const shifted = new Array<number>(n);
    let total = 0;
    for (let i = 0; i < n; i++) {
      const v = (fitnesses[i] as number) - min + 1e-12;
      shifted[i] = v;
      total += v;
    }

    const out: unknown[] = new Array(count);
    for (let c = 0; c < count; c++) {
      let r = rng.next() * total;
      let idx = 0;
      while (idx < n - 1 && r > (shifted[idx] as number)) {
        r -= shifted[idx] as number;
        idx++;
      }
      out[c] = population[idx];
    }
    return out;
  }
}
