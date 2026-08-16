import type { EvalJobPayload } from "@genebaer/shared-types";
// Subpath import on purpose: the package root re-exports the PNG encoder,
// which imports node:zlib and has no place in a browser bundle.
import { augmentedViews } from "@genebaer/vision/augment";

/**
 * In-browser CLIP scoring on WebGPU.
 *
 * transformers.js is loaded from a CDN at runtime rather than bundled. The npm
 * package plus onnxruntime is ~800MB installed, which would more than double
 * install time for every build and every CI run, to ship code only a tab that
 * opts into being a worker ever executes. Model weights stream from the Hub the
 * same way.
 *
 * The loader is injectable so the scoring logic is testable without a network,
 * a GPU, or 150MB of weights.
 */

const CDN = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0";
const MODEL_ID = "Xenova/clip-vit-base-patch32";

export interface ClipPipelines {
  RawImage: {
    new (data: Uint8ClampedArray, width: number, height: number, channels: number): unknown;
  };
  processor: (image: unknown) => Promise<unknown>;
  visionModel: (inputs: unknown) => Promise<{ image_embeds: { data: ArrayLike<number> } }>;
  tokenizer: (text: string[], opts: unknown) => unknown;
  textModel: (inputs: unknown) => Promise<{ text_embeds: { data: ArrayLike<number> } }>;
}

export type PipelineLoader = () => Promise<ClipPipelines>;

/** Cosine similarity. Zero vectors carry no information, so they score 0. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) {
    throw new Error(
      `Embedding sizes differ (${String(a.length)} vs ${String(b.length)}); the image and text models are not a matched pair.`,
    );
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] as number) * (b[i] as number);
    na += (a[i] as number) ** 2;
    nb += (b[i] as number) ** 2;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** RGB bytes from a job payload, as the RGBA-free buffer RawImage expects. */
export function payloadToPixels(job: EvalJobPayload): {
  data: Uint8ClampedArray;
  width: number;
  height: number;
} {
  const g = job.genome as { width?: number; height?: number; rgb?: number[] };
  if (
    typeof g?.width !== "number" ||
    typeof g?.height !== "number" ||
    !Array.isArray(g.rgb)
  ) {
    throw new TypeError("clip-similarity: job payload is not a rendered image");
  }
  if (g.rgb.length !== g.width * g.height * 3) {
    throw new RangeError(
      `Image payload has ${String(g.rgb.length)} bytes but declares ${String(g.width)}x${String(g.height)} RGB`,
    );
  }
  return {
    data: Uint8ClampedArray.from(g.rgb),
    width: g.width,
    height: g.height,
  };
}

/** Default loader: pull transformers.js from the CDN and prepare CLIP on WebGPU. */
export const loadFromCdn: PipelineLoader = async () => {
  const gpu = (navigator as { gpu?: unknown }).gpu;
  if (!gpu) {
    throw new Error(
      "This browser has no WebGPU, so it cannot score. Enable WebGPU, or run a server-side worker instead.",
    );
  }
  const t = (await import(/* webpackIgnore: true */ CDN)) as {
    RawImage: ClipPipelines["RawImage"];
    AutoProcessor: { from_pretrained: (id: string) => Promise<unknown> };
    AutoTokenizer: { from_pretrained: (id: string) => Promise<unknown> };
    CLIPVisionModelWithProjection: {
      from_pretrained: (id: string, o: unknown) => Promise<unknown>;
    };
    CLIPTextModelWithProjection: {
      from_pretrained: (id: string, o: unknown) => Promise<unknown>;
    };
  };
  const opts = { device: "webgpu" };
  const [processor, tokenizer, visionModel, textModel] = await Promise.all([
    t.AutoProcessor.from_pretrained(MODEL_ID),
    t.AutoTokenizer.from_pretrained(MODEL_ID),
    t.CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, opts),
    t.CLIPTextModelWithProjection.from_pretrained(MODEL_ID, opts),
  ]);
  return {
    RawImage: t.RawImage,
    processor: processor as ClipPipelines["processor"],
    tokenizer: tokenizer as ClipPipelines["tokenizer"],
    visionModel: visionModel as ClipPipelines["visionModel"],
    textModel: textModel as ClipPipelines["textModel"],
  };
};

/**
 * A scorer for the worker client.
 *
 * Loads the model once and reuses it, and caches the prompt embedding: it is
 * identical for every individual of every generation, so embedding per image
 * would multiply text-side cost by the population size for nothing.
 *
 * There is deliberately no fallback score. If the model cannot load, this
 * rejects — a stand-in number would look like the system working while
 * steering an entire run at something unrelated to the prompt.
 */
export function createClipScorer(load: PipelineLoader = loadFromCdn) {
  let pipelines: ClipPipelines | null = null;
  let loading: Promise<ClipPipelines> | null = null;
  const textCache = new Map<string, ArrayLike<number>>();

  const ready = async (): Promise<ClipPipelines> => {
    pipelines ??= await (loading ??= load());
    return pipelines;
  };

  return async function score(job: EvalJobPayload): Promise<number> {
    const p = await ready();
    const prompt = typeof job.params["prompt"] === "string" ? job.params["prompt"] : "";
    if (prompt.length === 0) {
      throw new Error(
        "clip-similarity: empty prompt. Scoring against nothing returns a meaningless number that still looks like fitness.",
      );
    }

    let text = textCache.get(prompt);
    if (!text) {
      const { text_embeds } = await p.textModel(
        p.tokenizer([prompt], { padding: true, truncation: true }),
      );
      text = text_embeds.data;
      textCache.set(prompt, text);
    }

    const { data, width, height } = payloadToPixels(job);

    // Mean similarity over N augmented views. Must match the server-side
    // scorer exactly — both call the same `augmentedViews` from @genebaer/vision
    // with the same pixel-derived seed, so a browser worker and a thread worker
    // return the same number for the same job. If they diverged, a run's
    // fitness would depend on which worker happened to claim the lease.
    const views = augmentedViews({ width, height, rgb: data }, augmentationsFor(job));
    let total = 0;
    for (const view of views) {
      const image = new p.RawImage(
        Uint8ClampedArray.from(view.rgb),
        view.width,
        view.height,
        3,
      );
      const { image_embeds } = await p.visionModel(await p.processor(image));
      total += cosine(image_embeds.data, text);
    }
    return total / views.length;
  };
}

/** Augmented view count from the job params, defaulting to no augmentation. */
export function augmentationsFor(job: EvalJobPayload): number {
  const raw = job.params["augmentations"];
  if (raw === undefined) return 1;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new RangeError(
      `clip-similarity: augmentations must be a positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}
