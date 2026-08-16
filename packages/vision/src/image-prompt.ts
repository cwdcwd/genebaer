import { FitnessProblem, type JSONSchema, type VisualFrame } from "@genebaer/core";
import {
  BITS_PER_PIXEL,
  bitsToRgb,
  genomeLengthFor,
  type ImageShape,
} from "./image-genome.js";
import { polygonGenomeLength, renderPolygons } from "./polygons.js";

/** How a genome encodes an image. */
export type Representation = "polygons" | "bits";

const DEFAULT_POLYGONS = 24;
const DEFAULT_SIZE = 64;

/**
 * Below this many pixels per polygon, the representation stops constraining.
 *
 * Measured, not guessed: at 32x32 with 48 polygons (21 px each) a random
 * genome already renders 0.58 high-frequency edges, against 1.0 for a random
 * bit string — most of the defence is gone. At 64x64 with 24 polygons
 * (171 px each) it is 0.25. See docs/experiments/polygon-constraint.md.
 */
export const MIN_PIXELS_PER_POLYGON = 100;

const PARAMS_SCHEMA: Record<string, JSONSchema> = {
  prompt: {
    type: "string",
    default: "a red circle on a white background",
    title: "Target prompt",
    description: "What the evolved image should look like.",
  },
  representation: {
    type: "string",
    enum: ["polygons", "bits"],
    default: "polygons",
    title: "Representation",
    description:
      "polygons: translucent triangles over a 'numeric' genome — constrained, so CLIP is far harder to exploit. bits: raw pixels over a 'binary' genome — unconstrained, and measurably reaches adversarial images.",
  },
  polygons: {
    type: "integer",
    minimum: 1,
    maximum: 512,
    default: DEFAULT_POLYGONS,
    title: "Polygons",
    description:
      "Triangles available to the image. Only used by the polygons representation; each costs 10 genes. Keep well below the pixel count — the constraint is a ratio, and it weakens as polygons approach pixels.",
  },
  width: {
    type: "integer",
    minimum: 8,
    maximum: 256,
    default: DEFAULT_SIZE,
    title: "Width (px)",
    description:
      "Under 'bits' this drives genome length (width x height x 24) and so search difficulty. Under 'polygons' it is only the raster size.",
  },
  height: {
    type: "integer",
    minimum: 8,
    maximum: 256,
    default: DEFAULT_SIZE,
    title: "Height (px)",
  },
};

/**
 * Evolve an image toward a text prompt.
 *
 * Two representations, and the choice matters more than any operator setting:
 *
 * - `polygons` (default): translucent triangles over a numeric genome, reusing
 *   the `numeric` encoding with `gaussian` mutation.
 * - `bits`: a raw pixel bit string over the `binary` encoding with `bit-flip`.
 *
 * `bits` is the obvious encoding and the wrong default. Measured in
 * docs/experiments/clip-gradient.md: it optimises well, and it optimises into
 * an adversarial pattern CLIP scores far above a real photograph of the
 * subject. Nothing constrains a per-pixel search to images that look like
 * anything. A few dozen flat triangles cannot express that noise, so the
 * defence is structural rather than a penalty term the search would learn to
 * pay. `bits` stays available because reproducing that result is the reason we
 * know any of this.
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
    "Evolve an image toward a text prompt. Requires a model-backed evaluator.";
  static override readonly compatibleEncodings = ["numeric", "binary"] as const;
  static override readonly paramsSchema = PARAMS_SCHEMA;

  readonly shape: ImageShape;
  readonly prompt: string;
  readonly representation: Representation;
  readonly polygons: number;

  constructor(params: Record<string, unknown> = {}) {
    super(params);
    const width = numberParam(params["width"], DEFAULT_SIZE);
    const height = numberParam(params["height"], DEFAULT_SIZE);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new RangeError(
        `ImagePrompt: width and height must be positive integers, got ` +
          `${String(params["width"])}x${String(params["height"])}`,
      );
    }
    this.shape = { width, height };
    this.prompt = typeof params["prompt"] === "string" ? params["prompt"] : "";

    const rep = params["representation"];
    if (rep !== undefined && rep !== "polygons" && rep !== "bits") {
      // Silently falling back would hand back a genome length for a
      // representation the caller did not ask for, and the mismatch would only
      // surface as a confusing encoding error much later.
      throw new RangeError(
        `ImagePrompt: representation must be 'polygons' or 'bits', got ${JSON.stringify(rep)}`,
      );
    }
    this.representation = rep === "bits" ? "bits" : "polygons";

    const polygons = numberParam(params["polygons"], DEFAULT_POLYGONS);
    if (!Number.isInteger(polygons) || polygons < 1) {
      throw new RangeError(
        `ImagePrompt: polygons must be a positive integer, got ${String(params["polygons"])}`,
      );
    }
    this.polygons = polygons;
  }

  /**
   * Canvas area each polygon gets, on average.
   *
   * The defence this representation provides is a ratio, not a property of
   * using polygons at all. Enough triangles to cover a few pixels each and the
   * search can paint per-pixel noise again, defeating the whole point.
   */
  get pixelsPerPolygon(): number {
    return (this.shape.width * this.shape.height) / this.polygons;
  }

  /**
   * Whether this configuration has stopped constraining the search.
   *
   * Reported rather than thrown: a caller may deliberately want a dense,
   * detailed image and accept the exposure. Silently pretending the config is
   * safe is the failure mode worth avoiding.
   */
  get constraintIsWeak(): boolean {
    return (
      this.representation === "polygons" &&
      this.pixelsPerPolygon < MIN_PIXELS_PER_POLYGON
    );
  }

  /**
   * The general contract the UI reads, satisfied by this problem's own
   * representation-dependent length.
   */
  override get requiredGenomeLength(): number {
    return this.genomeLength;
  }

  /** Genes a genome must have for this problem's configuration. */
  get genomeLength(): number {
    return this.representation === "bits"
      ? genomeLengthFor(this.shape)
      : polygonGenomeLength(this.polygons);
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
    if (this.representation === "bits") return bitsToRgb(genome, this.shape);

    // `renderPolygons` tolerates any length by design, reading whole polygons
    // and ignoring a ragged tail. That is right for the rasteriser and wrong
    // here: a genome sized for a different config would quietly render a
    // partial image and produce a real-looking score. Bits already fail loudly
    // on a mismatch, and the two representations should behave the same way.
    if (genome.length !== this.genomeLength) {
      throw new RangeError(
        `ImagePrompt: a ${String(this.polygons)}-polygon image needs exactly ` +
          `${String(this.genomeLength)} genes, got ${String(genome.length)}. ` +
          `Check the 'numeric' encoding's dimensions match the 'polygons' param.`,
      );
    }
    return renderPolygons(genome, this.shape);
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

/** Convenience for configuring a `bits` run: the binary encoding params to match. */
export function encodingParamsFor(shape: ImageShape): { length: number } {
  return { length: shape.width * shape.height * BITS_PER_PIXEL };
}

/**
 * Convenience for configuring a `polygons` run: the numeric encoding params.
 *
 * Bounds are [0, 1] because every gene is a normalised fraction — of the
 * canvas, of full intensity, of full opacity. The encoding clamps to these
 * after mutation, which is exactly the containment this representation is for.
 */
export function polygonEncodingParams(polygons: number): {
  dimensions: number;
  min: number;
  max: number;
} {
  return { dimensions: polygonGenomeLength(polygons), min: 0, max: 1 };
}
