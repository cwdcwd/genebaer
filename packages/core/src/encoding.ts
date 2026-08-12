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
