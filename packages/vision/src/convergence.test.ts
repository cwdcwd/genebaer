import {
  FitnessProblem,
  GeneticAlgorithmEngine,
  SeededRandomSource,
  createDefaultRegistry,
  type RunConfig,
} from "@genebaer/core";
import { describe, expect, it } from "vitest";
import { bitsToRgb, genomeLengthFor } from "./image-genome.js";

/**
 * Guards the finding in docs/experiments/raw-bitstring-convergence.md:
 * evolution over a raw pixel bit string beats random search at an equal
 * evaluation budget.
 *
 * The budget here is far smaller than the documented experiment so the suite
 * stays fast; the direction is what is being protected, not the exact numbers.
 * If this ever flips, the encoding has stopped working and the recommended
 * defaults in that document are no longer trustworthy.
 */

const SHAPE = { width: 16, height: 16 };
const BITS = genomeLengthFor(SHAPE);

/** Left half red, right half white. */
const TARGET = (() => {
  const bytes = new Uint8Array(SHAPE.width * SHAPE.height * 3);
  for (let y = 0; y < SHAPE.height; y++) {
    for (let x = 0; x < SHAPE.width; x++) {
      const i = (y * SHAPE.width + x) * 3;
      bytes[i] = 255;
      bytes[i + 1] = x < SHAPE.width / 2 ? 0 : 255;
      bytes[i + 2] = x < SHAPE.width / 2 ? 0 : 255;
    }
  }
  return bytes;
})();

/** Normalised similarity in [0,1]. Continuous and bounded, like a CLIP score. */
function similarity(genome: number[]): number {
  const pixels = bitsToRgb(genome, SHAPE);
  let diff = 0;
  for (let i = 0; i < pixels.length; i++) {
    diff += Math.abs((pixels[i] as number) - (TARGET[i] as number));
  }
  return 1 - diff / (pixels.length * 255);
}

class TargetSimilarity extends FitnessProblem<number[]> {
  static override readonly operatorId = "target-similarity";
  static override readonly displayName = "Target similarity";
  static override readonly description = "Proxy image fitness for the spike.";
  static override readonly compatibleEncodings = ["binary"] as const;
  static override readonly paramsSchema = {} as const;
  override evaluate(genome: number[]): number {
    return similarity(genome);
  }
}

const BUDGET = 3000;

function randomSearch(seed: number): number {
  const rng = new SeededRandomSource(seed);
  let best = -Infinity;
  for (let i = 0; i < BUDGET; i++) {
    const genome = new Array<number>(BITS);
    for (let j = 0; j < BITS; j++) genome[j] = rng.next() < 0.5 ? 1 : 0;
    best = Math.max(best, similarity(genome));
  }
  return best;
}

async function evolve(mutationRate: number, populationSize: number): Promise<number> {
  const registry = createDefaultRegistry().register("problem", TargetSimilarity);
  const config: RunConfig = {
    problem: { id: "target-similarity" },
    encoding: { id: "binary", params: { length: BITS } },
    selection: { id: "tournament", params: { k: 3 } },
    crossover: { id: "uniform" },
    mutation: { id: "bit-flip" },
    mutationRate,
    populationSize,
    elitism: 2,
    termination: [
      {
        id: "max-generations",
        params: { maxGenerations: Math.floor(BUDGET / populationSize) },
      },
    ],
    seed: 1,
  };
  const engine = new GeneticAlgorithmEngine<number[]>(config, registry);
  await new Promise<void>((resolve, reject) => {
    engine.on("finished", () => resolve());
    engine.on("error", (e) => reject(e));
    engine.start();
  });
  return engine.bestFitness ?? -Infinity;
}

describe("raw bit-string convergence", () => {
  it("beats random search at an equal evaluation budget", async () => {
    // THE question the spike existed to answer. If evolution cannot beat
    // sampling at random given the same evaluations, no tuning is hiding a
    // real signal and the encoding is inert.
    const baseline = randomSearch(1);
    const evolved = await evolve(0.0005, 30);
    expect(evolved).toBeGreaterThan(baseline);
  }, 60_000);

  it("random search stays near chance, which is why it is the baseline", () => {
    // Two flat colour fields over random bytes: a random genome sits near 0.5,
    // and more samples barely move it.
    const small = randomSearch(1);
    expect(small).toBeGreaterThan(0.4);
    expect(small).toBeLessThan(0.7);
  }, 60_000);

  it("the documented mutation rate outperforms the one originally guessed", async () => {
    // The epic guessed ~1e-4 by reasoning about how many bits 0.01 flips. The
    // direction was right and the magnitude was wrong; this pins the
    // correction so it cannot quietly revert.
    const recommended = await evolve(0.0005, 30);
    const originalGuess = await evolve(0.0001, 30);
    expect(recommended).toBeGreaterThan(originalGuess);
  }, 120_000);
});
