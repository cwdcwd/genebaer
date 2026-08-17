import type { RandomSource } from "../random.js";
import { Encoding } from "../encoding.js";
import { numberParam } from "../random.js";

/** Genome: number[] of 0/1. */
export class BinaryEncoding extends Encoding<number[]> {
  static override readonly operatorId = "binary";
  static override readonly sizeParam = "length";
  static override readonly displayName = "Binary";
  static override readonly description = "Bit-string genome of fixed length.";
  static override readonly paramsSchema = {
    length: {
      type: "integer",
      minimum: 1,
      maximum: 100000,
      default: 64,
      title: "Genome length (bits)",
    },
  } as const;

  readonly length: number;

  constructor(params: Record<string, unknown> = {}) {
    super(params);
    this.length = Math.max(
      1,
      Math.floor(numberParam(BinaryEncoding.paramsSchema, params, "length", 64)),
    );
  }

  override get genomeSize(): number {
    return this.length;
  }

  random(rng: RandomSource): number[] {
    const g = new Array<number>(this.length);
    for (let i = 0; i < this.length; i++) g[i] = rng.next() < 0.5 ? 0 : 1;
    return g;
  }

  /** Hamming distance. */
  distance(a: number[], b: number[]): number {
    const n = Math.min(a.length, b.length);
    let d = 0;
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) d++;
    return d + Math.abs(a.length - b.length);
  }

  size(genome: number[]): number {
    return genome.length;
  }

  clone(genome: number[]): number[] {
    return genome.slice();
  }

  equals(a: number[], b: number[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
}
