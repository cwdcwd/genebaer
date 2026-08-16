import { describe, expect, it } from "vitest";
import { bitsToRgb, genomeLengthFor } from "./image-genome.js";
import {
  GENES_PER_POLYGON,
  decodePolygons,
  polygonGenomeLength,
  renderPolygons,
} from "./polygons.js";

const SHAPE = { width: 16, height: 16 };

/** One polygon's genes: three points, then r, g, b, a. */
function tri(
  pts: [number, number, number, number, number, number],
  rgba: [number, number, number, number],
): number[] {
  return [...pts, ...rgba];
}

/** The pixel at (x, y) as [r, g, b]. */
function px(rgb: Uint8Array, x: number, y: number, w = SHAPE.width): number[] {
  const i = (y * w + x) * 3;
  return [rgb[i] as number, rgb[i + 1] as number, rgb[i + 2] as number];
}

describe("genome layout", () => {
  it("reserves ten genes per polygon", () => {
    expect(polygonGenomeLength(48)).toBe(480);
    expect(GENES_PER_POLYGON).toBe(10);
  });

  it("reads whole polygons only, ignoring a ragged tail", () => {
    // A crossover point mid-polygon must not fabricate a shape from leftovers.
    const genome = [...tri([0, 0, 1, 0, 0, 1], [1, 0, 0, 1]), 0.5, 0.5];
    expect(decodePolygons(genome, SHAPE)).toHaveLength(1);
  });

  it("scales coordinates to the canvas and colours to bytes", () => {
    const [t] = decodePolygons(tri([0, 0, 1, 0.5, 0.25, 1], [1, 0, 0.5, 0]), SHAPE);
    expect(t?.xs).toEqual([0, 16, 4]);
    expect(t?.ys).toEqual([0, 8, 16]);
    expect(t?.r).toBe(255);
    expect(t?.g).toBe(0);
    expect(t?.b).toBe(127.5);
  });

  it("floors alpha above zero so no polygon is a gene selection cannot see", () => {
    const [t] = decodePolygons(tri([0, 0, 1, 0, 0, 1], [0, 0, 0, 0]), SHAPE);
    expect(t?.a).toBeGreaterThan(0);
  });

  it("survives genes outside [0, 1] and non-finite ones", () => {
    // Nothing guarantees a mutation operator respected the encoding's clamp.
    const genome = tri([-5, 2, Number.NaN, 0, 0, 1], [9, -1, Infinity, 0.5]);
    const [t] = decodePolygons(genome, SHAPE);
    for (const v of [...(t?.xs ?? []), ...(t?.ys ?? [])]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(16);
    }
    expect(t?.r).toBe(255);
    expect(t?.g).toBe(0);
  });
});

describe("rasterising", () => {
  it("starts from opaque white", () => {
    const rgb = renderPolygons([], SHAPE);
    expect(rgb).toHaveLength(16 * 16 * 3);
    expect([...rgb].every((v) => v === 255)).toBe(true);
  });

  it("fills the covered half and leaves the rest alone", () => {
    // Right triangle over the top-left half of the canvas, fully opaque red.
    const rgb = renderPolygons(tri([0, 0, 1, 0, 0, 1], [1, 0, 0, 1]), SHAPE);
    expect(px(rgb, 1, 1)).toEqual([255, 0, 0]);
    expect(px(rgb, 14, 14)).toEqual([255, 255, 255]);
  });

  it("blends translucent layers instead of replacing them", () => {
    const half = tri([0, 0, 1, 0, 0, 1], [0, 0, 0, 0.6]);
    const once = renderPolygons(half, SHAPE);
    const twice = renderPolygons([...half, ...half], SHAPE);
    // The second layer must darken further; a replace would leave these equal.
    expect(px(twice, 1, 1)[0]).toBeLessThan(px(once, 1, 1)[0] as number);
    expect(px(once, 1, 1)[0]).toBeLessThan(255);
  });

  it("paints later polygons over earlier ones", () => {
    const red = tri([0, 0, 1, 0, 0, 1], [1, 0, 0, 1]);
    const blue = tri([0, 0, 1, 0, 0, 1], [0, 0, 1, 1]);
    expect(px(renderPolygons([...red, ...blue], SHAPE), 1, 1)).toEqual([0, 0, 255]);
    expect(px(renderPolygons([...blue, ...red], SHAPE), 1, 1)).toEqual([255, 0, 0]);
  });

  it("draws the same triangle whichever way its vertices wind", () => {
    // Mutation reorders vertices freely; a backface cull here would make half
    // of all polygons randomly invisible.
    const cw = renderPolygons(tri([0, 0, 1, 0, 0, 1], [1, 0, 0, 1]), SHAPE);
    const ccw = renderPolygons(tri([0, 0, 0, 1, 1, 0], [1, 0, 0, 1]), SHAPE);
    expect([...ccw]).toEqual([...cw]);
  });

  it("never writes outside the canvas", () => {
    // Coordinates are clamped, but a bounding box off by one would still throw
    // or corrupt a neighbouring row.
    const rgb = renderPolygons(tri([0, 0, 1, 1, 1, 0], [0, 0, 0, 1]), {
      width: 5,
      height: 5,
    });
    expect(rgb).toHaveLength(75);
  });

  it("skips a degenerate triangle rather than dividing by zero", () => {
    const rgb = renderPolygons(tri([0.5, 0.5, 0.5, 0.5, 0.5, 0.5], [1, 0, 0, 1]), SHAPE);
    expect([...rgb].every((v) => v === 255)).toBe(true);
  });

  it("is deterministic, so a genome always scores the same image", () => {
    const genome = [
      ...tri([0.1, 0.2, 0.9, 0.3, 0.4, 0.8], [0.2, 0.7, 0.3, 0.5]),
      ...tri([0.6, 0.1, 0.2, 0.9, 0.95, 0.7], [0.9, 0.1, 0.4, 0.3]),
    ];
    expect([...renderPolygons(genome, SHAPE)]).toEqual([...renderPolygons(genome, SHAPE)]);
  });
});

describe("what the representation forbids", () => {
  /** Fraction of horizontally adjacent pixels whose red channel differs. */
  function highFrequencyFraction(rgb: Uint8Array, w: number, h: number): number {
    let differing = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w - 1; x++) {
        const i = (y * w + x) * 3;
        if (rgb[i] !== rgb[i + 3]) differing++;
      }
    }
    return differing / (h * (w - 1));
  }

  it("cannot express the per-pixel noise a bit string can, which is the point", () => {
    // The measured failure of the raw bit string (docs/experiments/clip-gradient.md)
    // was adversarial high-frequency texture. This is the structural claim that
    // the polygon genome makes that unreachable, stated as a comparison rather
    // than a magic threshold: the same random numbers, both representations.
    const shape = { width: 64, height: 64 };
    let seed = 12345;
    const rand = (): number => {
      // Fixed LCG: an assertion about the representation, not one lucky draw.
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };

    const polys = renderPolygons(
      Array.from({ length: polygonGenomeLength(24) }, rand),
      shape,
    );
    const bits = bitsToRgb(
      Array.from({ length: genomeLengthFor(shape) }, () => (rand() < 0.5 ? 0 : 1)),
      shape,
    );

    const polyNoise = highFrequencyFraction(polys, 64, 64);
    const bitNoise = highFrequencyFraction(bits, 64, 64);

    // A random bit string is almost entirely edges; polygons are almost none.
    expect(bitNoise).toBeGreaterThan(0.9);
    expect(polyNoise).toBeLessThan(bitNoise / 3);
  });

  /** Mean high-frequency fraction over several random genomes. */
  function meanNoise(w: number, h: number, polygons: number, seed = 7): number {
    let s = seed;
    const rand = (): number => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
    let total = 0;
    const trials = 12;
    for (let t = 0; t < trials; t++) {
      const rgb = renderPolygons(
        Array.from({ length: polygonGenomeLength(polygons) }, rand),
        { width: w, height: h },
      );
      total += highFrequencyFraction(rgb, w, h);
    }
    return total / trials;
  }

  it("keeps that property across the search space at the default density", () => {
    // Not one sampled point: adversarial texture must be out of reach
    // generally, or the defence is a coincidence of the genome we happened
    // to draw.
    expect(meanNoise(64, 64, 24)).toBeLessThan(0.3);
    expect(meanNoise(64, 64, 24, 991)).toBeLessThan(0.3);
  });

  it("loses the constraint as polygons approach pixels", () => {
    // The finding that fixed this problem's defaults. The defence is a ratio,
    // not a property of using polygons at all — pack in enough triangles and
    // per-pixel noise is expressible again. An earlier default of 48 polygons
    // on a 32x32 canvas sat on the wrong side of this.
    const sparse = meanNoise(64, 64, 8);
    const dense = meanNoise(32, 32, 48);
    expect(sparse).toBeLessThan(0.15);
    expect(dense).toBeGreaterThan(0.5);
    expect(dense).toBeGreaterThan(sparse * 3);
  });
});
