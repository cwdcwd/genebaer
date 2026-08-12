import type { GenerationStats } from "@genebaer/shared-types";
import { BaseOperator } from "../../base.js";
import { numberParam } from "../../random.js";

/** Decides when a run stops. Any single condition firing ends the run. */
export abstract class TerminationCondition extends BaseOperator {
  /** Return null to continue, or a human-readable reason to stop. */
  abstract check(history: readonly GenerationStats[]): string | null;
}

export class MaxGenerations extends TerminationCondition {
  static override readonly operatorId = "max-generations";
  static override readonly displayName = "Max generations";
  static override readonly description = "Stop after N generations.";
  static override readonly paramsSchema = {
    maxGenerations: {
      type: "integer",
      minimum: 1,
      maximum: 1000000,
      default: 500,
      title: "Max generations",
    },
  } as const;

  private readonly max: number;

  constructor(params: Record<string, unknown> = {}) {
    super(params);
    this.max = Math.max(
      1,
      Math.floor(
        numberParam(MaxGenerations.paramsSchema, params, "maxGenerations", 500),
      ),
    );
  }

  override check(history: readonly GenerationStats[]): string | null {
    const lastGen = history.length;
    return lastGen >= this.max ? `Reached max generations (${this.max})` : null;
  }
}

export class TargetFitness extends TerminationCondition {
  static override readonly operatorId = "target-fitness";
  static override readonly displayName = "Target fitness";
  static override readonly description = "Stop when best fitness reaches a threshold.";
  static override readonly paramsSchema = {
    target: {
      type: "number",
      default: 0,
      title: "Target fitness",
    },
  } as const;

  private readonly target: number;

  constructor(params: Record<string, unknown> = {}) {
    super(params);
    this.target = numberParam(TargetFitness.paramsSchema, params, "target", 0);
  }

  override check(history: readonly GenerationStats[]): string | null {
    const last = history[history.length - 1];
    if (!last) return null;
    return last.bestFitness >= this.target
      ? `Reached target fitness (${this.target})`
      : null;
  }
}

export class Stagnation extends TerminationCondition {
  static override readonly operatorId = "stagnation";
  static override readonly displayName = "Stagnation";
  static override readonly description =
    "Stop when best fitness hasn't improved by epsilon for N generations.";
  static override readonly paramsSchema = {
    generations: {
      type: "integer",
      minimum: 2,
      maximum: 100000,
      default: 50,
      title: "Stagnation window",
    },
    epsilon: {
      type: "number",
      minimum: 0,
      default: 1e-9,
      title: "Improvement epsilon",
    },
  } as const;

  private readonly window: number;
  private readonly epsilon: number;

  constructor(params: Record<string, unknown> = {}) {
    super(params);
    this.window = Math.max(
      2,
      Math.floor(numberParam(Stagnation.paramsSchema, params, "generations", 50)),
    );
    this.epsilon = Math.max(
      0,
      numberParam(Stagnation.paramsSchema, params, "epsilon", 1e-9),
    );
  }

  override check(history: readonly GenerationStats[]): string | null {
    if (history.length < this.window) return null;
    const current = history[history.length - 1] as GenerationStats;
    const past = history[history.length - this.window] as GenerationStats;
    if (current.bestFitness - past.bestFitness < this.epsilon) {
      return `No improvement ≥ ${this.epsilon} for ${this.window} generations`;
    }
    return null;
  }
}
