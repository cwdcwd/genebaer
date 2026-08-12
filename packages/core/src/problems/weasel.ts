import type { JSONSchema } from "@genebaer/shared-types";
import { FitnessProblem, type VisualFrame } from "../operators/problem/base.js";
import { stringParam } from "../random.js";

/**
 * Weasel: evolve a random string toward a target phrase.
 * Fitness = number of correct characters.
 */
export class Weasel extends FitnessProblem<string> {
  static override readonly operatorId = "weasel";
  static override readonly displayName = "Weasel (target string)";
  static override readonly description = "Evolve a string toward a target phrase.";
  static override readonly paramsSchema: Record<string, JSONSchema> = {
    target: {
      type: "string",
      default: "METHINKS IT IS LIKE A WEASEL",
      title: "Target string",
    },
  };
  static override readonly compatibleEncodings = ["string"] as const;

  readonly target: string;

  constructor(params: Record<string, unknown> = {}) {
    super(params);
    this.target = stringParam(Weasel.paramsSchema, params, "target", "METHINKS IT IS LIKE A WEASEL");
  }

  override evaluate(genome: string): number {
    const n = Math.min(genome.length, this.target.length);
    let score = 0;
    for (let i = 0; i < n; i++) if (genome[i] === this.target[i]) score++;
    return score;
  }

  override visualize(best: string): VisualFrame {
    return {
      problemId: Weasel.operatorId,
      data: { current: best, target: this.target },
    };
  }
}
