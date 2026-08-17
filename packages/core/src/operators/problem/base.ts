import { BaseOperator } from "../../base.js";

/**
 * Serialisable description of the current best individual, consumed by a
 * frontend canvas visualizer keyed by `problemId`.
 */
export interface VisualFrame {
  problemId: string;
  /** Problem-specific payload (string for Weasel, vertex ids for MDS, ...). */
  data: unknown;
}

/**
 * A fitness problem: maps a genome to a scalar fitness (higher = better).
 * `evaluate` must be deterministic given the same genome + params.
 */
export abstract class FitnessProblem<G = unknown> extends BaseOperator {
  declare static readonly operatorId: string;
  /** Encoding ids this problem can evaluate. */
  static readonly compatibleEncodings: readonly string[] = [];

  /**
   * Whether `evaluate()` can actually score a genome in this process.
   *
   * True for every ordinary problem. False where fitness is a model's
   * judgement — ImagePrompt's `evaluate()` exists only to throw, because
   * scoring an image against a prompt needs inference that cannot happen
   * inline. Static rather than an instance getter so the registry can publish
   * it without constructing the problem, exactly as `compatibleEncodings`
   * already works (genebaer-gdv).
   */
  static readonly scorableInProcess: boolean = true;

  abstract evaluate(genome: G): number;

  /** Optional: current-best payload for the frontend canvas visualizer. */
  visualize(_best: G): VisualFrame | null {
    return null;
  }

  /**
   * Genes this problem needs, when its params determine that exactly.
   *
   * `null` means any length works — OneMax and Sphere score a genome of
   * whatever size the encoding produces. But Weasel needs one gene per target
   * character, MDS one per vertex, and ImagePrompt a number set by its
   * representation. For those, pairing the problem with a differently-sized
   * encoding is a misconfiguration, and until this existed the UI had no way to
   * know: it only ever saw JSON Schema, which cannot express "as long as the
   * target string". See genebaer-7tu.
   */
  get requiredGenomeLength(): number | null {
    return null;
  }


}
