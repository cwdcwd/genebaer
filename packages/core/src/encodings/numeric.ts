import type { RandomSource } from "../random.js";
import { Encoding } from "../encoding.js";
import { numberParam } from "../random.js";

/** Genome: number[] of reals, each bounded to [min, max]. */
export class NumericVectorEncoding extends Encoding<number[]> {
  static override readonly operatorId = "numeric";
  static override readonly displayName = "Numeric vector";
  static override readonly description =
    "Real-valued vector genome, components bounded to [min, max].";
  static override readonly paramsSchema = {
    dimensions: {
      type: "integer",
      minimum: 1,
      maximum: 1000,
      default: 10,
      title: "Dimensions",
    },
    min: {
      type: "number",
      default: -5.12,
      title: "Lower bound",
    },
    max: {
      type: "number",
      default: 5.12,
      title: "Upper bound",
    },
  } as const;

  readonly dimensions: number;
  readonly min: number;
  readonly max: number;

  constructor(params: Record<string, unknown> = {}) {
    super(params);
    this.dimensions = Math.max(
      1,
      Math.floor(
        numberParam(NumericVectorEncoding.paramsSchema, params, "dimensions", 10),
      ),
    );
    this.min = numberParam(NumericVectorEncoding.paramsSchema, params, "min", -5.12);
    this.max = numberParam(NumericVectorEncoding.paramsSchema, params, "max", 5.12);
    if (this.max <= this.min) {
      throw new RangeError(
        `NumericVectorEncoding: max (${this.max}) must be > min (${this.min})`,
      );
    }
  }

  random(rng: RandomSource): number[] {
    const g = new Array<number>(this.dimensions);
    const span = this.max - this.min;
    for (let i = 0; i < this.dimensions; i++) g[i] = this.min + rng.next() * span;
    return g;
  }

  /** Euclidean distance. */
  distance(a: number[], b: number[]): number {
    const n = Math.min(a.length, b.length);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const d = (a[i] as number) - (b[i] as number);
      sum += d * d;
    }
    return Math.sqrt(sum);
  }

  size(genome: number[]): number {
    return genome.length;
  }

  clone(genome: number[]): number[] {
    return genome.slice();
  }

  /** Clamp into bounds (used after mutation/crossover). */
  clamp(g: number[]): number[] {
    for (let i = 0; i < g.length; i++) {
      const v = g[i] as number;
      if (v < this.min) g[i] = this.min;
      else if (v > this.max) g[i] = this.max;
    }
    return g;
  }

  equals(a: number[], b: number[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
}
