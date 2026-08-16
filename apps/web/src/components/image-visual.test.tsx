import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  ImageVisual,
  ProblemVisual,
  fitRect,
  isImageFrame,
  toRgba,
} from "./visualizers";

afterEach(cleanup);

function frame(width: number, height: number, fill = 128) {
  return {
    width,
    height,
    channels: 3,
    prompt: "a red circle",
    rgb: new Array<number>(width * height * 3).fill(fill),
  };
}

describe("isImageFrame", () => {
  it("accepts a frame whose bytes match its dimensions", () => {
    expect(isImageFrame(frame(4, 4))).toBe(true);
    expect(isImageFrame(frame(1, 1))).toBe(true);
  });

  it("rejects a byte count that does not match the dimensions", () => {
    // The important case: a mismatched frame would render a skewed or
    // truncated image that still LOOKS plausible, which is worse than
    // rendering nothing at all.
    expect(isImageFrame({ width: 4, height: 4, channels: 3, rgb: [1, 2, 3] })).toBe(false);
    const tooMany = frame(2, 2);
    tooMany.rgb.push(0);
    expect(isImageFrame(tooMany)).toBe(false);
  });

  it("rejects nonsense shapes rather than throwing", () => {
    expect(isImageFrame(null)).toBe(false);
    expect(isImageFrame(undefined)).toBe(false);
    expect(isImageFrame("nope")).toBe(false);
    expect(isImageFrame({ width: 0, height: 4, channels: 3, rgb: [] })).toBe(false);
    expect(isImageFrame({ width: 2.5, height: 2, channels: 3, rgb: [] })).toBe(false);
    expect(isImageFrame({ width: 2, height: 2, channels: 3 })).toBe(false);
  });
});

describe("ImageVisual", () => {
  it("renders a canvas for a valid frame", () => {
    const { container } = render(<ImageVisual frame={frame(8, 8)} />);
    const canvas = container.querySelector("canvas");
    expect(canvas).not.toBeNull();
  });

  it("renders without throwing at the resolution image runs actually use", () => {
    // 32x32 is the recommended default from the convergence spike.
    expect(() => render(<ImageVisual frame={frame(32, 32)} />)).not.toThrow();
  });

  it("handles a non-square frame", () => {
    expect(() => render(<ImageVisual frame={frame(16, 8)} />)).not.toThrow();
  });
});

describe("ProblemVisual dispatch for image-prompt", () => {
  it("routes an image frame to the image renderer", () => {
    const { container } = render(
      <ProblemVisual problemId="image-prompt" data={frame(8, 8)} />,
    );
    // A canvas means it reached ImageVisual rather than the JSON fallback.
    expect(container.querySelector("canvas")).not.toBeNull();
  });

  it("falls back rather than rendering a mismatched frame as an image", () => {
    const { container } = render(
      <ProblemVisual
        problemId="image-prompt"
        data={{ width: 8, height: 8, channels: 3, rgb: [1, 2, 3] }}
      />,
    );
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("still shows the waiting state before any genome exists", () => {
    render(<ProblemVisual problemId="image-prompt" data={null} />);
    expect(screen.getByText(/waiting for first best genome/i)).toBeDefined();
  });

  it("does not hijack other problems", () => {
    // one-max renders div cells, not a canvas.
    const { container } = render(
      <ProblemVisual problemId="one-max" data={[1, 0, 1, 1]} />,
    );
    expect(container.querySelector("canvas")).toBeNull();
  });
});

describe("toRgba — where the pixels are actually decided", () => {
  it("maps RGB triples to opaque RGBA in order", () => {
    const rgba = toRgba({
      width: 2,
      height: 1,
      channels: 3,
      rgb: [255, 0, 0, 0, 0, 255],
    });
    expect([...rgba]).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
  });

  it("makes every pixel fully opaque", () => {
    // A transparent pixel would composite against the canvas background and
    // silently misreport the genome's colour.
    const rgba = toRgba(frame(4, 4, 0));
    for (let i = 3; i < rgba.length; i += 4) expect(rgba[i]).toBe(255);
  });

  it("produces exactly 4 bytes per pixel", () => {
    expect(toRgba(frame(32, 32)).length).toBe(32 * 32 * 4);
    expect(toRgba(frame(16, 8)).length).toBe(16 * 8 * 4);
  });

  it("preserves byte values exactly, with no gamma or scaling applied", () => {
    const rgb = [0, 1, 127, 128, 254, 255];
    const rgba = toRgba({ width: 2, height: 1, channels: 3, rgb });
    expect([rgba[0], rgba[1], rgba[2]]).toEqual([0, 1, 127]);
    expect([rgba[4], rgba[5], rgba[6]]).toEqual([128, 254, 255]);
  });
});

describe("fitRect — letterboxing", () => {
  it("centres a square frame in a wide box without stretching it", () => {
    const r = fitRect({ width: 32, height: 32 }, 400, 280);
    expect(r.width).toBe(280);
    expect(r.height).toBe(280);
    expect(r.x).toBe(60);
    expect(r.y).toBe(0);
  });

  it("preserves aspect ratio for a non-square frame", () => {
    const r = fitRect({ width: 16, height: 8 }, 400, 280);
    // A stretched genome misleads about what evolved.
    expect(r.width / r.height).toBeCloseTo(2);
  });

  it("never overflows the box", () => {
    for (const [w, h] of [[1, 100], [100, 1], [33, 17]]) {
      const r = fitRect({ width: w!, height: h! }, 400, 280);
      expect(r.width).toBeLessThanOrEqual(400);
      expect(r.height).toBeLessThanOrEqual(280);
    }
  });
});
