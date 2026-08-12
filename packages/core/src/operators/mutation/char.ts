import type { RandomSource } from "../../random.js";
import { MutationOperator } from "./base.js";
import { stringParam } from "../../random.js";

/**
 * Replace each character with probability `rate`, picking from `alphabet`.
 * String genomes.
 */
export class CharMutation extends MutationOperator<unknown> {
  static override readonly operatorId = "char";
  static override readonly displayName = "Character";
  static override readonly description =
    "Replace each character with probability = mutation rate, from the alphabet.";
  static override readonly paramsSchema = {
    alphabet: {
      type: "string",
      default:
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,!?;:'\"()-",
      title: "Alphabet",
    },
  } as const;
  static readonly compatibleEncodings = ["string"] as const;

  private readonly alphabet: string;

  constructor(params: Record<string, unknown> = {}) {
    super(params);
    this.alphabet = stringParam(
      CharMutation.paramsSchema,
      params,
      "alphabet",
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,!?;:'\"()-",
    );
    if (this.alphabet.length === 0) {
      throw new RangeError("CharMutation: alphabet must not be empty");
    }
  }

  override mutate(genome: unknown, rate: number, rng: RandomSource): unknown {
    if (typeof genome !== "string") {
      throw new TypeError("CharMutation: string genome required");
    }
    const chars = genome.split("");
    for (let i = 0; i < chars.length; i++) {
      if (rng.next() < rate) chars[i] = rng.pick([...this.alphabet]);
    }
    return chars.join("");
  }
}
