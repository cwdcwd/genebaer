import { afterEach, describe, expect, it } from "vitest";
import { JobQueue } from "./job-queue.js";
import { QueuedEvaluator, setActiveQueue } from "./queued-evaluator.js";
import {
  MemoryScoreCache,
  scoreKey,
  setActiveScoreCache,
} from "./score-cache.js";
import type { FitnessProblem } from "@genebaer/core";

class ClipV1 extends QueuedEvaluator {
  static override readonly operatorId = "clip";
  static override readonly version = "1";
  static override readonly displayName = "CLIP v1";
  static override readonly description = "Test evaluator.";
  static override readonly paramsSchema = {} as const;
}

class ClipV2 extends QueuedEvaluator {
  static override readonly operatorId = "clip";
  static override readonly version = "2";
  static override readonly displayName = "CLIP v2";
  static override readonly description = "Test evaluator, newer model.";
  static override readonly paramsSchema = {} as const;
}

const ctx = { problem: {} as FitnessProblem<unknown>, generation: 0 };

afterEach(() => {
  setActiveQueue(null);
  setActiveScoreCache(null);
});

/** Drain the queue, scoring each genome with the given function. */
function serve(queue: JobQueue, score: (genome: unknown) => number): () => void {
  const timer = setInterval(() => {
    for (const job of queue.claim(["clip@1", "clip@2"], 100)) {
      queue.submitScore(job.evaluationId, job.index, score(job.genome));
    }
  }, 1);
  return () => clearInterval(timer);
}

describe("scoreKey", () => {
  it("separates the same genome under different evaluator versions", () => {
    // The poisoning case: a v1 score served to a v2 run would be a number
    // measuring something else entirely.
    expect(scoreKey("clip", "1", {}, [1, 0])).not.toBe(scoreKey("clip", "2", {}, [1, 0]));
  });

  it("separates the same genome under different params", () => {
    expect(scoreKey("clip", "1", { prompt: "a cat" }, [1])).not.toBe(
      scoreKey("clip", "1", { prompt: "a dog" }, [1]),
    );
  });

  it("is stable across param key ordering", () => {
    // The same configuration written two ways must not miss itself.
    expect(scoreKey("clip", "1", { a: 1, b: 2 }, [1])).toBe(
      scoreKey("clip", "1", { b: 2, a: 1 }, [1]),
    );
  });

  it("is stable for equal genomes and different for unequal ones", () => {
    expect(scoreKey("clip", "1", {}, [1, 0, 1])).toBe(scoreKey("clip", "1", {}, [1, 0, 1]));
    expect(scoreKey("clip", "1", {}, [1, 0, 1])).not.toBe(
      scoreKey("clip", "1", {}, [1, 1, 1]),
    );
  });
});

describe("cache-aware evaluation", () => {
  it("enqueues only misses on a second identical batch", async () => {
    const queue = new JobQueue();
    const cache = new MemoryScoreCache();
    setActiveQueue(queue);
    setActiveScoreCache(cache);
    const evaluator = new ClipV1();

    let scored = 0;
    const stop = serve(queue, (g) => {
      scored += 1;
      return (g as number[])[0] as number;
    });

    await expect(evaluator.evaluateBatch([[1], [2], [3]], ctx)).resolves.toEqual([1, 2, 3]);
    expect(scored).toBe(3);

    // Same population again: every genome is a hit, nothing is enqueued.
    await expect(evaluator.evaluateBatch([[1], [2], [3]], ctx)).resolves.toEqual([1, 2, 3]);
    expect(scored).toBe(3);
    stop();

    expect(cache.stats().hits).toBe(3);
  });

  it("scores a repeated genome once per batch and fans the result out", async () => {
    const queue = new JobQueue();
    const cache = new MemoryScoreCache();
    setActiveQueue(queue);
    setActiveScoreCache(cache);
    const evaluator = new ClipV1();

    let scored = 0;
    const stop = serve(queue, (g) => {
      scored += 1;
      return (g as number[])[0] as number;
    });

    // Elitism produces exactly this shape: duplicates inside one generation.
    const out = await evaluator.evaluateBatch([[5], [5], [7], [5]], ctx);
    stop();

    expect(out).toEqual([5, 5, 7, 5]);
    expect(scored).toBe(2); // two distinct genomes, not four
    expect(cache.stats().dedupedInBatch).toBe(2);
  });

  it("keeps elites free after the first generation", async () => {
    const queue = new JobQueue();
    const cache = new MemoryScoreCache();
    setActiveQueue(queue);
    setActiveScoreCache(cache);
    const evaluator = new ClipV1();

    let scored = 0;
    const stop = serve(queue, (g) => {
      scored += 1;
      return (g as number[])[0] as number;
    });

    await evaluator.evaluateBatch([[1], [2], [3]], ctx);
    expect(scored).toBe(3);
    // Next generation carries two elites forward and introduces two new genomes.
    await evaluator.evaluateBatch([[1], [2], [8], [9]], ctx);
    stop();

    expect(scored).toBe(5); // only the 2 new genomes cost anything
  });

  it("never serves a v1 score to a v2 run", async () => {
    const queue = new JobQueue();
    const cache = new MemoryScoreCache();
    setActiveQueue(queue);
    setActiveScoreCache(cache);

    const stop = serve(queue, (g) => ((g as number[])[0] as number) * 10);
    await new ClipV1().evaluateBatch([[1]], ctx);
    // Same genome, newer model: must be re-scored, not served from cache.
    const before = cache.stats().hits;
    await new ClipV2().evaluateBatch([[1]], ctx);
    stop();

    expect(cache.stats().hits).toBe(before);
    expect(cache.size()).toBe(2);
  });

  it("never lets two prompts share a cache entry", async () => {
    const queue = new JobQueue();
    const cache = new MemoryScoreCache();
    setActiveQueue(queue);
    setActiveScoreCache(cache);

    class Prompted extends QueuedEvaluator {
      static override readonly operatorId = "clip";
      static override readonly version = "1";
      static override readonly displayName = "p";
      static override readonly description = "p";
      static override readonly paramsSchema = {} as const;
    }

    const stop = serve(queue, () => 1);
    const cat = new Prompted({ prompt: "a cat" });
    const dog = new Prompted({ prompt: "a dog" });
    await cat.evaluateBatch([[1]], ctx);
    const hitsAfterCat = cache.stats().hits;
    await dog.evaluateBatch([[1]], ctx);
    stop();

    expect(cache.stats().hits).toBe(hitsAfterCat);
    expect(cache.size()).toBe(2);
  });

  it("replays a whole run from cache with zero jobs enqueued", async () => {
    // The reproducibility story: inference is not deterministic, but a replay
    // that hits cache for every genome produces identical fitness values.
    const queue = new JobQueue();
    const cache = new MemoryScoreCache();
    setActiveQueue(queue);
    setActiveScoreCache(cache);
    const evaluator = new ClipV1();

    // A non-deterministic scorer: a second real evaluation would differ.
    let n = 0;
    const stop = serve(queue, () => {
      n += 1;
      return n;
    });
    const first = await evaluator.evaluateBatch([[1], [2]], ctx);
    stop();

    const replay = await evaluator.evaluateBatch([[1], [2]], ctx);
    expect(replay).toEqual(first);
    expect(queue.stats().pending).toBe(0);
  });

  it("falls back to the queue untouched when no cache is active", async () => {
    const queue = new JobQueue();
    setActiveQueue(queue);
    setActiveScoreCache(null);
    const stop = serve(queue, () => 42);
    await expect(new ClipV1().evaluateBatch([[1], [2]], ctx)).resolves.toEqual([42, 42]);
    stop();
  });
});
