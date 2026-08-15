import { describe, expect, it } from "vitest";
import {
  BinaryEncoding,
  DIVERSITY_MAX_SAMPLE,
  DIVERSITY_MIN_SAMPLE,
  diversitySampleSize,
  GeneticAlgorithmEngine,
  createDefaultRegistry,
  type GenerationStats,
  type RunConfig,
} from "./index.js";

function config(length: number, populationSize = 50): RunConfig {
  return {
    problem: { id: "one-max" },
    encoding: { id: "binary", params: { length } },
    selection: { id: "tournament" },
    crossover: { id: "one-point" },
    mutation: { id: "bit-flip" },
    mutationRate: 0.001,
    populationSize,
    elitism: 2,
    termination: [{ id: "max-generations", params: { maxGenerations: 1 } }],
    seed: 11,
  };
}

/** Run one generation and return its stats. */
async function oneGeneration(cfg: RunConfig): Promise<GenerationStats> {
  const engine = new GeneticAlgorithmEngine<number[]>(cfg, createDefaultRegistry());
  const stats = await new Promise<GenerationStats>((resolve, reject) => {
    engine.on("generation", (s) => resolve(s));
    engine.on("error", (e) => reject(e));
    setTimeout(() => reject(new Error("timed out")), 30_000);
    engine.start();
  });
  engine.stop();
  return stats;
}

describe("diversity cost at large genomes", () => {
  it("stays fast on a 98,304-bit genome — the image case", async () => {
    // 64x64 RGB. With a fixed 50-individual sample this is 1,225 pairs of
    // 98,304-element Hamming distances: ~120M comparisons EVERY generation,
    // dominating a loop it is only supposed to describe.
    const started = Date.now();
    const stats = await oneGeneration(config(98_304, 50));
    const elapsed = Date.now() - started;

    expect(Number.isFinite(stats.diversity)).toBe(true);
    // Generous: the point is that it is bounded, not that it hits a number.
    // Unbounded, this generation took multiple seconds on the same machine.
    expect(elapsed).toBeLessThan(5000);
  });

  it("still produces a meaningful, non-zero diversity signal there", async () => {
    const stats = await oneGeneration(config(98_304, 50));
    // Random binary genomes differ in roughly half their bits, so mean pairwise
    // Hamming distance should land near length/2. A collapsed or broken metric
    // would read 0.
    expect(stats.diversity).toBeGreaterThan(98_304 * 0.3);
    expect(stats.diversity).toBeLessThan(98_304 * 0.7);
  });

  it("leaves small genomes on the full sample, unchanged", async () => {
    const stats = await oneGeneration(config(32, 50));
    // 32 genes x 1,225 pairs is trivial, so nothing is reduced here.
    expect(stats.diversity).toBeGreaterThan(32 * 0.2);
    expect(stats.diversity).toBeLessThan(32 * 0.8);
  });
});

describe("the reduced estimate agrees with the exact one", () => {
  it("tracks a full-sample mean within sampling error", () => {
    // Compute both directly on a population small enough to do exactly, which
    // is the only honest way to show the estimate is not biased.
    const encoding = new BinaryEncoding({ length: 4096 });
    const rng = new (class {
      private s = 12345;
      next(): number {
        this.s = (this.s * 1103515245 + 12345) % 2147483648;
        return this.s / 2147483648;
      }
      int(min: number, max: number): number {
        return min + Math.floor(this.next() * (max - min));
      }
      pick<T>(arr: readonly T[]): T {
        return arr[this.int(0, arr.length)] as T;
      }
      shuffle<T>(arr: T[]): T[] {
        for (let i = arr.length - 1; i > 0; i--) {
          const j = this.int(0, i + 1);
          [arr[i], arr[j]] = [arr[j] as T, arr[i] as T];
        }
        return arr;
      }
    })();

    const population = Array.from({ length: 50 }, () => encoding.random(rng));

    const meanOver = (k: number): number => {
      let sum = 0;
      let pairs = 0;
      for (let i = 0; i < k; i++) {
        for (let j = i + 1; j < k; j++) {
          sum += encoding.distance(population[i] as number[], population[j] as number[]);
          pairs++;
        }
      }
      return sum / pairs;
    };

    const exact = meanOver(50);
    const reduced = meanOver(11); // roughly what the budget allows at 4096 genes

    // Both estimate the same population statistic; a few percent apart is
    // sampling error, not a different measurement.
    expect(Math.abs(reduced - exact) / exact).toBeLessThan(0.1);
  });
});

describe("diversitySampleSize policy", () => {
  const BUDGET = 2_000_000;

  it("uses the full sample for small genomes", () => {
    // 32 genes: 1,225 pairs x 32 = 39,200 comparisons, far under budget.
    expect(diversitySampleSize(50, 32, BUDGET)).toBe(DIVERSITY_MAX_SAMPLE);
    expect(diversitySampleSize(50, 1, BUDGET)).toBe(DIVERSITY_MAX_SAMPLE);
  });

  it("shrinks the sample as genomes grow, keeping cost bounded", () => {
    const at98k = diversitySampleSize(50, 98_304, BUDGET);
    expect(at98k).toBeLessThan(DIVERSITY_MAX_SAMPLE);
    // The property that matters: total comparisons stay inside the budget.
    const pairs = (at98k * (at98k - 1)) / 2;
    expect(pairs * 98_304).toBeLessThanOrEqual(BUDGET);
  });

  it("is monotonic — a bigger genome never gets a bigger sample", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (const length of [1, 100, 1_000, 10_000, 98_304, 1_000_000]) {
      const size = diversitySampleSize(50, length, BUDGET);
      expect(size).toBeLessThanOrEqual(previous);
      previous = size;
    }
  });

  it("never drops below the floor, however large the genome", () => {
    // Below a handful of individuals the statistic stops meaning anything, so
    // the floor holds even when the budget says otherwise.
    expect(diversitySampleSize(50, 10_000_000_000, BUDGET)).toBe(DIVERSITY_MIN_SAMPLE);
  });

  it("never asks for more individuals than the population has", () => {
    expect(diversitySampleSize(7, 1, BUDGET)).toBe(7);
    expect(diversitySampleSize(3, 1, BUDGET)).toBe(DIVERSITY_MIN_SAMPLE);
  });
});
