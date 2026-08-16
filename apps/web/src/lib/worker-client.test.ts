import { describe, expect, it, vi } from "vitest";
import type { WorkerClientMessage, EvalJobPayload } from "@genebaer/shared-types";
import { WorkerClient, parseServerMessage, type WorkerClientView } from "./worker-client";

function job(index: number): EvalJobPayload {
  return {
    evaluationId: "e1",
    index,
    genome: { width: 2, height: 2, channels: 3, rgb: new Array<number>(12).fill(0) },
    evaluatorId: "clip-similarity",
    params: { prompt: "a red circle" },
  };
}

function make(score: (j: EvalJobPayload) => Promise<number> = () => Promise.resolve(0.5)) {
  const sent: WorkerClientMessage[] = [];
  const views: WorkerClientView[] = [];
  const client = new WorkerClient({
    capabilities: [{ evaluatorId: "clip-similarity", version: "1" }],
    batchSize: 4,
    score,
    send: (m) => sent.push(m),
    onChange: (v) => views.push(v),
  });
  return { client, sent, views };
}

describe("parseServerMessage", () => {
  it("accepts worker frames and rejects everything else", () => {
    expect(parseServerMessage('{"type":"worker.idle"}')).toEqual({ type: "worker.idle" });
    expect(parseServerMessage("not json")).toBeNull();
    expect(parseServerMessage("null")).toBeNull();
    // Run-subscription traffic shares the same origin; a stray frame must not
    // be mistaken for worker work.
    expect(parseServerMessage('{"type":"generation","runId":"r"}')).toBeNull();
  });
});

describe("registration", () => {
  it("registers on start and claims once registered", () => {
    const { client, sent } = make();
    client.start();
    expect(sent[0]).toEqual({
      type: "worker.register",
      capabilities: [{ evaluatorId: "clip-similarity", version: "1" }],
    });

    client.handle({ type: "worker.registered", workerId: "w1", leaseMs: 30_000 });
    expect(client.snapshot().workerId).toBe("w1");
    expect(sent[1]).toEqual({ type: "worker.claim", max: 4 });
  });

  it("will not claim before it has a worker id", () => {
    const { client, sent } = make();
    client.claim();
    expect(sent).toHaveLength(0);
  });
});

describe("scoring a lease", () => {
  it("scores every job and reports each score", async () => {
    const { client, sent } = make();
    client.start();
    client.handle({ type: "worker.registered", workerId: "w1", leaseMs: 30_000 });
    client.handle({
      type: "worker.lease",
      leaseId: "L1",
      expiresAt: Date.now() + 30_000,
      jobs: [job(0), job(1)],
    });
    await vi.waitFor(() => expect(client.snapshot().completed).toBe(2));

    const scores = sent.filter((m) => m.type === "worker.score");
    expect(scores).toHaveLength(2);
    expect(scores.every((s) => s.type === "worker.score" && s.leaseId === "L1")).toBe(true);
  });

  it("claims again after finishing a batch, so it keeps working", async () => {
    const { client, sent } = make();
    client.start();
    client.handle({ type: "worker.registered", workerId: "w1", leaseMs: 30_000 });
    client.handle({
      type: "worker.lease",
      leaseId: "L1",
      expiresAt: 0,
      jobs: [job(0)],
    });
    await vi.waitFor(() =>
      expect(sent.filter((m) => m.type === "worker.claim")).toHaveLength(2),
    );
  });

  it("reports failure rather than going quiet, which would cost a lease timeout", async () => {
    const { client, sent } = make(() => Promise.reject(new Error("no WebGPU here")));
    client.start();
    client.handle({ type: "worker.registered", workerId: "w1", leaseMs: 30_000 });
    client.handle({ type: "worker.lease", leaseId: "L1", expiresAt: 0, jobs: [job(0)] });

    await vi.waitFor(() => expect(client.snapshot().state).toBe("error"));
    const fail = sent.find((m) => m.type === "worker.fail");
    expect(fail).toBeDefined();
    if (fail?.type === "worker.fail") expect(fail.reason).toMatch(/no WebGPU/);
    expect(client.snapshot().error).toMatch(/no WebGPU/);
  });
});

describe("losing a lease mid-batch", () => {
  it("abandons the rest instead of scoring work someone else now owns", async () => {
    // The point of the whole lease mechanism, from the worker's side. A
    // backgrounded tab can have its jobs re-dispatched while it is still
    // grinding; continuing would spend inference for nothing.
    let resolveFirst!: (n: number) => void;
    const { client, sent } = make(
      (j) =>
        j.index === 0
          ? new Promise<number>((r) => {
              resolveFirst = r;
            })
          : Promise.resolve(0.5),
    );

    client.start();
    client.handle({ type: "worker.registered", workerId: "w1", leaseMs: 30_000 });
    client.handle({
      type: "worker.lease",
      leaseId: "L1",
      expiresAt: 0,
      jobs: [job(0), job(1), job(2)],
    });

    // The server re-dispatches while job 0 is still in flight.
    client.handle({
      type: "worker.leaseLost",
      leaseId: "L1",
      reason: "expired",
    });
    resolveFirst(0.9);

    await vi.waitFor(() => expect(client.snapshot().abandoned).toBe(1));
    // Nothing was submitted for a lease that is no longer ours.
    expect(sent.filter((m) => m.type === "worker.score")).toHaveLength(0);
    expect(client.snapshot().completed).toBe(0);
  });

  it("ignores a leaseLost for a lease it is not working", async () => {
    const { client } = make();
    client.start();
    client.handle({ type: "worker.registered", workerId: "w1", leaseMs: 30_000 });
    client.handle({ type: "worker.lease", leaseId: "L1", expiresAt: 0, jobs: [job(0)] });
    await vi.waitFor(() => expect(client.snapshot().completed).toBe(1));

    client.handle({ type: "worker.leaseLost", leaseId: "OTHER", reason: "expired" });
    expect(client.snapshot().abandoned).toBe(0);
  });
});

describe("lifecycle reporting", () => {
  it("moves through states a person can read", async () => {
    const { client, views } = make();
    client.start();
    expect(views[0]?.state).toBe("registering");
    client.handle({ type: "worker.registered", workerId: "w1", leaseMs: 30_000 });
    expect(views.some((v) => v.state === "waiting")).toBe(true);

    client.handle({ type: "worker.lease", leaseId: "L1", expiresAt: 0, jobs: [job(0)] });
    await vi.waitFor(() => expect(views.some((v) => v.state === "scoring")).toBe(true));
  });

  it("clears its identity on stop, so a reconnect re-registers", () => {
    const { client } = make();
    client.start();
    client.handle({ type: "worker.registered", workerId: "w1", leaseMs: 30_000 });
    client.stop();
    expect(client.snapshot().workerId).toBeNull();
    expect(client.snapshot().state).toBe("idle");
  });
});
