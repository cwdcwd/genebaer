import { FitnessProblem, type VisualFrame } from "@genebaer/core";
import {
  BITS_PER_PIXEL,
  bitsToRgb,
  genomeLengthFor,
  type ImageShape,
} from "./image-genome.js";

/**
 * Evolve a raster image toward a text prompt.
 *
 * The genome is a raw pixel bit string, so the existing `binary` encoding and
 * `bit-flip` mutation are reused unchanged — no new operators needed.
 *
 * Note what this problem does NOT do: it does not compute fitness. Scoring an
 * image against a prompt needs a model, which is an evaluator's job. The
 * problem defines the objective and how to render a genome; a
 * `clip-similarity` evaluator turns that into a number. That split is the
 * whole point of the evaluator abstraction.
 */
export class ImagePrompt extends FitnessProblem<number[]> {
  static override readonly operatorId = "image-prompt";
  static override readonly displayName = "Image from prompt";
  static override readonly description =
    "Evolve a raster image toward a text prompt. Requires a model-backed evaluator.";
  static override readonly compatibleEncodings = ["binary"] as const;
  static override readonly paramsSchema = {
    prompt: {
      type: "string",
      default: "a red circle on a white background",
      title: "Target prompt",
      description: "What the evolved image should look like.",
    },
    width: {
      type: "integer",
      minimum: 8,
      maximum: 256,
      default: 32,
      title: "Width (px)",
      description:
        "Genome length is width x height x 24 bits, so this drives search difficulty far more than scoring cost.",
    },
    height: {
      type: "integer",
      minimum: 8,
      maximum: 256,
      default: 32,
      title: "Height (px)",
    },
  } as const;

  readonly shape: ImageShape;
  readonly prompt: string;

  constructor(params: Record<string, unknown> = {}) {
    super(params);
    const width = numberParam(params["width"], 32);
    const height = numberParam(params["height"], 32);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new RangeError(
        `ImagePrompt: width and height must be positive integers, got ` +
          `${String(params["width"])}x${String(params["height"])}`,
      );
    }
    this.shape = { width, height };
    this.prompt = typeof params["prompt"] === "string" ? params["prompt"] : "";
  }

  /** Bits a genome must have for this problem's configured size. */
  get genomeLength(): number {
    return genomeLengthFor(this.shape);
  }

  /**
   * Always throws.
   *
   * Fitness here is a model's judgement of an image against a prompt, which
   * cannot be computed in-process. Running this problem under the default
   * `local` evaluator is a misconfiguration, and failing loudly is far better
   * than inventing a number that would quietly steer a whole run.
   */
  override evaluate(_genome: number[]): number {
    throw new Error(
      `'${ImagePrompt.operatorId}' cannot be scored in-process: fitness is a ` +
        `model's judgement of the rendered image against the prompt. Configure a ` +
        `model-backed evaluator (for example 'clip-similarity') on the run.`,
    );
  }

  /** Raw RGB bytes for this genome, for a scorer or a renderer. */
  render(genome: number[]): Uint8Array {
    return bitsToRgb(genome, this.shape);
  }

  /**
   * Current best as an image frame the web canvas can draw directly.
   *
   * Bytes are handed over as a plain number array so the frame stays
   * JSON-serialisable over the existing WS channel.
   */
  override visualize(best: number[]): VisualFrame | null {
    if (best.length !== this.genomeLength) return null;
    return {
      problemId: ImagePrompt.operatorId,
      data: {
        width: this.shape.width,
        height: this.shape.height,
        channels: 3,
        prompt: this.prompt,
        rgb: [...this.render(best)],
      },
    };
  }
}

function numberParam(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Convenience for configuring a run: the binary encoding params to match. */
export function encodingParamsFor(shape: ImageShape): { length: number } {
  return { length: shape.width * shape.height * BITS_PER_PIXEL };
}
