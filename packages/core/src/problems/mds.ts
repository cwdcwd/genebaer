import type { JSONSchema } from "@genebaer/shared-types";
import { FitnessProblem, type VisualFrame } from "../operators/problem/base.js";
import { numberParam } from "../random.js";

export interface MdsGraph {
  /** Number of vertices, labelled 0..n-1. */
  n: number;
  /** Undirected edges as [u, v] pairs. */
  edges: Array<[number, number]>;
}

const PARAMS_SCHEMA: Record<string, JSONSchema> = {
  graph: {
    type: "string",
    enum: ["petersen", "cycle7"],
    default: "petersen",
    title: "Graph",
  },
  penalty: {
    type: "number",
    minimum: 1,
    default: 100,
    title: "Penalty per undominated vertex",
  },
};

/**
 * Minimum Dominating Set: find the smallest D ⊆ V such that every vertex is
 * either in D or adjacent to a vertex in D.
 *
 * Genome: binary, 1 = vertex in the dominating set.
 * Fitness = −(|D| + penalty × (number of undominated vertices)),
 * so valid dominating sets always beat invalid ones of the same size,
 * and smaller valid sets beat larger ones. Optimum = −γ(G).
 *
 * Ships with two sample graphs: "petersen" (γ=3) and "cycle7" (γ=⌈7/3⌉=3).
 */
export class MinimumDominatingSet extends FitnessProblem<number[]> {
  static override readonly operatorId = "mds";
  static override readonly displayName = "Minimum dominating set";
  static override readonly description =
    "Find the smallest dominating set in a graph. Binary genome: 1 = vertex in set.";
  static override readonly paramsSchema: Record<string, JSONSchema> = PARAMS_SCHEMA;
  static override readonly compatibleEncodings = ["binary"] as const;

  readonly graph: MdsGraph;
  readonly penalty: number;

  constructor(params: Record<string, unknown> = {}) {
    super(params);
    // An absent param takes the default; a PRESENT but unrecognised one is a
    // typo, and silently substituting Petersen would run a different problem
    // than the one asked for while looking entirely healthy. Found by the
    // genome-length endpoint's error path (genebaer-7tu).
    const name = params["graph"];
    if (name === undefined || name === "petersen") this.graph = petersenGraph();
    else if (name === "cycle7") this.graph = cycleGraph(7);
    else {
      throw new RangeError(
        `MinimumDominatingSet: unknown graph ${JSON.stringify(name)}; ` +
          `expected 'petersen' or 'cycle7'`,
      );
    }
    this.penalty = Math.max(
      1,
      numberParam(MinimumDominatingSet.paramsSchema, params, "penalty", 100),
    );
  }

  /** One gene per vertex: the genome IS the subset indicator. */
  override get requiredGenomeLength(): number {
    return this.graph.n;
  }

  override evaluate(genome: number[]): number {
    const n = this.graph.n;
    // A short genome would read `undefined` for the missing vertices and
    // silently treat them as "not in the set" — a smaller dominating set that
    // does not dominate, scored as if it were valid.
    if (genome.length !== n) {
      throw new RangeError(
        `MinimumDominatingSet: genome has ${String(genome.length)} genes but the ` +
          `graph has ${String(n)} vertices.`,
      );
    }
    const dominated = new Array<boolean>(n).fill(false);
    let setSize = 0;
    for (let i = 0; i < n; i++) {
      if (genome[i] === 1) {
        setSize++;
        dominated[i] = true;
      }
    }
    for (const [u, v] of this.graph.edges) {
      if (genome[u] === 1) dominated[v] = true;
      if (genome[v] === 1) dominated[u] = true;
    }
    let undominated = 0;
    for (let i = 0; i < n; i++) if (!dominated[i]) undominated++;
    return -(setSize + this.penalty * undominated);
  }

  override visualize(best: number[]): VisualFrame {
    const selected: number[] = [];
    for (let i = 0; i < this.graph.n; i++) if (best[i] === 1) selected.push(i);
    return {
      problemId: MinimumDominatingSet.operatorId,
      data: { graph: this.graph, selected },
    };
  }
}

/** Petersen graph: 10 vertices, γ = 3. */
export function petersenGraph(): MdsGraph {
  const edges: Array<[number, number]> = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 0],
    [5, 7],
    [7, 9],
    [9, 6],
    [6, 8],
    [8, 5],
    [0, 5],
    [1, 6],
    [2, 7],
    [3, 8],
    [4, 9],
  ];
  return { n: 10, edges };
}

/** Cycle graph C_n, γ = ⌈n/3⌉. */
export function cycleGraph(n: number): MdsGraph {
  const edges: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) edges.push([i, (i + 1) % n]);
  return { n, edges };
}
