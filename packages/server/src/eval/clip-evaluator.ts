import type { EvaluationContext } from "@genebaer/core";
import { ImagePrompt } from "@genebaer/vision";
import { QueuedEvaluator } from "./queued-evaluator.js";

/** What a worker receives for one image genome. */
export interface ClipJobPayload {
  width: number;
  height: number;
  channels: 3;
  /** Raw RGB bytes, already rendered. Workers never see bit packing. */
  rgb: number[];
}

/**
 * Cosine similarity between a CLIP image embedding and a CLIP text embedding.
 *
 * Chosen over a captioner because the signal is CONTINUOUS. Early random-noise
 * images all caption identically, which gives a GA a flat landscape and nothing
 * to select on; cosine similarity moves smoothly and can be climbed.
 *
 * The genome is rendered to pixels here, once on the server, rather than in
 * every worker: a scorer should only have to know about pixels, never about how
 * bits are packed into them. That is what the `prepare` hook is for.
 *
 * `version` is tied to the model identity because scores from two models are
 * not comparable. Changing the model MUST bump it, or the score cache will
 * serve numbers measured by a different model and the worker registry will hand
 * jobs to workers running the wrong one.
 */
export class ClipSimilarityEvaluator extends QueuedEvaluator {
  static override readonly operatorId = "clip-similarity";
  /** Bump on ANY change to the model or preprocessing. */
  static override readonly version = "clip-vit-base-patch32.1";
  static override readonly displayName = "CLIP similarity";
  static override readonly description =
    "Scores an image against the problem's prompt using CLIP image/text cosine similarity.";
  static override readonly paramsSchema = {
    prompt: {
      type: "string",
      default: "",
      title: "Prompt override",
      description:
        "Leave empty to use the problem's prompt. Set only to score against different text than the problem defines.",
    },
  } as const;

  /**
   * Render the image genome to raw RGB once, server-side.
   *
   * Throws for a problem that is not image-shaped: a CLIP evaluator paired with
   * a numeric optimisation problem is a misconfiguration, and a clear failure
   * beats scoring something meaningless.
   */
  protected override prepare(
    genome: unknown,
    context: EvaluationContext<unknown>,
  ): ClipJobPayload {
    const problem = context.problem;
    if (!(problem instanceof ImagePrompt)) {
      throw new Error(
        `'${ClipSimilarityEvaluator.operatorId}' scores images, but the run's problem ` +
          `is not an image problem. Pair it with '${ImagePrompt.operatorId}'.`,
      );
    }
    if (!Array.isArray(genome)) {
      throw new TypeError(
        `'${ClipSimilarityEvaluator.operatorId}' expected a bit-string genome.`,
      );
    }
    return {
      width: problem.shape.width,
      height: problem.shape.height,
      channels: 3,
      rgb: [...problem.render(genome as number[])],
    };
  }

  /**
   * The text a worker should embed.
   *
   * Prefers the problem's prompt; the evaluator param exists only to score
   * against different text than the problem defines, which is unusual.
   */
  promptFor(context: EvaluationContext<unknown>): string {
    const override = this.params["prompt"];
    if (typeof override === "string" && override.length > 0) return override;
    const problem = context.problem;
    return problem instanceof ImagePrompt ? problem.prompt : "";
  }

  protected override paramsForJob(context: EvaluationContext<unknown>): Record<string, unknown> {
    return { prompt: this.promptFor(context) };
  }
}
