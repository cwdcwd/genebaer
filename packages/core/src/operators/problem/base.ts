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

  abstract evaluate(genome: G): number;

  /** Optional: current-best payload for the frontend canvas visualizer. */
  visualize(_best: G): VisualFrame | null {
    return null;
  }
}
