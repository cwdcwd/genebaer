import { describe, expect, it } from "vitest";
import { augmentedViews, imageSeed, type RgbImage } from "./augment.js";

/** A gradient image, so any crop or flip is detectable. */
function gradient(width = 8, height = 8): RgbImage {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      rgb[i] = Math.round((x / (width - 1)) * 255);
      rgb[i + 1] = Math.round((y / (height - 1)) * 255);
      rgb[i + 2] = 128;
    }
  }
  return { width, height, rgb };
}

describe("count: 1 is exactly no augmentation", () => {
  it("returns the image unchanged", () => {
    // The default must not silently change what every existing run measures.
    const img = gradient();
    const [only, ...rest] = augmentedViews(img, 1);
    expect(rest).toHaveLength(0);
    expect([...(only?.rgb ?? [])]).toEqual([...img.rgb]);
  });

  it("keeps the unmodified image as the first of N views", () => {
    // The aligned score stays in the mean, so a genuinely good image is never
    // penalised by an unlucky set of random crops.
    const img = gradient();
    const views = augmentedViews(img, 6);
    expect(views).toHaveLength(6);
    expect([...(views[0]?.rgb ?? [])]).toEqual([...img.rgb]);
  });
});

describe("determinism", () => {
  it("gives the same image the same views every time", () => {
    // Fitness must be a function of the genome. Fresh randomness per call would
    // mean an individual re-scores differently, elitism carries forward a score
    // its genome cannot reproduce, and the cache returns numbers measured under
    // augmentations nobody saw.
    const img = gradient();
    const a = augmentedViews(img, 5);
    const b = augmentedViews(img, 5);
    expect(a.map((v) => [...v.rgb])).toEqual(b.map((v) => [...v.rgb]));
  });

  it("gives different images different views, so one transform cannot be gamed", () => {
    const a = augmentedViews(gradient(), 4);
    const b = augmentedViews(gradient(16, 16), 4);
    expect(imageSeed(gradient().rgb)).not.toBe(imageSeed(gradient(16, 16).rgb));
    // Different seeds, so the crop geometry differs rather than being fixed.
    expect(a[1]?.rgb).not.toEqual(b[1]?.rgb);
  });

  it("seeds from pixel content, not from object identity", () => {
    const one = gradient();
    const two = gradient();
    expect(imageSeed(one.rgb)).toBe(imageSeed(two.rgb));
    // A single changed byte must land somewhere else.
    const changed = Uint8Array.from(one.rgb);
    changed[0] = (changed[0] ?? 0) ^ 1;
    expect(imageSeed(changed)).not.toBe(imageSeed(one.rgb));
  });

  it("accepts an explicit seed, so a caller can reproduce a specific draw", () => {
    const img = gradient();
    expect(augmentedViews(img, 3, 42).map((v) => [...v.rgb])).toEqual(
      augmentedViews(img, 3, 42).map((v) => [...v.rgb]),
    );
    expect(augmentedViews(img, 3, 42)[1]?.rgb).not.toEqual(
      augmentedViews(img, 3, 7)[1]?.rgb,
    );
  });
});

describe("the views themselves", () => {
  it("keeps every view at the original size, so the model sees one shape", () => {
    for (const v of augmentedViews(gradient(12, 9), 8)) {
      expect(v.width).toBe(12);
      expect(v.height).toBe(9);
      expect(v.rgb).toHaveLength(12 * 9 * 3);
    }
  });

  it("makes every extra view a genuine change, never a copy", () => {
    // A view identical to the original costs a full inference and adds nothing
    // to the mean. Rounding on a small image used to produce exactly that.
    const img = gradient();
    for (const v of augmentedViews(img, 12).slice(1)) {
      expect(String(v.rgb)).not.toBe(String(img.rgb));
    }
  });

  it("only ever samples pixels that exist in the source", () => {
    // Reading out of bounds would introduce zeros, i.e. black edges, which is a
    // signal the search could exploit rather than a viewpoint change.
    const flat: RgbImage = {
      width: 6,
      height: 6,
      rgb: new Uint8Array(6 * 6 * 3).fill(200),
    };
    for (const v of augmentedViews(flat, 12)) {
      expect([...new Set(v.rgb)]).toEqual([200]);
    }
  });

  it("survives a one-pixel image, where every crop is degenerate", () => {
    const dot: RgbImage = { width: 1, height: 1, rgb: [10, 20, 30] };
    const views = augmentedViews(dot, 4);
    expect(views).toHaveLength(4);
    for (const v of views) expect([...v.rgb]).toEqual([10, 20, 30]);
  });
});

describe("refusing bad input", () => {
  it("rejects a non-positive or fractional count", () => {
    const img = gradient();
    expect(() => augmentedViews(img, 0)).toThrow(/positive integer/);
    expect(() => augmentedViews(img, 2.5)).toThrow(/positive integer/);
  });

  it("rejects a buffer that does not match the declared size", () => {
    // Silently scoring a mis-sized image would produce a real-looking number.
    expect(() => augmentedViews({ width: 4, height: 4, rgb: [1, 2, 3] }, 2)).toThrow(
      /needs 48 bytes, got 3/,
    );
  });
});
