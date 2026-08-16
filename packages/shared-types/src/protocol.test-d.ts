/**
 * Type-level contract tests.
 *
 * This package emits no runtime code, so there is nothing to assert at
 * runtime. What can break is the *contract*: server and web both compile
 * against these types, and a change that silently widens or narrows one of
 * them breaks the wire protocol without any test going red.
 *
 * Run via `vitest --typecheck`; assertions are checked by tsc, not executed.
 */
import { assertType, describe, expectTypeOf, it } from "vitest";
import type {
  EvalJobPayload,
  GenerationStats,
  JSONSchema,
  OperatorKind,
  OperatorMeta,
  RunConfig,
  RunControlAction,
  RunDetail,
  RunStatus,
  RunSummary,
  WorkerCapability,
  WorkerClientMessage,
  WorkerServerMessage,
  WsClientMessage,
  WsServerMessage,
} from "./index.js";

describe("OperatorKind", () => {
  it("covers exactly the seven registry kinds", () => {
    expectTypeOf<OperatorKind>().toEqualTypeOf<
      | "encoding"
      | "problem"
      | "selection"
      | "crossover"
      | "mutation"
      | "termination"
      | "evaluator"
    >();
  });

  it("rejects a kind the registry does not serve", () => {
    // @ts-expect-error "fitness" is not an operator kind
    assertType<OperatorKind>("fitness");
  });
});

describe("RunStatus", () => {
  it("covers every lifecycle state the UI switches on", () => {
    expectTypeOf<RunStatus>().toEqualTypeOf<
      "pending" | "running" | "paused" | "finished" | "stopped" | "error"
    >();
  });

  it("keeps control actions distinct from statuses", () => {
    expectTypeOf<RunControlAction>().toEqualTypeOf<
      "pause" | "resume" | "step" | "stop"
    >();
    // @ts-expect-error "paused" is a status, not an action a client can send
    assertType<RunControlAction>("paused");
  });
});

describe("RunConfig", () => {
  it("requires every operator slot — a run cannot omit one", () => {
    expectTypeOf<RunConfig>().toHaveProperty("problem");
    expectTypeOf<RunConfig>().toHaveProperty("encoding");
    expectTypeOf<RunConfig>().toHaveProperty("selection");
    expectTypeOf<RunConfig>().toHaveProperty("crossover");
    expectTypeOf<RunConfig>().toHaveProperty("mutation");
  });

  it("keeps seed numeric so a run stays reproducible", () => {
    expectTypeOf<RunConfig["seed"]>().toEqualTypeOf<number>();
  });

  it("accepts multiple termination conditions", () => {
    expectTypeOf<RunConfig["termination"]>().toBeArray();
  });

  it("allows an operator reference without params", () => {
    assertType<RunConfig["problem"]>({ id: "one-max" });
  });

  it("keeps evaluator OPTIONAL so pre-existing configs and presets still load", () => {
    // A config written before evaluators existed must remain valid: these are
    // persisted as config_json and in browser localStorage, and requiring the
    // field would reject every one of them.
    assertType<RunConfig>({
      problem: { id: "one-max" },
      encoding: { id: "binary" },
      selection: { id: "tournament" },
      crossover: { id: "one-point" },
      mutation: { id: "bit-flip" },
      mutationRate: 0.01,
      populationSize: 100,
      elitism: 2,
      termination: [{ id: "max-generations" }],
      seed: 1,
    });
  });

  it("accepts an explicit evaluator reference", () => {
    assertType<NonNullable<RunConfig["evaluator"]>>({
      id: "local",
      params: { threads: 4 },
    });
  });

  it("rejects a config missing a required slot", () => {
    assertType<RunConfig>(
      // @ts-expect-error missing encoding, selection, crossover, mutation, and more
      { problem: { id: "one-max" } },
    );
  });
});

describe("GenerationStats", () => {
  it("keeps bestGenome opaque — its shape depends on the encoding", () => {
    expectTypeOf<GenerationStats["bestGenome"]>().toBeUnknown();
  });

  it("reports every summary statistic as a plain number", () => {
    expectTypeOf<GenerationStats["bestFitness"]>().toEqualTypeOf<number>();
    expectTypeOf<GenerationStats["meanFitness"]>().toEqualTypeOf<number>();
    expectTypeOf<GenerationStats["medianFitness"]>().toEqualTypeOf<number>();
    expectTypeOf<GenerationStats["worstFitness"]>().toEqualTypeOf<number>();
    expectTypeOf<GenerationStats["stdDev"]>().toEqualTypeOf<number>();
    expectTypeOf<GenerationStats["diversity"]>().toEqualTypeOf<number>();
  });
});

describe("RunSummary / RunDetail", () => {
  it("models 'not finished yet' as null rather than absent", () => {
    expectTypeOf<RunSummary["finishedAt"]>().toEqualTypeOf<number | null>();
    expectTypeOf<RunSummary["finalBestFitness"]>().toEqualTypeOf<number | null>();
  });

  it("extends the summary with the full stats history", () => {
    expectTypeOf<RunDetail>().toMatchTypeOf<RunSummary>();
    expectTypeOf<RunDetail["stats"]>().toEqualTypeOf<GenerationStats[]>();
  });
});

describe("WebSocket protocol", () => {
  it("discriminates server messages on `type`", () => {
    expectTypeOf<WsServerMessage["type"]>().toEqualTypeOf<
      "generation" | "best" | "finished" | "status" | "annotation"
    >();
  });

  it("narrows a server message to its own payload", () => {
    const msg = {} as WsServerMessage;
    if (msg.type === "generation") {
      expectTypeOf(msg.stats).toEqualTypeOf<GenerationStats>();
    }
    if (msg.type === "finished") {
      expectTypeOf(msg.reason).toEqualTypeOf<string>();
      expectTypeOf(msg.generations).toEqualTypeOf<number>();
    }
  });

  it("tags every server message with the run it belongs to", () => {
    expectTypeOf<WsServerMessage["runId"]>().toEqualTypeOf<string>();
  });

  it("limits clients to subscribe and unsubscribe", () => {
    expectTypeOf<WsClientMessage["type"]>().toEqualTypeOf<"subscribe" | "unsubscribe">();
    // @ts-expect-error clients cannot push generation data to the server
    assertType<WsClientMessage>({ type: "generation", runId: "r1" });
  });
});

describe("JSONSchema", () => {
  it("admits each param type the UI can render a field for", () => {
    assertType<JSONSchema>({ type: "number", minimum: 0, maximum: 1, default: 0.5 });
    assertType<JSONSchema>({ type: "integer", default: 10 });
    assertType<JSONSchema>({ type: "string", enum: ["a", "b"] });
    assertType<JSONSchema>({ type: "boolean", default: false });
    assertType<JSONSchema>({ type: "array", items: { type: "number" } });
    assertType<JSONSchema>({ type: "object", properties: { n: { type: "number" } } });
  });

  it("rejects a type the UI has no field renderer for", () => {
    // @ts-expect-error "null" is not a supported param type
    assertType<JSONSchema>({ type: "null" });
  });

  it("keeps enum on string schemas only", () => {
    // @ts-expect-error numeric schemas have no enum member
    assertType<JSONSchema>({ type: "number", enum: [1, 2] });
  });

  it("describes operator params as a schema per key", () => {
    expectTypeOf<OperatorMeta["paramsSchema"]>().toEqualTypeOf<
      Record<string, JSONSchema>
    >();
  });
});

describe("Worker protocol", () => {
  it("discriminates worker-bound messages on `type`", () => {
    expectTypeOf<WorkerServerMessage["type"]>().toEqualTypeOf<
      "worker.registered" | "worker.lease" | "worker.idle" | "worker.leaseLost"
    >();
    expectTypeOf<WorkerClientMessage["type"]>().toEqualTypeOf<
      | "worker.register"
      | "worker.claim"
      | "worker.score"
      | "worker.heartbeat"
      | "worker.fail"
    >();
  });

  it("narrows a lease message to its jobs", () => {
    const msg = {} as WorkerServerMessage;
    if (msg.type === "worker.lease") {
      expectTypeOf(msg.jobs).toEqualTypeOf<EvalJobPayload[]>();
      expectTypeOf(msg.expiresAt).toEqualTypeOf<number>();
    }
  });

  it("carries a version on every capability, since scores across versions are not comparable", () => {
    expectTypeOf<WorkerCapability["version"]>().toEqualTypeOf<string>();
    // @ts-expect-error a capability without a version is not a capability
    assertType<WorkerCapability>({ evaluatorId: "clip-similarity" });
  });

  it("keeps a job's population index numeric so scores reassemble positionally", () => {
    expectTypeOf<EvalJobPayload["index"]>().toEqualTypeOf<number>();
    expectTypeOf<EvalJobPayload["genome"]>().toBeUnknown();
  });

  it("requires a leaseId on every submission, so an expired claim is detectable", () => {
    assertType<WorkerClientMessage>({
      type: "worker.score",
      leaseId: "l1",
      evaluationId: "e1",
      index: 0,
      score: 0.5,
    });
    // @ts-expect-error a score without its lease cannot be validated
    assertType<WorkerClientMessage>({ type: "worker.score", evaluationId: "e1", index: 0, score: 1 });
  });

  it("does not let a worker masquerade as a run subscriber", () => {
    // @ts-expect-error worker messages are a separate channel from run subscriptions
    assertType<WsClientMessage>({ type: "worker.claim", max: 4 });
  });
});

describe("annotations", () => {
  it("adds annotation to the server message union", () => {
    expectTypeOf<WsServerMessage["type"]>().toEqualTypeOf<
      "generation" | "best" | "finished" | "status" | "annotation"
    >();
  });

  it("carries TEXT, keeping it structurally distinct from fitness", () => {
    // A caption must never be able to stand in for a score.
    const msg = {} as WsServerMessage;
    if (msg.type === "annotation") {
      expectTypeOf(msg.text).toEqualTypeOf<string>();
      expectTypeOf(msg.generation).toEqualTypeOf<number>();
      expectTypeOf(msg.kind).toEqualTypeOf<"caption">();
    }
  });

  it("rejects an annotation without its text", () => {
    // @ts-expect-error an annotation with no text says nothing
    assertType<WsServerMessage>({ type: "annotation", runId: "r", generation: 1, kind: "caption" });
  });
});

describe("OperatorMeta.version", () => {
  it("is optional, because only evaluators carry a contract version", () => {
    assertType<OperatorMeta>({
      id: "one-max",
      kind: "problem",
      displayName: "OneMax",
      description: "d",
      paramsSchema: {},
    });
  });

  it("is a string when present, so a worker can register with it verbatim", () => {
    assertType<OperatorMeta>({
      id: "clip-similarity",
      kind: "evaluator",
      displayName: "CLIP",
      description: "d",
      paramsSchema: {},
      version: "clip-vit-base-patch32.2",
    });
    const base = {
      id: "clip-similarity",
      kind: "evaluator" as const,
      displayName: "CLIP",
      description: "d",
      paramsSchema: {},
    };
    // @ts-expect-error a version is a contract string, never a number
    assertType<OperatorMeta>({ ...base, version: 2 });
  });
});
