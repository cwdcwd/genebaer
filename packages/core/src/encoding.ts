import type { JSONSchema } from "@genebaer/shared-types";
import { BaseOperator } from "./base.js";
import type { RandomSource } from "./random.js";

/**
 * A gene encoding: defines the genome shape, how to generate random genomes,
 * and a distance metric used for population diversity.
 *
 * G is the genome type parameter (e.g. number[], string).
 */
export abstract class Encoding<G> extends BaseOperator {
  /**
   * Which of this encoding's params sets the genome size.
   *
   * Named rather than assumed: it is "length" for binary and string but
   * "dimensions" for numeric, and a hardcoded map in the UI would be exactly
   * the kind of duplicated knowledge that goes stale silently.
   */
  static readonly sizeParam: string | null = null;

  /** Registry id, e.g. "binary". Also used as `compatibleEncodings` value. */
  declare static readonly operatorId: string;

  /** Generate one uniformly-random genome. */
  abstract random(rng: RandomSource): G;

  /**
   * Distance between two genomes, in the encoding's native metric.
   * Used only for the diversity stat. Should be symmetric.
   */
  abstract distance(a: G, b: G): number;

  /** Number of genes (length). */
  abstract size(genome: G): number;

  /**
   * Genes every genome from this encoding will have, or null if it varies.
   *
   * Read from the encoding's own parsed params rather than by generating a
   * genome and measuring it: `random()` would consume the seeded RNG, and a
   * validation check must not change what a seeded run produces.
   */
  get genomeSize(): number | null {
    return null;
  }

  /** Deep copy. Implementations must not alias mutable internals. */
  abstract clone(genome: G): G;

  /** Structural equality. */
  abstract equals(a: G, b: G): boolean;

  /** Default params used by problems that declare this encoding as compatible. */
  get defaultParams(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const schema = (this.constructor as typeof BaseOperator).paramsSchema;
    for (const [k, s] of Object.entries(schema)) {
      if ("default" in s) out[k] = s.default;
    }
    return out;
  }

  /** Narrow helper for UIs: schema + defaults. */
  static describe(): {
    id: string;
    paramsSchema: Record<string, JSONSchema>;
  } {
    return { id: this.operatorId, paramsSchema: this.paramsSchema };
  }
}
