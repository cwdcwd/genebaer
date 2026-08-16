import { createDefaultRegistry } from "@genebaer/core";
import { describe, expect, it } from "vitest";
import {
  BITS_PER_PIXEL,
  bitsToRgb,
  genomeLengthFor,
  rgbToBits,
} from "./image-genome.js";
import {
  ImagePrompt,
  MIN_PIXELS_PER_POLYGON,
  encodingParamsFor,
  polygonEncodingParams,
} from "./image-prompt.js";

describe("bit-string <-> RGB", () => {
  it("needs exactly width * height * 24 bits", () => {
    expect(genomeLengthFor({ width: 32, height: 32 })).toBe(32 * 32 * 24);
    expect(genomeLengthFor({ width: 64, height: 64 })).toBe(98_304);
  });

  it("packs bits most-significant-first so rendering is stable", () => {
    // One pixel: R=255 (11111111), G=0, B=170 (10101010)
    const bits = [
      1, 1, 1, 1, 1, 1, 1, 1,
      0, 0, 0, 0, 0, 0, 0, 0,
      1, 0, 1, 0, 1, 0, 1, 0,
    ];
    expect([...bitsToRgb(bits, { width: 1, height: 1 })]).toEqual([255, 0, 170]);
  });

  it("round-trips bytes through bits unchanged", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 254, 255]);
    expect([...bitsToRgb(rgbToBits(bytes), { width: 2, height: 1 })]).toEqual([
      ...bytes,
    ]);
  });

  it("treats any truthy gene as a set bit", () => {
    // A mutation operator is free to hand back something other than 0/1.
    const bits = new Array<number>(BITS_PER_PIXEL).fill(0);
    bits[0] = 1;
    expect(bitsToRgb(bits, { width: 1, height: 1 })[0]).toBe(128);
  });

  it("rejects a length mismatch instead of rendering garbage", () => {
    // Silently rendering a wrong-sized genome would produce a garbled image
    // and a meaningless score, with nothing anywhere reporting a problem.
    expect(() => bitsToRgb([1, 0, 1], { width: 4, height: 4 })).toThrow(
      /needs exactly 384/,
    );
  });
});

describe("ImagePrompt operator", () => {
  it("registers as a problem and exposes its params for the auto form", () => {
    const registry = createDefaultRegistry().register("problem", ImagePrompt);
    const meta = registry.listMetadata("problem").find((m) => m.id === "image-prompt");
    expect(meta).toBeDefined();
    expect(Object.keys(meta!.paramsSchema).sort()).toEqual([
      "height",
      "polygons",
      "prompt",
      "representation",
      "width",
    ]);
    expect(meta!.paramsSchema["prompt"]?.type).toBe("string");
    // The form must offer the choice, or the constrained representation is
    // unreachable from the UI and this whole change is theoretical.
    const rep = meta!.paramsSchema["representation"];
    expect(rep?.type === "string" && rep.enum).toEqual(["polygons", "bits"]);
    // Both representations reuse existing encodings — no new operators.
    expect(meta!.compatibleEncodings).toEqual(["numeric", "binary"]);
  });

  it("reports the genome length its configured size needs under bits", () => {
    const problem = new ImagePrompt({ representation: "bits", width: 16, height: 8 });
    expect(problem.genomeLength).toBe(16 * 8 * 24);
    expect(encodingParamsFor(problem.shape)).toEqual({ length: 16 * 8 * 24 });
  });

  it("sizes a polygon genome by polygon count, not by canvas", () => {
    const small = new ImagePrompt({ width: 16, height: 16, polygons: 10 });
    const large = new ImagePrompt({ width: 256, height: 256, polygons: 10 });
    // The decisive property: raster size no longer drives search difficulty.
    expect(small.genomeLength).toBe(100);
    expect(large.genomeLength).toBe(100);
    expect(polygonEncodingParams(10)).toEqual({ dimensions: 100, min: 0, max: 1 });
  });

  it("refuses non-integer or non-positive dimensions", () => {
    expect(() => new ImagePrompt({ width: 0, height: 8 })).toThrow(/positive integers/);
    expect(() => new ImagePrompt({ width: 8.5, height: 8 })).toThrow(/positive integers/);
  });

  it("refuses an unknown representation rather than quietly picking one", () => {
    // A silent fallback would report a genome length for a representation the
    // caller did not ask for; the mismatch would surface much later as a
    // confusing encoding error.
    expect(() => new ImagePrompt({ representation: "svg" })).toThrow(
      /must be 'polygons' or 'bits'/,
    );
    expect(() => new ImagePrompt({ polygons: 0 })).toThrow(/positive integer/);
  });

  it("defaults to the constrained representation, in its constrained regime", () => {
    const problem = new ImagePrompt();
    expect(problem.representation).toBe("polygons");
    expect(problem.shape).toEqual({ width: 64, height: 64 });
    expect(problem.prompt).toBe("");
    // The guard that caught a bad default: polygons alone do not constrain
    // anything if there are enough of them to paint pixels.
    expect(problem.pixelsPerPolygon).toBeGreaterThanOrEqual(MIN_PIXELS_PER_POLYGON);
    expect(problem.constraintIsWeak).toBe(false);
  });

  it("reports a dense configuration as weak instead of pretending it is safe", () => {
    // A caller may legitimately want a detailed image and accept the exposure.
    // Claiming the constraint holds when it does not is the failure worth
    // avoiding.
    const dense = new ImagePrompt({ width: 32, height: 32, polygons: 48 });
    expect(dense.pixelsPerPolygon).toBeCloseTo(21.3, 1);
    expect(dense.constraintIsWeak).toBe(true);
    // Bits are unconstrained by construction, so the ratio does not apply.
    expect(new ImagePrompt({ representation: "bits" }).constraintIsWeak).toBe(false);
  });

  it("throws a directive error when scored in-process", () => {
    // Running under the default 'local' evaluator is a misconfiguration.
    // Inventing a number here would quietly steer an entire run.
    const problem = new ImagePrompt({ width: 8, height: 8 });
    expect(() => problem.evaluate([])).toThrow(/cannot be scored in-process/);
    expect(() => problem.evaluate([])).toThrow(/clip-similarity/);
  });

  it("renders a bits genome to raw RGB bytes of the right size", () => {
    const problem = new ImagePrompt({ representation: "bits", width: 4, height: 4 });
    const genome = new Array<number>(problem.genomeLength).fill(1);
    const rgb = problem.render(genome);
    expect(rgb).toHaveLength(4 * 4 * 3);
    expect([...new Set(rgb)]).toEqual([255]);
  });

  it("renders a polygon genome at the canvas size, not the genome size", () => {
    const problem = new ImagePrompt({ width: 8, height: 4, polygons: 2 });
    const rgb = problem.render(new Array<number>(problem.genomeLength).fill(0.5));
    expect(rgb).toHaveLength(8 * 4 * 3);
  });

  it("rejects a wrong-sized polygon genome as loudly as a wrong-sized bit one", () => {
    // The rasteriser tolerates any length by design — it reads whole polygons
    // and drops a ragged tail. Left unchecked here, an encoding configured with
    // the wrong dimensions would render a partial image and score it, and
    // nothing would report a problem. Bits already throw; these must match.
    const problem = new ImagePrompt({ width: 8, height: 8, polygons: 4 });
    expect(() => problem.render(new Array<number>(30).fill(0.5))).toThrow(
      /needs exactly 40 genes, got 30/,
    );
    expect(() =>
      new ImagePrompt({ representation: "bits", width: 8, height: 8 }).render([1, 0]),
    ).toThrow();
  });

  it("produces a JSON-serialisable visual frame the canvas can draw", () => {
    const problem = new ImagePrompt({
      representation: "bits",
      width: 2,
      height: 2,
      prompt: "a cat",
    });
    const genome = new Array<number>(problem.genomeLength).fill(0);
    const frame = problem.visualize(genome);

    expect(frame?.problemId).toBe("image-prompt");
    const data = frame?.data as {
      width: number;
      height: number;
      channels: number;
      prompt: string;
      rgb: number[];
    };
    expect(data.width).toBe(2);
    expect(data.height).toBe(2);
    expect(data.channels).toBe(3);
    expect(data.prompt).toBe("a cat");
    expect(data.rgb).toHaveLength(12);
    // Must survive the WS channel.
    expect(() => JSON.stringify(frame)).not.toThrow();
  });

  it("returns no frame for a genome of the wrong size, rather than throwing", () => {
    // visualize() runs on every generation; a wrong-sized genome should degrade
    // the preview, not kill the run.
    const problem = new ImagePrompt({ width: 4, height: 4 });
    expect(problem.visualize([1, 0, 1])).toBeNull();
  });
});

describe("declaring its genome length to the UI", () => {
  it("reports the required length under both representations", () => {
    // genebaer-7tu: the new-run form sizes the encoding from this. It must be
    // right for polygons (set by polygon count) and for bits (set by canvas),
    // because those are set by completely different params.
    const polygons = new ImagePrompt({ width: 64, height: 64, polygons: 24 });
    expect(polygons.requiredGenomeLength).toBe(240);
    expect(polygons.requiredGenomeLength).toBe(polygons.genomeLength);

    const bits = new ImagePrompt({ representation: "bits", width: 16, height: 8 });
    expect(bits.requiredGenomeLength).toBe(16 * 8 * 24);
    expect(bits.requiredGenomeLength).toBe(bits.genomeLength);
  });

  it("tracks the param that actually drives each representation", () => {
    // Under polygons, canvas size must NOT change the genome length; under
    // bits it must. Getting these the wrong way round would size every image
    // run incorrectly while still looking plausible.
    const a = new ImagePrompt({ width: 32, height: 32, polygons: 10 });
    const b = new ImagePrompt({ width: 128, height: 128, polygons: 10 });
    expect(a.requiredGenomeLength).toBe(b.requiredGenomeLength);

    const small = new ImagePrompt({ representation: "bits", width: 8, height: 8 });
    const large = new ImagePrompt({ representation: "bits", width: 16, height: 16 });
    expect(large.requiredGenomeLength).toBeGreaterThan(small.requiredGenomeLength);
  });
});
