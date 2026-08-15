import { describe, expect, it } from "vitest";
import {
  FitnessEvaluator,
  FitnessProblem,
  GeneticAlgorithmEngine,
  LocalEvaluator,
  createDefaultRegistry,
  type EvaluationContext,
  type RunConfig,
} from "./index.js";

function config(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    problem: { id: "one-max" },
    encoding: { id: "binary", params: { length: 16 } },
    selection: { id: "tournament" },
    crossover: { id: "one-point" },
    mutation: { id: "bit-flip" },
    mutationRate: 0.02,
    populationSize: 10,
    elitism: 1,
    termination: [{ id: "max-generations", params: { maxGenerations: 3 } }],
    seed: 7,
    ...overrides,
  };
}

/**
 * Records what it was asked to score, and answers after a real await.
 *
 * Counters are static because the registry constructs its own instance — the
 * test never gets a handle on the object the engine is actually using.
 */
class RecordingEvaluator extends FitnessEvaluator<unknown> {
  static override readonly operatorId = "recording";
  static override readonly displayName = "Recording";
  static override readonly description = "Test double.";
  static override readonly paramsSchema = {} as const;

  static calls = 0;
  static batchSizes: number[] = [];

  static reset(): void {
    RecordingEvaluator.calls = 0;
    RecordingEvaluator.batchSizes = [];
  }

  override async evaluateBatch(
    genomes: readonly unknown[],
    context: EvaluationContext<unknown>,
  ): Promise<number[]> {
    RecordingEvaluator.calls += 1;
    RecordingEvaluator.batchSizes.push(genomes.length);
    await new Promise((r) => setTimeout(r, 1));
    return genomes.map((g) => context.problem.evaluate(g));
  }
}

class RejectingEvaluator extends FitnessEvaluator<unknown> {
  static override readonly operatorId = "rejecting";
  static override readonly displayName = "Rejecting";
  static override readonly description = "Test double that always fails.";
  static override readonly paramsSchema = {} as const;

  override evaluateBatch(): Promise<number[]> {
    return Promise.reject(new Error("evaluator exploded"));
  }
}

/** Returns the wrong number of scores — the silent-corruption case. */
class ShortEvaluator extends FitnessEvaluator<unknown> {
  static override readonly operatorId = "short";
  static override readonly displayName = "Short";
  static override readonly description = "Test double returning too few scores.";
  static override readonly paramsSchema = {} as const;

  override evaluateBatch(genomes: readonly unknown[]): Promise<number[]> {
    return Promise.resolve(genomes.slice(1).map(() => 0));
  }
}

describe("evaluator as a registry kind", () => {
  it("registers local as a seventh kind and exposes its metadata", () => {
    const registry = createDefaultRegistry();
    expect(registry.has("evaluator", "local")).toBe(true);
    const meta = registry.listMetadata("evaluator");
    expect(meta.map((m) => m.id)).toContain("local");
    expect(meta.every((m) => m.kind === "evaluator")).toBe(true);
  });

  it("defaults to the local evaluator when a config omits one", async () => {
    // The backward-compatibility case: every config written before evaluators
    // existed has no evaluator field at all.
    const engine = new GeneticAlgorithmEngine<number[]>(
      config(),
      createDefaultRegistry(),
    );
    const done = new Promise<void>((resolve) => engine.on("finished", () => resolve()));
    engine.start();
    await done;
    expect(engine.currentGeneration).toBeGreaterThan(0);
    expect(engine.bestFitness).not.toBeNull();
  });

  it("produces identical results whether local is implicit or explicit", async () => {
    const run = async (cfg: RunConfig): Promise<number[]> => {
      const engine = new GeneticAlgorithmEngine<number[]>(cfg, createDefaultRegistry());
      const seq: number[] = [];
      engine.on("generation", (s) => seq.push(s.bestFitness));
      await new Promise<void>((resolve) => {
        engine.on("finished", () => resolve());
        engine.start();
      });
      return seq;
    };
    const implicit = await run(config());
    const explicit = await run(config({ evaluator: { id: "local" } }));
    expect(explicit).toEqual(implicit);
  });
});

describe("async evaluation", () => {
  it("scores the whole population in ONE call per generation, not one per genome", async () => {
    RecordingEvaluator.reset();
    const registry = createDefaultRegistry().register("evaluator", RecordingEvaluator);
    const engine = new GeneticAlgorithmEngine<number[]>(
      config({ populationSize: 10, evaluator: { id: "recording" } }),
      registry,
    );
    const done = new Promise<void>((resolve) => engine.on("finished", () => resolve()));
    engine.start();
    await done;

    // The point of the batch contract: 3 generations of 10 genomes is 3 calls,
    // not 30. Per-genome dispatch is what makes a remote evaluator unusable.
    expect(RecordingEvaluator.calls).toBe(3);
    expect(RecordingEvaluator.batchSizes).toEqual([10, 10, 10]);
  });

  it("awaits a genuinely asynchronous evaluator", async () => {
    const registry = createDefaultRegistry().register("evaluator", RecordingEvaluator);
    const engine = new GeneticAlgorithmEngine<number[]>(
      config({ evaluator: { id: "recording" } }),
      registry,
    );
    const stats: number[] = [];
    engine.on("generation", (s) => stats.push(s.bestFitness));
    await new Promise<void>((resolve) => {
      engine.on("finished", () => resolve());
      engine.start();
    });
    expect(stats.length).toBeGreaterThan(0);
    expect(stats.every((f) => Number.isFinite(f))).toBe(true);
  });

  it("transitions to error when the evaluator rejects, instead of hanging", async () => {
    const registry = createDefaultRegistry().register("evaluator", RejectingEvaluator);
    const engine = new GeneticAlgorithmEngine<number[]>(
      config({ evaluator: { id: "rejecting" } }),
      registry,
    );
    const failed = await new Promise<Error>((resolve, reject) => {
      engine.on("error", (err) => resolve(err));
      setTimeout(() => reject(new Error("engine hung instead of erroring")), 3000);
      engine.start();
    });
    expect(failed.message).toMatch(/exploded/);
    expect(engine.status).toBe("error");
  });

  it("rejects a score count that does not match the population", async () => {
    // Fitness is assigned positionally, so a short result would pair genomes
    // with the wrong scores and corrupt selection with no error anywhere.
    const registry = createDefaultRegistry().register("evaluator", ShortEvaluator);
    const engine = new GeneticAlgorithmEngine<number[]>(
      config({ evaluator: { id: "short" } }),
      registry,
    );
    const failed = await new Promise<Error>((resolve, reject) => {
      engine.on("error", (err) => resolve(err));
      setTimeout(() => reject(new Error("engine hung instead of erroring")), 3000);
      engine.start();
    });
    expect(failed.message).toMatch(/scores for/i);
    expect(engine.status).toBe("error");
  });

  it("does not apply a generation whose scores land after the run stopped", async () => {
    const registry = createDefaultRegistry().register("evaluator", RecordingEvaluator);
    const engine = new GeneticAlgorithmEngine<number[]>(
      config({
        evaluator: { id: "recording" },
        termination: [{ id: "max-generations", params: { maxGenerations: 100000 } }],
      }),
      registry,
    );
    engine.start();
    engine.stop();
    const atStop = engine.currentGeneration;
    await new Promise((r) => setTimeout(r, 50));
    expect(engine.status).toBe("stopped");
    expect(engine.currentGeneration).toBe(atStop);
  });
});

describe("LocalEvaluator", () => {
  it("returns one score per genome, in order", async () => {
    const registry = createDefaultRegistry();
    const problem = registry.create<FitnessProblem<unknown>>("problem", "one-max");
    const evaluator = new LocalEvaluator();
    const genomes = [
      [1, 1, 1, 1],
      [0, 0, 0, 0],
      [1, 0, 1, 0],
    ];
    const scores = await evaluator.evaluateBatch(genomes, {
      problem,
      generation: 0,
    });
    expect(scores).toEqual([4, 0, 2]);
  });

  it("surfaces a throwing problem as a rejection, not a synchronous throw", async () => {
    const evaluator = new LocalEvaluator();
    await expect(
      evaluator.evaluateBatch([1], {
        problem: {
          evaluate: () => {
            throw new Error("bad genome");
          },
        } as never,
        generation: 0,
      }),
    ).rejects.toThrow(/bad genome/);
  });
});
