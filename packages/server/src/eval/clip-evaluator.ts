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
  /**
   * Bump on ANY change to the model or preprocessing.
   *
   * `.2` added augmentation. Note WHY that needs a version bump: the score
   * cache keys on params, so N=1 and N=8 scores could never collide there. The
   * hazard is the worker registry. A worker running `.1` code does not know the
   * `augmentations` param exists, would ignore it, and would return a single
   * aligned score for a run that believes it is scoring a mean over eight
   * views. Version is how capability, not just model identity, is matched.
   */
  static override readonly version = "clip-vit-base-patch32.2";
  // NOTE: apps/web/src/components/worker-panel.tsx hardcodes this string as its
  // declared capability. Changing it here without changing it there leaves
  // browser workers silently unmatched. Tracked as genebaer-vnb.
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
    augmentations: {
      type: "integer",
      minimum: 1,
      maximum: 32,
      default: 1,
      title: "Augmented views",
      description:
        "Score the mean CLIP similarity over N random crops/flips instead of one aligned view. Adversarial patterns depend on exact pixel alignment and do not survive this; a recognisable image does. Costs N times the inference. 1 means no augmentation.",
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

  /**
   * How many augmented views a worker should average over.
   *
   * Validated here rather than worker-side so a bad config fails when the run
   * is configured, not once per genome deep inside a worker thread.
   */
  get augmentations(): number {
    const raw = this.params["augmentations"];
    if (raw === undefined) return 1;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
      throw new RangeError(
        `'${ClipSimilarityEvaluator.operatorId}': augmentations must be a positive ` +
          `integer, got ${JSON.stringify(raw)}`,
      );
    }
    return raw;
  }

  protected override paramsForJob(context: EvaluationContext<unknown>): Record<string, unknown> {
    // Part of the job params, so it is part of the score cache key: a run at
    // N=8 must never be served a number measured at N=1.
    return { prompt: this.promptFor(context), augmentations: this.augmentations };
  }
}
