import type { FitnessProblem } from "@genebaer/core";
import { ImagePrompt } from "@genebaer/vision";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobQueue } from "./job-queue.js";
import { setActiveQueue } from "./queued-evaluator.js";
import { MemoryScoreCache, setActiveScoreCache } from "./score-cache.js";
import { ClipSimilarityEvaluator, type ClipJobPayload } from "./clip-evaluator.js";
import {
  cosineSimilarity,
  scoreImageAgainstPrompt,
  setClipBackend,
  textCacheSize,
} from "./clip-backend.mjs";

afterEach(() => {
  setActiveQueue(null);
  setActiveScoreCache(null);
  setClipBackend(null);
});

function imageContext(width = 4, height = 4, prompt = "a red circle") {
  const problem = new ImagePrompt({ width, height, prompt });
  return { problem: problem as unknown as FitnessProblem<unknown>, generation: 0 };
}

function whiteGenome(problem: ImagePrompt): number[] {
  return new Array<number>(problem.genomeLength).fill(1);
}

describe("ClipSimilarityEvaluator identity", () => {
  it("ties its version to the model, since scores across models are incomparable", () => {
    const evaluator = new ClipSimilarityEvaluator();
    expect(evaluator.contract).toBe("clip-similarity");
    expect(evaluator.version).toMatch(/clip-vit-base-patch32/);
    expect(evaluator.identity).toBe(`clip-similarity@${evaluator.version}`);
  });
});

describe("preparing jobs", () => {
  it("renders the genome to pixels once, server-side", async () => {
    // Workers should only ever know about pixels, never bit packing.
    const queue = new JobQueue();
    setActiveQueue(queue);
    const ctx = imageContext(2, 2);
    const problem = ctx.problem as unknown as ImagePrompt;
    const evaluator = new ClipSimilarityEvaluator();

    const pending = evaluator.evaluateBatch([whiteGenome(problem)], ctx);
    const jobs = queue.claim([`clip-similarity@${evaluator.version}`], 10);

    expect(jobs).toHaveLength(1);
    const payload = jobs[0]!.genome as ClipJobPayload;
    expect(payload.width).toBe(2);
    expect(payload.height).toBe(2);
    expect(payload.channels).toBe(3);
    expect(payload.rgb).toHaveLength(2 * 2 * 3);
    expect([...new Set(payload.rgb)]).toEqual([255]);
    // Must survive a thread boundary or a socket.
    expect(() => JSON.stringify(payload)).not.toThrow();

    queue.submitScore(jobs[0]!.evaluationId, 0, 0.2);
    await expect(pending).resolves.toEqual([0.2]);
  });

  it("ships the problem's prompt to the worker", async () => {
    const queue = new JobQueue();
    setActiveQueue(queue);
    const ctx = imageContext(2, 2, "a blue square");
    const problem = ctx.problem as unknown as ImagePrompt;
    const evaluator = new ClipSimilarityEvaluator();

    const pending = evaluator.evaluateBatch([whiteGenome(problem)], ctx);
    const jobs = queue.claim([`clip-similarity@${evaluator.version}`], 10);
    expect(jobs[0]!.params["prompt"]).toBe("a blue square");

    queue.submitScore(jobs[0]!.evaluationId, 0, 0.1);
    await pending;
  });

  it("lets an evaluator param override the problem's prompt", () => {
    const ctx = imageContext(2, 2, "from the problem");
    const evaluator = new ClipSimilarityEvaluator({ prompt: "from the evaluator" });
    expect(evaluator.promptFor(ctx)).toBe("from the evaluator");
    expect(new ClipSimilarityEvaluator().promptFor(ctx)).toBe("from the problem");
  });

  it("refuses a problem that is not image-shaped", async () => {
    // A CLIP evaluator on a numeric optimisation problem is a
    // misconfiguration; scoring something meaningless would be worse.
    const queue = new JobQueue();
    setActiveQueue(queue);
    const evaluator = new ClipSimilarityEvaluator();
    await expect(
      evaluator.evaluateBatch([[1, 0]], {
        problem: { evaluate: () => 0 } as unknown as FitnessProblem<unknown>,
        generation: 0,
      }),
    ).rejects.toThrow(/not an image problem/);
  });

  it("keys the cache on the prompt, so two prompts never share a score", async () => {
    const queue = new JobQueue();
    const cache = new MemoryScoreCache();
    setActiveQueue(queue);
    setActiveScoreCache(cache);
    const evaluator = new ClipSimilarityEvaluator();

    const serve = setInterval(() => {
      for (const job of queue.claim([`clip-similarity@${evaluator.version}`], 10)) {
        queue.submitScore(job.evaluationId, job.index, 0.5);
      }
    }, 1);

    const catCtx = imageContext(2, 2, "a cat");
    const dogCtx = imageContext(2, 2, "a dog");
    const genome = whiteGenome(catCtx.problem as unknown as ImagePrompt);

    await evaluator.evaluateBatch([genome], catCtx);
    const hitsAfterCat = cache.stats().hits;
    await evaluator.evaluateBatch([genome], dogCtx);
    clearInterval(serve);

    // Same image, different prompt: must be a miss, not a reused score.
    expect(cache.stats().hits).toBe(hitsAfterCat);
    expect(cache.size()).toBe(2);
  });
});

describe("CLIP backend", () => {
  it("computes cosine similarity, and treats zero vectors as uninformative", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    // Not "perfectly similar" — they carry no information at all.
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  it("refuses mismatched embedding sizes rather than comparing nonsense", () => {
    expect(() => cosineSimilarity([1, 2, 3], [1, 2])).toThrow(/different sizes/);
  });

  it("embeds each prompt once, not once per image", async () => {
    // The prompt embedding is identical for every individual of every
    // generation; embedding per image multiplies text cost by population size.
    let textCalls = 0;
    setClipBackend({
      embedImage: ({ rgb }) => Promise.resolve(Float32Array.from([rgb.length, 1])),
      embedText: (text: string) => {
        textCalls += 1;
        return Promise.resolve(Float32Array.from([text.length, 1]));
      },
    });

    const payload = { width: 1, height: 1, rgb: [1, 2, 3] };
    await scoreImageAgainstPrompt(payload, "a cat");
    await scoreImageAgainstPrompt(payload, "a cat");
    await scoreImageAgainstPrompt(payload, "a cat");

    expect(textCalls).toBe(1);
    expect(textCacheSize()).toBe(1);
  });

  it("returns a real similarity from the injected backend", async () => {
    setClipBackend({
      embedImage: () => Promise.resolve(Float32Array.from([1, 0, 0])),
      embedText: () => Promise.resolve(Float32Array.from([1, 0, 0])),
    });
    const score = await scoreImageAgainstPrompt(
      { width: 1, height: 1, rgb: [0, 0, 0] },
      "anything",
    );
    expect(score).toBeCloseTo(1);
  });

  it("fails loudly when no model is available, rather than substituting a signal", async () => {
    // A stand-in metric would look like it was working while steering the run
    // toward something unrelated to the prompt, and no gate would notice.
    //
    // The module is mocked as unavailable rather than merely left uninstalled.
    // Without that, this test only asserted anything on a machine that happens
    // to lack the optional dependency: install it — as any real CLIP worker
    // must — and the test instead downloaded 150MB of weights and passed for
    // the wrong reason.
    vi.doMock("@huggingface/transformers", () => {
      throw new Error("Cannot find package '@huggingface/transformers'");
    });
    vi.resetModules();
    const fresh = await import("./clip-backend.mjs");
    fresh.setClipBackend(null);
    await expect(
      fresh.scoreImageAgainstPrompt({ width: 1, height: 1, rgb: [0, 0, 0] }, "a cat"),
    ).rejects.toThrow(/@huggingface\/transformers|not installed/);
    vi.doUnmock("@huggingface/transformers");
    vi.resetModules();
  });
});

describe("augmented scoring", () => {
  /** A backend whose image embedding depends on the pixels it is given. */
  function countingBackend() {
    const seen: number[][] = [];
    return {
      seen,
      backend: {
        embedImage: ({ rgb }: { rgb: readonly number[] | Uint8Array | Uint8ClampedArray }) => {
          seen.push([...rgb]);
          // Embed the mean brightness, so a crop of a non-uniform image
          // genuinely embeds differently from the original.
          let sum = 0;
          for (const v of rgb) sum += v;
          return Promise.resolve(Float32Array.from([sum / rgb.length, 1]));
        },
        embedText: () => Promise.resolve(Float32Array.from([120, 1])),
      },
    };
  }

  /** Half black, half white — so a crop shifts the mean. */
  function halfImage(width = 8, height = 8) {
    const rgb = new Array<number>(width * height * 3).fill(0);
    for (let i = 0; i < rgb.length / 2; i++) rgb[i] = 255;
    return { width, height, channels: 3 as const, rgb };
  }

  it("defaults to one view, leaving existing runs measuring exactly what they did", () => {
    const evaluator = new ClipSimilarityEvaluator();
    expect(evaluator.augmentations).toBe(1);
  });

  it("embeds N views and returns their mean", async () => {
    const { seen, backend } = countingBackend();
    setClipBackend(backend);
    const image = halfImage();

    const single = await scoreImageAgainstPrompt(image, "a red circle", 1);
    expect(seen).toHaveLength(1);

    seen.length = 0;
    const averaged = await scoreImageAgainstPrompt(image, "a red circle", 8);
    expect(seen).toHaveLength(8);
    // The unmodified image is always the first view.
    expect(seen[0]).toEqual(image.rgb);
    // Crops of a half-black image differ, so the mean must move.
    expect(averaged).not.toBe(single);
  });

  it("scores a given image identically every time", async () => {
    // Fitness must stay a function of the genome. Fresh randomness per call
    // would make an individual re-score differently and let elitism carry a
    // score its genome cannot reproduce.
    const { backend } = countingBackend();
    setClipBackend(backend);
    const image = halfImage();
    const a = await scoreImageAgainstPrompt(image, "a red circle", 8);
    const b = await scoreImageAgainstPrompt(image, "a red circle", 8);
    expect(a).toBe(b);
  });

  it("does not re-embed the prompt per view", async () => {
    // N augmentations must cost N image embeddings, not N text ones too.
    const { backend } = countingBackend();
    setClipBackend(backend);
    await scoreImageAgainstPrompt(halfImage(), "a red circle", 8);
    expect(textCacheSize()).toBe(1);
  });

  it("puts the view count in the job params, so the cache cannot cross-serve", () => {
    // A run at N=8 must never be handed a number measured at N=1.
    const queue = new JobQueue();
    setActiveQueue(queue);
    const ctx = imageContext(4, 4);
    const problem = ctx.problem as unknown as ImagePrompt;
    const evaluator = new ClipSimilarityEvaluator({ augmentations: 8 });

    void evaluator.evaluateBatch([whiteGenome(problem)], ctx);
    const jobs = queue.claim([`clip-similarity@${evaluator.version}`], 10);
    expect(jobs[0]?.params["augmentations"]).toBe(8);
  });

  it("bumps the version, because an old worker would ignore the param", () => {
    // The cache keys on params, so N=1 and N=8 could never collide there. The
    // real hazard is a worker running older code: it does not know the param
    // exists and would return a single aligned score for a run that believes
    // it is averaging eight views.
    expect(new ClipSimilarityEvaluator().version).toBe("clip-vit-base-patch32.2");
  });

  it("rejects a bad count when the run is configured, not once per genome", () => {
    expect(() => new ClipSimilarityEvaluator({ augmentations: 0 }).augmentations).toThrow(
      /positive integer/,
    );
    expect(() => new ClipSimilarityEvaluator({ augmentations: 2.5 }).augmentations).toThrow(
      /positive integer/,
    );
  });
});

describe("advertising the contract to remote workers", () => {
  it("publishes the evaluator's version in registry metadata", async () => {
    // genebaer-vnb: the browser worker used to hardcode this string, so a bump
    // here left it registering with a version the registry would never match —
    // accepted, then never offered a job, with no error anywhere. Publishing
    // the version is what lets a remote worker follow the server instead.
    const { createDefaultRegistry } = await import("@genebaer/core");
    const registry = createDefaultRegistry().register(
      "evaluator",
      ClipSimilarityEvaluator,
    );
    const meta = registry
      .listMetadata("evaluator")
      .find((m) => m.id === "clip-similarity");

    expect(meta?.version).toBe(new ClipSimilarityEvaluator().version);
    expect(meta?.version).toBeTruthy();
  });

  it("leaves version off operators that have no contract version", async () => {
    // Only evaluators carry one; putting a stray version on a mutation operator
    // would imply a compatibility rule that does not exist.
    const { createDefaultRegistry } = await import("@genebaer/core");
    const registry = createDefaultRegistry();
    for (const meta of registry.listMetadata("mutation")) {
      expect(meta.version).toBeUndefined();
    }
  });
});
