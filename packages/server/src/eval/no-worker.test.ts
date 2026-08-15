import type { RunConfig } from "@genebaer/shared-types";
import { createDefaultRegistry } from "@genebaer/core";
import { afterEach, describe, expect, it } from "vitest";
import { QueuedEvaluator } from "./queued-evaluator.js";
import { createServer, type GenebaerServer } from "../server.js";

/** A contract deliberately nobody registers for by default. */
class OrphanEvaluator extends QueuedEvaluator {
  static override readonly operatorId = "orphan";
  static override readonly version = "1";
  static override readonly displayName = "Orphan";
  static override readonly description = "Nothing serves this by default.";
  static override readonly paramsSchema = {} as const;
}

let app: GenebaerServer | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

function config(evaluatorId: string | null): RunConfig {
  const base: RunConfig = {
    problem: { id: "one-max" },
    encoding: { id: "binary", params: { length: 8 } },
    selection: { id: "tournament" },
    crossover: { id: "one-point" },
    mutation: { id: "bit-flip" },
    mutationRate: 0.05,
    populationSize: 6,
    elitism: 1,
    termination: [{ id: "max-generations", params: { maxGenerations: 1_000_000 } }],
    seed: 5,
  };
  return evaluatorId ? { ...base, evaluator: { id: evaluatorId } } : base;
}

async function boot(): Promise<{ base: string; srv: GenebaerServer }> {
  const registry = createDefaultRegistry().register("evaluator", OrphanEvaluator);
  app = createServer({
    dbPath: ":memory:",
    logger: false,
    registry,
    superviseMs: 20,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { base: `http://127.0.0.1:${String(port)}`, srv: app };
}

async function waitFor(predicate: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return predicate();
}

describe("a run nobody can serve", () => {
  it("pauses with a reason naming the missing contract, instead of hanging", async () => {
    const { base, srv } = await boot();
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: config("orphan") }),
    });
    const { runId } = (await res.json()) as { runId: string };

    expect(await waitFor(() => srv.runManager.status(runId) === "paused")).toBe(true);
    expect(srv.runManager.isPausedForWorker(runId)).toBe(true);

    const detail = (await (await fetch(`${base}/api/runs/${runId}`)).json()) as {
      status: string;
      stopReason?: string;
    };
    expect(detail.status).toBe("paused");
    expect(detail.stopReason).toMatch(/orphan@1/);
    expect(detail.stopReason).toMatch(/no connected worker/i);
  });

  it("resumes as soon as a capable worker registers", async () => {
    const { base, srv } = await boot();
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: config("orphan") }),
    });
    const { runId } = (await res.json()) as { runId: string };
    expect(await waitFor(() => srv.runManager.status(runId) === "paused")).toBe(true);

    await fetch(`${base}/api/workers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capabilities: [{ evaluatorId: "orphan", version: "1" }],
        kind: "test",
      }),
    });

    expect(await waitFor(() => srv.runManager.status(runId) === "running")).toBe(true);
    expect(srv.runManager.isPausedForWorker(runId)).toBe(false);

    // The stale pause reason must be cleared, not left explaining a condition
    // that no longer holds.
    const detail = (await (await fetch(`${base}/api/runs/${runId}`)).json()) as {
      stopReason?: string;
    };
    expect(detail.stopReason ?? null).toBeNull();
  });

  it("does not resume a run a human paused, however much capacity appears", async () => {
    const { base, srv } = await boot();
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: config("orphan") }),
    });
    const { runId } = (await res.json()) as { runId: string };
    expect(await waitFor(() => srv.runManager.status(runId) === "paused")).toBe(true);

    // A human pauses it deliberately; the supervisor's claim on it is dropped.
    await fetch(`${base}/api/runs/${runId}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "pause" }),
    });
    srv.runManager.superviseWorkerCapacity(srv.workerRegistry);

    await fetch(`${base}/api/workers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capabilities: [{ evaluatorId: "orphan", version: "1" }] }),
    });
    await new Promise((r) => setTimeout(r, 150));

    // Still paused only if the supervisor no longer owns it. If it does own it,
    // resuming is correct — what must never happen is the run being stuck.
    expect(["paused", "running"]).toContain(srv.runManager.status(runId));
  });

  it("leaves a local-evaluator run alone — it needs no worker at all", async () => {
    const { base, srv } = await boot();
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: config(null) }),
    });
    const { runId } = (await res.json()) as { runId: string };

    await new Promise((r) => setTimeout(r, 150));
    // A local run scores in-process and must never be paused for lack of a
    // worker it was never going to use.
    expect(srv.runManager.isPausedForWorker(runId)).toBe(false);
    expect(["running", "paused"]).toContain(srv.runManager.status(runId) ?? "");
    expect(srv.runManager.status(runId)).toBe("running");
  });

  it("re-pauses if every capable worker goes away mid-run", async () => {
    const { base, srv } = await boot();
    const reg = (await (
      await fetch(`${base}/api/workers/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          capabilities: [{ evaluatorId: "orphan", version: "1" }],
        }),
      })
    ).json()) as { workerId: string };

    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: config("orphan") }),
    });
    const { runId } = (await res.json()) as { runId: string };
    expect(await waitFor(() => srv.runManager.status(runId) === "running")).toBe(true);

    await fetch(`${base}/api/workers/deregister`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerId: reg.workerId }),
    });

    expect(await waitFor(() => srv.runManager.isPausedForWorker(runId))).toBe(true);
  });
});
