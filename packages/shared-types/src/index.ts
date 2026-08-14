/**
 * @genebaer/shared-types — the wire protocol + DTOs shared by server and web.
 * Pure TypeScript: no runtime deps, no zod (avoids duplicated-type drift in the frontend bundle).
 */

// ---------- JSON Schema (subset sufficient for UI auto-rendering) ----------

export type JSONSchema =
  | {
      type: "number" | "integer";
      minimum?: number;
      maximum?: number;
      default?: number;
      title?: string;
      description?: string;
    }
  | {
      type: "string";
      default?: string;
      title?: string;
      description?: string;
      enum?: string[];
      minLength?: number;
      maxLength?: number;
    }
  | { type: "boolean"; default?: boolean; title?: string; description?: string }
  | {
      type: "object";
      properties: Record<string, JSONSchema>;
      required?: string[];
      title?: string;
      description?: string;
    }
  | { type: "array"; items: JSONSchema; title?: string; description?: string };

// ---------- Registry metadata (served to the UI) ----------

export type OperatorKind =
  | "encoding"
  | "problem"
  | "selection"
  | "crossover"
  | "mutation"
  | "termination";

export interface OperatorMeta {
  /** Registration id used in RunConfig, e.g. "tournament". */
  id: string;
  kind: OperatorKind;
  displayName: string;
  description: string;
  /** JSON Schema describing the operator's params object. */
  paramsSchema: Record<string, JSONSchema>;
  /** Encoding ids this operator works with; absent/empty = encoding-agnostic. */
  compatibleEncodings?: string[];
}

// ---------- Run configuration ----------

/** Reference to a registered operator + its parameter object. */
export interface OperatorRef {
  id: string;
  params?: Record<string, unknown>;
}

/**
 * Declarative description of one GA run. Everything is a registry id +
 * params, so configs are JSON-serializable end to end.
 */
export interface RunConfig {
  problem: OperatorRef;
  encoding: OperatorRef;
  selection: OperatorRef;
  crossover: OperatorRef;
  mutation: OperatorRef;
  /** Per-gene (or per-call, operator-defined) mutation probability/rate. */
  mutationRate: number;
  populationSize: number;
  /** Number of fittest individuals cloned verbatim into each next generation. */
  elitism: number;
  /** Stop when ANY listed condition fires. */
  termination: OperatorRef[];
  /** Seed for the run's RNG. Same seed + config ⇒ identical run. */
  seed: number;
}

// ---------- Stats / events ----------

export interface GenerationStats {
  generation: number;
  bestFitness: number;
  meanFitness: number;
  medianFitness: number;
  worstFitness: number;
  stdDev: number;
  /** Encoding-specific mean pairwise distance between individuals. */
  diversity: number;
  /** Serialized best genome (unknown shape — depends on encoding). */
  bestGenome: unknown;
  /** Wall-clock ms spent evaluating/evolving this generation. */
  elapsedMs: number;
}

export type RunStatus =
  | "pending"
  | "running"
  | "paused"
  | "finished"
  | "stopped"
  | "error";

export interface RunSummary {
  id: string;
  status: RunStatus;
  config: RunConfig;
  createdAt: number;
  finishedAt: number | null;
  finalBestFitness: number | null;
  currentGeneration: number;
  /**
   * Why the run reached its terminal status — the same text the `finished` WS
   * message carries, but persisted. Absent while a run is still live, and for
   * rows written before this field existed.
   */
  stopReason?: string;
}

// ---------- REST DTOs ----------

export interface CreateRunRequest {
  config: RunConfig;
}

export interface CreateRunResponse {
  runId: string;
}

export type RunControlAction = "pause" | "resume" | "step" | "stop";

export interface RunControlRequest {
  action: RunControlAction;
}

export interface RunDetail extends RunSummary {
  stats: GenerationStats[];
}

// ---------- WebSocket protocol ----------

/** Server → client messages, keyed by runId (client subscribes per-run). */
export type WsServerMessage =
  | { type: "generation"; runId: string; stats: GenerationStats }
  | { type: "best"; runId: string; generation: number; genome: unknown; fitness: number }
  | {
      type: "finished";
      runId: string;
      reason: string;
      finalBestFitness: number;
      generations: number;
    }
  | { type: "status"; runId: string; status: RunStatus };

/** Client → server messages. */
export type WsClientMessage =
  | { type: "subscribe"; runId: string }
  | { type: "unsubscribe"; runId: string };
