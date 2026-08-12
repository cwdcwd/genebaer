import type { JSONSchema } from "@genebaer/shared-types";

/** Deterministic, seedable RNG. Implementations must be serializable-reproducible:
 *  two instances constructed with the same seed produce identical sequences. */
export interface RandomSource {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [minInclusive, maxExclusive). */
  int(minInclusive: number, maxExclusive: number): number;
  /** Uniformly pick one element. Throws on empty array. */
  pick<T>(arr: readonly T[]): T;
  /** In-place Fisher–Yates shuffle; returns the same array. */
  shuffle<T>(arr: T[]): T[];
}

/**
 * mulberry32 — tiny fast seeded PRNG, good statistical quality for GA use,
 * and bit-for-bit reproducible across runs/platforms.
 */
export class SeededRandomSource implements RandomSource {
  private state: number;

  constructor(public readonly seed: number) {
    // Force to uint32; avoid zero state.
    this.state = (seed >>> 0) || 0x9e3779b9;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(minInclusive: number, maxExclusive: number): number {
    if (maxExclusive <= minInclusive) {
      throw new RangeError(
        `int(): bad range [${minInclusive}, ${maxExclusive})`,
      );
    }
    return minInclusive + Math.floor(this.next() * (maxExclusive - minInclusive));
  }

  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new RangeError("pick() on empty array");
    const v = arr[this.int(0, arr.length)];
    return v as T;
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(0, i + 1);
      const tmp = arr[i] as T;
      arr[i] = arr[j] as T;
      arr[j] = tmp;
    }
    return arr;
  }
}

/** Default operator params: read `params[key]`, else schema default, else fallback. */
export function paramWithDefault(
  schema: Record<string, JSONSchema>,
  params: Record<string, unknown> | undefined,
  key: string,
): unknown {
  const supplied = params?.[key];
  if (supplied !== undefined) return supplied;
  const s = schema[key];
  if (s && "default" in s) return s.default;
  return undefined;
}

export function numberParam(
  schema: Record<string, JSONSchema>,
  params: Record<string, unknown> | undefined,
  key: string,
  fallback: number,
): number {
  const v = paramWithDefault(schema, params, key);
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return fallback;
}

export function stringParam(
  schema: Record<string, JSONSchema>,
  params: Record<string, unknown> | undefined,
  key: string,
  fallback: string,
): string {
  const v = paramWithDefault(schema, params, key);
  return typeof v === "string" ? v : fallback;
}
