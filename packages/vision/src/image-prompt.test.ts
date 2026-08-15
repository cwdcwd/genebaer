import { createDefaultRegistry } from "@genebaer/core";
import { describe, expect, it } from "vitest";
import {
  BITS_PER_PIXEL,
  bitsToRgb,
  genomeLengthFor,
  rgbToBits,
} from "./image-genome.js";
import { ImagePrompt, encodingParamsFor } from "./image-prompt.js";

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
  it("registers as a problem and exposes a prompt param for the auto form", () => {
    const registry = createDefaultRegistry().register("problem", ImagePrompt);
    const meta = registry.listMetadata("problem").find((m) => m.id === "image-prompt");
    expect(meta).toBeDefined();
    expect(Object.keys(meta!.paramsSchema).sort()).toEqual(["height", "prompt", "width"]);
    expect(meta!.paramsSchema["prompt"]?.type).toBe("string");
    // Reuses the existing binary encoding — no new operators required.
    expect(meta!.compatibleEncodings).toEqual(["binary"]);
  });

  it("reports the genome length its configured size needs", () => {
    const problem = new ImagePrompt({ width: 16, height: 8 });
    expect(problem.genomeLength).toBe(16 * 8 * 24);
    expect(encodingParamsFor(problem.shape)).toEqual({ length: 16 * 8 * 24 });
  });

  it("refuses non-integer or non-positive dimensions", () => {
    expect(() => new ImagePrompt({ width: 0, height: 8 })).toThrow(/positive integers/);
    expect(() => new ImagePrompt({ width: 8.5, height: 8 })).toThrow(/positive integers/);
  });

  it("falls back to defaults for missing params", () => {
    const problem = new ImagePrompt();
    expect(problem.shape).toEqual({ width: 32, height: 32 });
    expect(problem.prompt).toBe("");
  });

  it("throws a directive error when scored in-process", () => {
    // Running under the default 'local' evaluator is a misconfiguration.
    // Inventing a number here would quietly steer an entire run.
    const problem = new ImagePrompt({ width: 8, height: 8 });
    expect(() => problem.evaluate([])).toThrow(/cannot be scored in-process/);
    expect(() => problem.evaluate([])).toThrow(/clip-similarity/);
  });

  it("renders a genome to raw RGB bytes of the right size", () => {
    const problem = new ImagePrompt({ width: 4, height: 4 });
    const genome = new Array<number>(problem.genomeLength).fill(1);
    const rgb = problem.render(genome);
    expect(rgb).toHaveLength(4 * 4 * 3);
    expect([...new Set(rgb)]).toEqual([255]);
  });

  it("produces a JSON-serialisable visual frame the canvas can draw", () => {
    const problem = new ImagePrompt({ width: 2, height: 2, prompt: "a cat" });
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
