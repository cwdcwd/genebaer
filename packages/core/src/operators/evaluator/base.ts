import { BaseOperator } from "../../base.js";
import type { FitnessProblem } from "../problem/base.js";

/**
 * Everything an evaluator is given about the objective it is scoring against.
 *
 * The problem instance is passed rather than assumed so that a local evaluator
 * can call it directly, while a distributed evaluator can read its registry id
 * and params to tell remote workers *what* to score without shipping code.
 */
export interface EvaluationContext<G = unknown> {
  /** The objective being scored. Defines fitness; not how it is computed. */
  readonly problem: FitnessProblem<G>;
  /** Generation index this batch belongs to. Useful for logging and caching. */
  readonly generation: number;
}

/**
 * How fitness is computed, as opposed to what is being optimized.
 *
 * `FitnessProblem` says what a good genome is; `FitnessEvaluator` says where
 * and how the population gets scored. Splitting them is what lets fitness move
 * off the main thread — or off the machine — without the engine knowing.
 *
 * Implementations MUST return one score per genome, in the same order as the
 * input. The engine assigns fitness positionally, so a reordered or
 * short-length result silently mismatches genomes to scores, corrupting
 * selection with no error anywhere.
 */
export abstract class FitnessEvaluator<G = unknown> extends BaseOperator {
  declare static readonly operatorId: string;

  /**
   * Whether this evaluator computes fitness by calling `problem.evaluate()`
   * inline, in this process.
   *
   * False by default: anything that queues work, uses threads, or talks to a
   * remote worker does not. Only the in-process evaluator says true, and it is
   * the one pairing that a model-backed problem cannot use.
   */
  static readonly scoresInProcess: boolean = false;

  /**
   * Score an entire population. Called once per generation, not once per
   * individual: a round trip per genome is what makes a remote evaluator
   * unusable, so batching is part of the contract rather than an optimization.
   */
  abstract evaluateBatch(
    genomes: readonly G[],
    context: EvaluationContext<G>,
  ): Promise<number[]>;
}
