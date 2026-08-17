import type { RandomSource } from "../random.js";
import { Encoding } from "../encoding.js";
import { numberParam, stringParam } from "../random.js";

/** Genome: JavaScript string over a fixed alphabet, fixed length. */
export class StringEncoding extends Encoding<string> {
  static override readonly operatorId = "string";
  static override readonly sizeParam = "length";
  static override readonly displayName = "String";
  static override readonly description = "Fixed-length string over a given alphabet.";
  static override readonly paramsSchema = {
    alphabet: {
      type: "string",
      default:
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,!?;:'\"()-",
      title: "Alphabet",
      description: "Allowed characters.",
    },
    length: {
      type: "integer",
      minimum: 1,
      maximum: 10000,
      default: 32,
      title: "String length",
    },
  } as const;

  readonly alphabet: string;
  readonly length: number;

  constructor(params: Record<string, unknown> = {}) {
    super(params);
    this.alphabet = stringParam(
      StringEncoding.paramsSchema,
      params,
      "alphabet",
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,!?;:'\"()-",
    );
    this.length = Math.max(
      1,
      Math.floor(numberParam(StringEncoding.paramsSchema, params, "length", 32)),
    );
    if (this.alphabet.length === 0) {
      throw new RangeError("StringEncoding: alphabet must not be empty");
    }
  }

  override get genomeSize(): number {
    return this.length;
  }

  random(rng: RandomSource): string {
    const chars = new Array<string>(this.length);
    for (let i = 0; i < this.length; i++) chars[i] = rng.pick([...this.alphabet]);
    return chars.join("");
  }

  /** Hamming distance over characters. */
  distance(a: string, b: string): number {
    const n = Math.min(a.length, b.length);
    let d = 0;
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) d++;
    return d + Math.abs(a.length - b.length);
  }

  size(genome: string): number {
    return genome.length;
  }

  clone(genome: string): string {
    return genome; // strings are immutable
  }

  equals(a: string, b: string): boolean {
    return a === b;
  }
}
