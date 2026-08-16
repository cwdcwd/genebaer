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
  | "termination"
  /**
   * How fitness is computed, as opposed to what is being optimized. The
   * problem defines the objective; the evaluator defines where and how that
   * objective is scored — in-process, on worker threads, or by remote workers.
   */
  | "evaluator";

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
  /**
   * For encodings: which param sets the genome size ("length", "dimensions").
   *
   * Lets a client size an encoding to a problem's requirement without a
   * hardcoded per-encoding key map, which would go stale silently the moment
   * someone adds an encoding.
   */
  sizeParam?: string;
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
  /**
   * How fitness is computed. OPTIONAL on purpose: omitting it means "local",
   * i.e. scored in-process by calling the problem directly, which is what every
   * run did before evaluators existed. Configs are validated by zod, persisted
   * as `config_json`, and saved to browser localStorage as presets — making
   * this required would reject every stored run and every saved preset.
   */
  evaluator?: OperatorRef;
  /**
   * Seed for the run's RNG. Same seed + config ⇒ identical run, *provided the
   * evaluator is deterministic*. A model-backed evaluator generally is not; a
   * score cache is what restores exact replay in that case.
   */
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

/** Reply from POST /api/problems/:id/genome-length. */
export interface GenomeLengthResponse {
  /** Genes the problem needs, or null when any length works. */
  genomeLength: number | null;
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
  | { type: "status"; runId: string; status: RunStatus }
  /**
   * A human-readable note about a generation - currently a VLM caption of the
   * best genome. Explicitly NOT fitness: it is a progress check for a person,
   * never an input to selection.
   */
  | {
      type: "annotation";
      runId: string;
      generation: number;
      kind: "caption";
      text: string;
    };

/** Client → server messages. */
export type WsClientMessage =
  | { type: "subscribe"; runId: string }
  | { type: "unsubscribe"; runId: string };

// ---------- Worker protocol ----------

/**
 * A scoring contract a worker can fulfil.
 *
 * The version is part of the identity, not decoration: scores from two model
 * versions are not comparable, and mixing them inside one run would distort
 * the fitness landscape mid-flight in a way no test would catch.
 */
export interface WorkerCapability {
  /** Evaluator id, e.g. "clip-similarity". */
  evaluatorId: string;
  version: string;
}

/** One genome for a worker to score. */
export interface EvalJobPayload {
  evaluationId: string;
  /** Population index. Scores are reassembled by this, never by arrival. */
  index: number;
  genome: unknown;
  evaluatorId: string;
  params: Record<string, unknown>;
}

/** Server → worker. */
export type WorkerServerMessage =
  | { type: "worker.registered"; workerId: string; leaseMs: number }
  | {
      type: "worker.lease";
      leaseId: string;
      expiresAt: number;
      jobs: EvalJobPayload[];
    }
  /** No job currently matches this worker's capabilities. */
  | { type: "worker.idle" }
  /**
   * The worker's lease is gone — expired, or released because it dropped off.
   * Its jobs have been re-dispatched, so it must stop working and re-claim.
   */
  | { type: "worker.leaseLost"; leaseId: string; reason: string };

/** Worker → server. */
export type WorkerClientMessage =
  | { type: "worker.register"; capabilities: WorkerCapability[] }
  | { type: "worker.claim"; max: number }
  | { type: "worker.score"; leaseId: string; evaluationId: string; index: number; score: number }
  | { type: "worker.heartbeat"; leaseId: string }
  /** This worker cannot score the job at all; fail the whole evaluation. */
  | { type: "worker.fail"; leaseId: string; evaluationId: string; reason: string };
