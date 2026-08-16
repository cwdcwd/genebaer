import { describe, expect, it, vi } from "vitest";
import type { EvalJobPayload } from "@genebaer/shared-types";
import {
  cosine,
  createClipScorer,
  payloadToPixels,
  type ClipPipelines,
} from "./clip-browser";

function job(over: Partial<EvalJobPayload> = {}): EvalJobPayload {
  return {
    evaluationId: "e1",
    index: 0,
    genome: { width: 2, height: 2, channels: 3, rgb: new Array<number>(12).fill(200) },
    evaluatorId: "clip-similarity",
    params: { prompt: "a red circle" },
    ...over,
  };
}

/** A stand-in for transformers.js, so the logic is testable with no network. */
function fakePipelines(onText: () => void = () => undefined): ClipPipelines {
  return {
    RawImage: class {
      constructor(
        public data: Uint8ClampedArray,
        public width: number,
        public height: number,
        public channels: number,
      ) {}
    },
    processor: (image) => Promise.resolve(image),
    visionModel: () => Promise.resolve({ image_embeds: { data: [1, 0, 0] } }),
    tokenizer: (text) => text,
    textModel: () => {
      onText();
      return Promise.resolve({ text_embeds: { data: [1, 0, 0] } });
    },
  };
}

describe("cosine", () => {
  it("is 1 for identical directions and -1 for opposite", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("treats zero vectors as uninformative rather than identical", () => {
    expect(cosine([0, 0], [0, 0])).toBe(0);
  });

  it("refuses mismatched sizes rather than comparing nonsense", () => {
    expect(() => cosine([1, 2, 3], [1, 2])).toThrow(/not a matched pair/);
  });
});

describe("payloadToPixels", () => {
  it("extracts the rendered image the server prepared", () => {
    const { data, width, height } = payloadToPixels(job());
    expect(width).toBe(2);
    expect(height).toBe(2);
    expect(data).toHaveLength(12);
  });

  it("rejects a payload that is not a rendered image", () => {
    expect(() => payloadToPixels(job({ genome: [1, 0, 1] }))).toThrow(
      /not a rendered image/,
    );
  });

  it("rejects a byte count that contradicts the declared dimensions", () => {
    expect(() =>
      payloadToPixels(job({ genome: { width: 4, height: 4, rgb: [1, 2, 3] } })),
    ).toThrow(/declares 4x4/);
  });
});

describe("createClipScorer", () => {
  it("scores a job through the injected pipelines", async () => {
    const score = createClipScorer(() => Promise.resolve(fakePipelines()));
    await expect(score(job())).resolves.toBeCloseTo(1);
  });

  it("loads the model once across many jobs", async () => {
    const load = vi.fn(() => Promise.resolve(fakePipelines()));
    const score = createClipScorer(load);
    await score(job());
    await score(job({ index: 1 }));
    await score(job({ index: 2 }));
    // Model load is the expensive part; reloading per batch would dominate.
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("embeds each prompt once, not once per image", async () => {
    // The prompt is identical for every individual of every generation, so
    // embedding per image multiplies text cost by the population size.
    let textCalls = 0;
    const score = createClipScorer(() =>
      Promise.resolve(fakePipelines(() => (textCalls += 1))),
    );
    await score(job());
    await score(job({ index: 1 }));
    expect(textCalls).toBe(1);

    await score(job({ params: { prompt: "a blue square" } }));
    expect(textCalls).toBe(2);
  });

  it("refuses an empty prompt rather than returning a meaningless number", () => {
    const score = createClipScorer(() => Promise.resolve(fakePipelines()));
    return expect(score(job({ params: { prompt: "" } }))).rejects.toThrow(/empty prompt/);
  });

  it("propagates a model that cannot load, with no fallback score", async () => {
    // A stand-in number would look like the system working while steering the
    // run at something unrelated to the prompt.
    const score = createClipScorer(() =>
      Promise.reject(new Error("This browser has no WebGPU")),
    );
    await expect(score(job())).rejects.toThrow(/no WebGPU/);
  });
});
