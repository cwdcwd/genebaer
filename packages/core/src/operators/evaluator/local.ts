import { FitnessEvaluator, type EvaluationContext } from "./base.js";

/**
 * Scores the population in-process by calling the problem directly.
 *
 * This is the default and preserves the behaviour every run had before
 * evaluators existed: pure, synchronous, single-threaded. It is the right
 * choice for any problem whose `evaluate` is cheap arithmetic — which is all
 * five built-in problems.
 *
 * Note it deliberately does no chunking or yielding: a genuinely expensive
 * local problem will block the event loop here, and the fix for that is a
 * worker-thread evaluator rather than making this one cleverer.
 */
export class LocalEvaluator extends FitnessEvaluator<unknown> {
  static override readonly operatorId = "local";
  static override readonly scoresInProcess = true;
  static override readonly displayName = "Local (in-process)";
  static override readonly description =
    "Scores the population in-process by calling the problem directly. Default.";
  static override readonly paramsSchema = {} as const;

  override evaluateBatch(
    genomes: readonly unknown[],
    context: EvaluationContext<unknown>,
  ): Promise<number[]> {
    // Not declared `async`: mapping is synchronous, and an async wrapper here
    // would only add a microtask. Errors are still surfaced as a rejection so
    // the engine has exactly one failure path to handle.
    try {
      return Promise.resolve(genomes.map((g) => context.problem.evaluate(g)));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
