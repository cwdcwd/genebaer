import type { RandomSource } from "../../random.js";
import { CrossoverOperator } from "./base.js";

/** One-point crossover over array-like genomes (number[]). */
export class OnePointCrossover extends CrossoverOperator<unknown> {
  static override readonly operatorId = "one-point";
  static override readonly displayName = "One-point";
  static override readonly description = "Swap tails after a single cut point.";
  static override readonly paramsSchema = {} as const;
  static readonly compatibleEncodings = ["binary", "numeric", "string"] as const;

  override crossover(a: unknown, b: unknown, rng: RandomSource): [unknown, unknown] {
    if (Array.isArray(a) && Array.isArray(b)) {
      const n = Math.min(a.length, b.length);
      if (n < 2) return [a.slice(), b.slice()];
      const cut = rng.int(1, n);
      return [
        [...a.slice(0, cut), ...b.slice(cut)],
        [...b.slice(0, cut), ...a.slice(cut)],
      ];
    }
    if (typeof a === "string" && typeof b === "string") {
      const n = Math.min(a.length, b.length);
      if (n < 2) return [a, b];
      const cut = rng.int(1, n);
      return [a.slice(0, cut) + b.slice(cut), b.slice(0, cut) + a.slice(cut)];
    }
    throw new TypeError("OnePointCrossover: unsupported genome type");
  }
}

/** Two-point crossover. */
export class TwoPointCrossover extends CrossoverOperator<unknown> {
  static override readonly operatorId = "two-point";
  static override readonly displayName = "Two-point";
  static override readonly description = "Swap the segment between two cut points.";
  static override readonly paramsSchema = {} as const;
  static readonly compatibleEncodings = ["binary", "numeric", "string"] as const;

  override crossover(a: unknown, b: unknown, rng: RandomSource): [unknown, unknown] {
    if (Array.isArray(a) && Array.isArray(b)) {
      const n = Math.min(a.length, b.length);
      if (n < 2) return [a.slice(), b.slice()];
      let i = rng.int(0, n - 1);
      let j = rng.int(i + 1, n);
      if (i > j) [i, j] = [j, i];
      return [
        [...a.slice(0, i), ...b.slice(i, j), ...a.slice(j)],
        [...b.slice(0, i), ...a.slice(i, j), ...b.slice(j)],
      ];
    }
    if (typeof a === "string" && typeof b === "string") {
      const n = Math.min(a.length, b.length);
      if (n < 2) return [a, b];
      const i = rng.int(0, n - 1);
      const j = rng.int(i + 1, n);
      return [
        a.slice(0, i) + b.slice(i, j) + a.slice(j),
        b.slice(0, i) + a.slice(i, j) + b.slice(j),
      ];
    }
    throw new TypeError("TwoPointCrossover: unsupported genome type");
  }
}

/** Uniform crossover: each gene independently from one parent or the other. */
export class UniformCrossover extends CrossoverOperator<unknown> {
  static override readonly operatorId = "uniform";
  static override readonly displayName = "Uniform";
  static override readonly description = "Each gene independently taken from parent A or B.";
  static override readonly paramsSchema = {
    swapProbability: {
      type: "number",
      minimum: 0,
      maximum: 1,
      default: 0.5,
      title: "Swap probability",
    },
  } as const;
  static readonly compatibleEncodings = ["binary", "numeric", "string"] as const;

  override crossover(a: unknown, b: unknown, rng: RandomSource): [unknown, unknown] {
    const pRaw = this.params["swapProbability"];
    const p =
      typeof pRaw === "number" && Number.isFinite(pRaw)
        ? Math.min(1, Math.max(0, pRaw))
        : 0.5;

    if (Array.isArray(a) && Array.isArray(b)) {
      const n = Math.min(a.length, b.length);
      const c1: unknown[] = new Array(n);
      const c2: unknown[] = new Array(n);
      for (let i = 0; i < n; i++) {
        if (rng.next() < p) {
          c1[i] = b[i];
          c2[i] = a[i];
        } else {
          c1[i] = a[i];
          c2[i] = b[i];
        }
      }
      return [c1, c2];
    }
    if (typeof a === "string" && typeof b === "string") {
      const n = Math.min(a.length, b.length);
      const c1: string[] = new Array(n);
      const c2: string[] = new Array(n);
      for (let i = 0; i < n; i++) {
        if (rng.next() < p) {
          c1[i] = b[i] as string;
          c2[i] = a[i] as string;
        } else {
          c1[i] = a[i] as string;
          c2[i] = b[i] as string;
        }
      }
      return [c1.join(""), c2.join("")];
    }
    throw new TypeError("UniformCrossover: unsupported genome type");
  }
}

/**
 * Arithmetic crossover for numeric vectors: child = α·a + (1−α)·b.
 */
export class ArithmeticCrossover extends CrossoverOperator<unknown> {
  static override readonly operatorId = "arithmetic";
  static override readonly displayName = "Arithmetic";
  static override readonly description =
    "Numeric: child = α·a + (1−α)·b (and its complement).";
  static override readonly paramsSchema = {
    alpha: {
      type: "number",
      minimum: 0,
      maximum: 1,
      default: 0.5,
      title: "Blend alpha",
    },
  } as const;
  static readonly compatibleEncodings = ["numeric"] as const;

  override crossover(a: unknown, b: unknown, rng: RandomSource): [unknown, unknown] {
    const alphaRaw = this.params["alpha"];
    const alpha =
      typeof alphaRaw === "number" && Number.isFinite(alphaRaw)
        ? Math.min(1, Math.max(0, alphaRaw))
        : 0.5;

    if (Array.isArray(a) && Array.isArray(b)) {
      const n = Math.min(a.length, b.length);
      const c1 = new Array<number>(n);
      const c2 = new Array<number>(n);
      for (let i = 0; i < n; i++) {
        const x = a[i] as number;
        const y = b[i] as number;
        c1[i] = alpha * x + (1 - alpha) * y;
        c2[i] = alpha * y + (1 - alpha) * x;
      }
      return [c1, c2];
    }
    throw new TypeError("ArithmeticCrossover: numeric array genomes only");
  }
}
