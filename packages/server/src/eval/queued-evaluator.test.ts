import {
  GeneticAlgorithmEngine,
  createDefaultRegistry,
  type FitnessProblem,
  type RunConfig,
} from "@genebaer/core";
import { afterEach, describe, expect, it } from "vitest";
import { JobQueue } from "./job-queue.js";
import { QueuedEvaluator, setActiveQueue } from "./queued-evaluator.js";

/** A concrete queued evaluator; its operatorId IS the scoring contract. */
class TestQueuedEvaluator extends QueuedEvaluator {
  static override readonly operatorId = "test-contract";
  static override readonly displayName = "Test contract";
  static override readonly description = "Queued evaluator used in tests.";
  static override readonly paramsSchema = {} as const;
}

function config(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    problem: { id: "one-max" },
    encoding: { id: "binary", params: { length: 8 } },
    selection: { id: "tournament" },
    crossover: { id: "one-point" },
    mutation: { id: "bit-flip" },
    mutationRate: 0.05,
    populationSize: 6,
    elitism: 1,
    termination: [{ id: "max-generations", params: { maxGenerations: 2 } }],
    seed: 3,
    evaluator: { id: "test-contract" },
    ...overrides,
  };
}

afterEach(() => setActiveQueue(null));

describe("QueuedEvaluator", () => {
  it("uses its own operatorId as the contract workers match on", () => {
    const evaluator = new TestQueuedEvaluator();
    expect(evaluator.contract).toBe("test-contract");
  });

  it("rejects with a clear error when no queue is active", async () => {
    setActiveQueue(null);
    const evaluator = new TestQueuedEvaluator();
    await expect(
      evaluator.evaluateBatch([1, 2], {
        problem: {} as FitnessProblem<unknown>,
        generation: 0,
      }),
    ).rejects.toThrow(/needs a job queue/i);
  });

  it("drives a real engine generation end to end through the queue", async () => {
    const queue = new JobQueue();
    setActiveQueue(queue);
    const registry = createDefaultRegistry().register("evaluator", TestQueuedEvaluator);
    const problem = registry.create<FitnessProblem<unknown>>("problem", "one-max");

    const engine = new GeneticAlgorithmEngine<number[]>(config(), registry);

    // Stand in for a worker: drain the queue and score with the real problem.
    const worker = setInterval(() => {
      for (const job of queue.claim(["test-contract@1"], 4)) {
        queue.submitScore(job.evaluationId, job.index, problem.evaluate(job.genome));
      }
    }, 1);

    const stats: number[] = [];
    engine.on("generation", (s) => stats.push(s.bestFitness));
    await new Promise<void>((resolve, reject) => {
      engine.on("finished", () => resolve());
      engine.on("error", (e) => reject(e));
      setTimeout(() => reject(new Error("run hung on the queue")), 5000);
      engine.start();
    });
    clearInterval(worker);

    expect(stats.length).toBeGreaterThan(0);
    // one-max on an 8-bit genome: fitness is a bit count, so bounded by 8.
    expect(stats.every((f) => f >= 0 && f <= 8)).toBe(true);
    expect(queue.stats()).toEqual({ pending: 0, openEvaluations: 0, activeLeases: 0, expiredLeases: 0 });
  });

  it("surfaces a failed evaluation as an engine error rather than hanging", async () => {
    const queue = new JobQueue();
    setActiveQueue(queue);
    const registry = createDefaultRegistry().register("evaluator", TestQueuedEvaluator);
    const engine = new GeneticAlgorithmEngine<number[]>(config(), registry);

    const worker = setInterval(() => {
      const jobs = queue.claim(["test-contract@1"], 1);
      if (jobs.length > 0) {
        queue.failEvaluation(jobs[0]!.evaluationId, new Error("worker cannot score this"));
      }
    }, 1);

    const err = await new Promise<Error>((resolve, reject) => {
      engine.on("error", (e) => resolve(e));
      setTimeout(() => reject(new Error("engine hung instead of erroring")), 5000);
      engine.start();
    });
    clearInterval(worker);

    expect(err.message).toMatch(/cannot score/);
    expect(engine.status).toBe("error");
  });

  it("scores the whole generation in one submission, one job per genome", async () => {
    const queue = new JobQueue();
    setActiveQueue(queue);
    const evaluator = new TestQueuedEvaluator();
    const pending = evaluator.evaluateBatch(["a", "b", "c"], {
      problem: {} as FitnessProblem<unknown>,
      generation: 0,
    });

    expect(queue.stats()).toEqual({ pending: 3, openEvaluations: 1, activeLeases: 0, expiredLeases: 0 });
    const jobs = queue.claim(["test-contract@1"], 10);
    expect(jobs.map((j) => j.index).sort()).toEqual([0, 1, 2]);
    for (const job of jobs) queue.submitScore(job.evaluationId, job.index, job.index);
    await expect(pending).resolves.toEqual([0, 1, 2]);
  });
});
