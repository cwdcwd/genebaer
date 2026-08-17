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

  /** One gene per target character; a shorter genome can never match. */
  override get requiredGenomeLength(): number {
    return this.target.length;
  }

  override evaluate(genome: string): number {
    // Truncating to the shorter of the two used to hide a misconfiguration:
    // a genome of the wrong length scored against only the overlap, so the run
    // optimised a prefix of the target and looked healthy doing it. The engine
    // now rejects such a pairing up front, and this is the same refusal for
    // anyone calling the problem directly.
    if (genome.length !== this.target.length) {
      throw new RangeError(
        `Weasel: genome has ${String(genome.length)} genes but the target ` +
          `'${this.target}' needs ${String(this.target.length)}.`,
      );
    }
    let score = 0;
    for (let i = 0; i < this.target.length; i++) {
      if (genome[i] === this.target[i]) score++;
    }
    return score;
  }

  override visualize(best: string): VisualFrame {
    return {
      problemId: Weasel.operatorId,
      data: { current: best, target: this.target },
    };
  }
}
