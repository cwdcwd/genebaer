import { describe, expect, it } from "vitest";
import { cn, formatElapsed, formatFitness, formatTime, randomSeed } from "./utils";

describe("formatFitness", () => {
  it("renders an em dash for absent or non-numeric values", () => {
    expect(formatFitness(null)).toBe("—");
    expect(formatFitness(undefined)).toBe("—");
    expect(formatFitness(Number.NaN)).toBe("—");
  });

  it("prints integers verbatim, including zero", () => {
    expect(formatFitness(0)).toBe("0");
    expect(formatFitness(42)).toBe("42");
    expect(formatFitness(-7)).toBe("-7");
  });

  it("drops the fraction once magnitude reaches 1000", () => {
    expect(formatFitness(1234.56)).toBe("1235");
    expect(formatFitness(-1234.6)).toBe("-1235");
  });

  it("uses three decimals in the [1, 1000) band", () => {
    expect(formatFitness(1.5)).toBe("1.500");
    expect(formatFitness(999.9999)).toBe("1000.000");
  });

  it("falls back to exponential notation below 1", () => {
    expect(formatFitness(0.001)).toBe("1.00e-3");
    expect(formatFitness(-0.5)).toBe("-5.00e-1");
  });
});

describe("formatElapsed", () => {
  it("distinguishes zero from absent — 0ms is a real measurement", () => {
    expect(formatElapsed(0)).toBe("0ms");
    expect(formatElapsed(null)).toBe("—");
    expect(formatElapsed(undefined)).toBe("—");
  });

  it("rounds to whole milliseconds under a second", () => {
    expect(formatElapsed(999.4)).toBe("999ms");
    expect(formatElapsed(12.5)).toBe("13ms");
  });

  it("switches to seconds with one decimal under a minute", () => {
    expect(formatElapsed(1000)).toBe("1.0s");
    expect(formatElapsed(1500)).toBe("1.5s");
    expect(formatElapsed(59_400)).toBe("59.4s");
  });

  it("switches to minutes and seconds at a minute", () => {
    expect(formatElapsed(60_000)).toBe("1m 0s");
    expect(formatElapsed(61_000)).toBe("1m 1s");
    expect(formatElapsed(3_601_000)).toBe("60m 1s");
  });
});

describe("formatTime", () => {
  it("treats epoch 0 and absent values alike", () => {
    expect(formatTime(0)).toBe("—");
    expect(formatTime(null)).toBe("—");
    expect(formatTime(undefined)).toBe("—");
  });

  it("renders a real timestamp as a locale string", () => {
    const epoch = Date.UTC(2026, 0, 15, 12, 0, 0);
    expect(formatTime(epoch)).toBe(new Date(epoch).toLocaleString());
  });
});

describe("randomSeed", () => {
  it("stays inside the 31-bit non-negative integer range", () => {
    for (let i = 0; i < 200; i++) {
      const seed = randomSeed();
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThan(2 ** 31);
    }
  });
});

describe("cn", () => {
  it("merges conflicting tailwind classes, last one winning", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  it("drops falsy values instead of emitting empty classes", () => {
    expect(cn("a", false, undefined, null, "b")).toBe("a b");
  });
});
