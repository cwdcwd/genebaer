import type { RandomSource } from "../../random.js";
import { MutationOperator } from "./base.js";
import { numberParam } from "../../random.js";

/**
 * Add N(0, sigma) noise to each component with probability `rate`,
 * clamped to [min, max] if provided via params (the engine passes the
 * encoding's bounds through).
 */
export class GaussianMutation extends MutationOperator<unknown> {
  static override readonly operatorId = "gaussian";
  static override readonly displayName = "Gaussian";
  static override readonly description =
    "Add zero-mean Gaussian noise to a fraction of components, clamped to bounds.";
  static override readonly paramsSchema = {
    sigma: {
      type: "number",
      minimum: 0,
      default: 0.5,
      title: "Sigma (std dev)",
    },
    min: { type: "number", title: "Lower clamp (optional)" },
    max: { type: "number", title: "Upper clamp (optional)" },
  } as const;
  static readonly compatibleEncodings = ["numeric"] as const;

  private readonly sigma: number;
  private readonly min: number | undefined;
  private readonly max: number | undefined;

  constructor(params: Record<string, unknown> = {}) {
    super(params);
    this.sigma = Math.max(
      0,
      numberParam(GaussianMutation.paramsSchema, params, "sigma", 0.5),
    );
    const mn = params["min"];
    const mx = params["max"];
    this.min = typeof mn === "number" && Number.isFinite(mn) ? mn : undefined;
    this.max = typeof mx === "number" && Number.isFinite(mx) ? mx : undefined;
  }

  /** Box–Muller. */
  private gauss(rng: RandomSource): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = rng.next();
    while (v === 0) v = rng.next();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  override mutate(genome: unknown, rate: number, rng: RandomSource): unknown {
    if (!Array.isArray(genome)) {
      throw new TypeError("GaussianMutation: array genome required");
    }
    const g = genome as number[];
    for (let i = 0; i < g.length; i++) {
      if (rng.next() < rate) {
        g[i] = (g[i] as number) + this.gauss(rng) * this.sigma;
        if (this.min !== undefined && (g[i] as number) < this.min) g[i] = this.min;
        if (this.max !== undefined && (g[i] as number) > this.max) g[i] = this.max;
      }
    }
    return g;
  }
}
