import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { FitnessEvaluator } from "@genebaer/core";
import { createServer, type GenebaerServer } from "./server.js";
import { createServerRegistry } from "./registry.js";
import type {
  CreateRunResponse,
  RunConfig,
  RunDetail,
  RunSummary,
  WsServerMessage,
} from "@genebaer/shared-types";

let app: GenebaerServer | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

function oneMaxConfig(): RunConfig {
  return {
    problem: { id: "one-max" },
    encoding: { id: "binary", params: { length: 16 } },
    selection: { id: "tournament" },
    crossover: { id: "uniform" },
    mutation: { id: "bit-flip" },
    mutationRate: 0.02,
    populationSize: 40,
    elitism: 2,
    termination: [
      { id: "max-generations", params: { maxGenerations: 200 } },
      { id: "target-fitness", params: { target: 16 } },
    ],
    seed: 42,
  };
}

async function bootServer(): Promise<{ app: GenebaerServer; baseUrl: string; wsUrl: string }> {
  app = createServer({ dbPath: ":memory:", logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    app,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
  };
}

describe("genebaer server", () => {
  it("GET /api/operators lists built-ins", async () => {
    const { baseUrl } = await bootServer();
    const res = await fetch(`${baseUrl}/api/operators`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; kind: string }>;
    const kinds = new Set(body.map((m) => m.kind));
    for (const k of ["encoding", "problem", "selection", "crossover", "mutation", "termination"]) {
      expect(kinds.has(k)).toBe(true);
    }
    expect(body.some((m) => m.id === "tournament")).toBe(true);
    expect(body.some((m) => m.id === "one-max")).toBe(true);
  });

  it("full lifecycle: create → stream → finish → history", async () => {
    const { baseUrl, wsUrl } = await bootServer();

    // Subscribe BEFORE creating the run so we don't race a fast finish.
    const messages: WsServerMessage[] = [];
    let resolveFinished!: () => void;
    const finished = new Promise<void>((resolve, reject) => {
      resolveFinished = resolve;
      setTimeout(() => reject(new Error("WS timeout")), 15_000);
    });
    const ws = new WebSocket(wsUrl);
    let runId = "";
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    ws.on("message", (raw: Buffer) => {
      const msg = JSON.parse(raw.toString()) as WsServerMessage;
      if (msg.runId !== runId) return;
      messages.push(msg);
      if (msg.type === "finished") {
        ws.close();
        resolveFinished();
      }
    });

    const res = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: oneMaxConfig() }),
    });
    expect(res.status).toBe(200);
    runId = ((await res.json()) as CreateRunResponse).runId;
    ws.send(JSON.stringify({ type: "subscribe", runId }));

    // The run is fast; if we somehow missed 'finished', poll REST as fallback.
    const wsFinished = await Promise.race([
      finished.then(() => true),
      (async () => {
        for (let i = 0; i < 30; i++) {
          const r = await fetch(`${baseUrl}/api/runs/${runId}`);
          const d = (await r.json()) as { status: string };
          if (d.status === "finished") return false;
          await new Promise((rr) => setTimeout(rr, 100));
        }
        return false;
      })(),
    ]);
    void wsFinished;

    const generations = messages.filter((m) => m.type === "generation");
    expect(generations.length).toBeGreaterThan(0);
    // generation indices should be non-decreasing
    for (let i = 1; i < generations.length; i++) {
      const prev = (generations[i - 1] as { stats: { generation: number } }).stats.generation;
      const cur = (generations[i] as { stats: { generation: number } }).stats.generation;
      expect(cur).toBeGreaterThan(prev);
    }
    const fin = messages.find((m) => m.type === "finished");
    expect(fin).toBeDefined();

    // history
    const listRes = await fetch(`${baseUrl}/api/runs`);
    const runs = (await listRes.json()) as Array<{ id: string; status: string }>;
    const ours = runs.find((r) => r.id === runId);
    expect(ours?.status).toBe("finished");

    const detailRes = await fetch(`${baseUrl}/api/runs/${runId}`);
    const detail = (await detailRes.json()) as { stats: unknown[]; status: string };
    expect(detail.status).toBe("finished");
    // DB persists every generation; WS may have missed early ones (subscribe race).
    expect(detail.stats.length).toBeGreaterThanOrEqual(generations.length);
  });

  it("control actions work on a running run", async () => {
    const { baseUrl } = await bootServer();
    const cfg = oneMaxConfig();
    cfg.termination = [{ id: "max-generations", params: { maxGenerations: 1_000_000 } }];

    const res = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: cfg }),
    });
    const { runId } = (await res.json()) as CreateRunResponse;

    // Let it run a bit
    await new Promise((r) => setTimeout(r, 30));

    const pauseRes = await fetch(`${baseUrl}/api/runs/${runId}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "pause" }),
    });
    const paused = (await pauseRes.json()) as { status: string };
    expect(paused.status).toBe("paused");

    const stepRes = await fetch(`${baseUrl}/api/runs/${runId}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "step" }),
    });
    expect(((await stepRes.json()) as { status: string }).status).toBe("paused");

    const stopRes = await fetch(`${baseUrl}/api/runs/${runId}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    });
    expect(((await stopRes.json()) as { status: string }).status).toBe("stopped");

    const detailRes = await fetch(`${baseUrl}/api/runs/${runId}`);
    const detail = (await detailRes.json()) as { status: string };
    expect(detail.status).toBe("stopped");
  });

  it("unsubscribing from one run leaves the socket's other subscriptions intact", async () => {
    const { baseUrl, wsUrl } = await bootServer();

    const startLongRun = async (): Promise<string> => {
      const cfg = oneMaxConfig();
      // No target-fitness: this run must keep streaming for the whole test.
      cfg.termination = [{ id: "max-generations", params: { maxGenerations: 1_000_000 } }];
      const res = await fetch(`${baseUrl}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: cfg }),
      });
      return ((await res.json()) as CreateRunResponse).runId;
    };
    const stopRun = (id: string): Promise<Response> =>
      fetch(`${baseUrl}/api/runs/${id}/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      });

    const counts = new Map<string, number>();
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    ws.on("message", (raw: Buffer) => {
      const msg = JSON.parse(raw.toString()) as WsServerMessage;
      counts.set(msg.runId, (counts.get(msg.runId) ?? 0) + 1);
    });

    const runA = await startLongRun();
    const runB = await startLongRun();
    ws.send(JSON.stringify({ type: "subscribe", runId: runA }));
    ws.send(JSON.stringify({ type: "subscribe", runId: runB }));

    // Wait until both are actually streaming before touching anything.
    for (let i = 0; i < 100; i++) {
      if ((counts.get(runA) ?? 0) > 0 && (counts.get(runB) ?? 0) > 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(counts.get(runA) ?? 0).toBeGreaterThan(0);
    expect(counts.get(runB) ?? 0).toBeGreaterThan(0);

    ws.send(JSON.stringify({ type: "unsubscribe", runId: runA }));
    // Let any already-in-flight frames land before snapshotting.
    await new Promise((r) => setTimeout(r, 100));
    const aAtUnsub = counts.get(runA) ?? 0;
    const bAtUnsub = counts.get(runB) ?? 0;

    await new Promise((r) => setTimeout(r, 200));

    // The regression: B's subscription used to be torn down along with A's.
    expect(counts.get(runB) ?? 0).toBeGreaterThan(bAtUnsub);
    // And A really is unsubscribed.
    expect(counts.get(runA) ?? 0).toBe(aAtUnsub);

    ws.close();
    await Promise.all([stopRun(runA), stopRun(runB)]);
  });

  it("re-subscribing to the same run does not double-deliver its messages", async () => {
    const { baseUrl, wsUrl } = await bootServer();

    const cfg = oneMaxConfig();
    cfg.termination = [{ id: "max-generations", params: { maxGenerations: 1_000_000 } }];
    const res = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: cfg }),
    });
    const { runId } = (await res.json()) as CreateRunResponse;

    const generations: number[] = [];
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    ws.on("message", (raw: Buffer) => {
      const msg = JSON.parse(raw.toString()) as WsServerMessage;
      if (msg.type === "generation") generations.push(msg.stats.generation);
    });

    // Subscribe twice: the second must replace the first, not stack on it.
    ws.send(JSON.stringify({ type: "subscribe", runId }));
    ws.send(JSON.stringify({ type: "subscribe", runId }));

    for (let i = 0; i < 100; i++) {
      if (generations.length > 5) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    ws.close();
    await fetch(`${baseUrl}/api/runs/${runId}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    });

    expect(generations.length).toBeGreaterThan(5);
    expect(new Set(generations).size).toBe(generations.length);
  });

  it("reconciles runs left mid-flight by a restart, instead of reporting them live", async () => {
    // A real file: :memory: cannot, by definition, survive a restart.
    const dbPath = join(
      mkdtempSync(join(tmpdir(), "genebaer-restart-")),
      "genebaer.db",
    );

    const boot = async (): Promise<{ srv: GenebaerServer; baseUrl: string }> => {
      const srv = createServer({ dbPath, logger: false });
      await srv.listen({ port: 0, host: "127.0.0.1" });
      const addr = srv.app.server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      return { srv, baseUrl: `http://127.0.0.1:${port}` };
    };

    // --- first process: start a run that will still be going when we kill it
    const first = await boot();
    const cfg = oneMaxConfig();
    cfg.termination = [{ id: "max-generations", params: { maxGenerations: 1_000_000 } }];
    const createRes = await fetch(`${first.baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: cfg }),
    });
    const { runId } = (await createRes.json()) as CreateRunResponse;
    await new Promise((r) => setTimeout(r, 50));

    const live = (await (
      await fetch(`${first.baseUrl}/api/runs/${runId}`)
    ).json()) as RunDetail;
    expect(live.status).toBe("running");

    // Close without stopping the run — this is the crash/restart case.
    await first.srv.close();

    // --- second process, same database
    const second = await boot();
    try {
      const after = (await (
        await fetch(`${second.baseUrl}/api/runs/${runId}`)
      ).json()) as RunDetail;

      // The whole point: it must not still claim to be running.
      expect(after.status).toBe("stopped");
      expect(after.finishedAt).not.toBeNull();
      expect(after.stopReason).toMatch(/restart/i);

      // And it must be honest in the list view too.
      const listed = (await (
        await fetch(`${second.baseUrl}/api/runs`)
      ).json()) as RunSummary[];
      expect(listed.find((r) => r.id === runId)?.status).toBe("stopped");

      // Controlling a reconciled run is a 404, not a hang.
      const ctl = await fetch(`${second.baseUrl}/api/runs/${runId}/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "pause" }),
      });
      expect(ctl.status).toBe(404);
    } finally {
      await second.srv.close();
      rmSync(dirname(dbPath), { recursive: true, force: true });
    }
  });

  it("persists a user-stopped run as stopped, not finished", async () => {
    const { baseUrl } = await bootServer();
    const cfg = oneMaxConfig();
    cfg.termination = [{ id: "max-generations", params: { maxGenerations: 1_000_000 } }];
    const res = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: cfg }),
    });
    const { runId } = (await res.json()) as CreateRunResponse;
    await new Promise((r) => setTimeout(r, 30));

    await fetch(`${baseUrl}/api/runs/${runId}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    });

    // listRuns reads straight from the DB with no live-status overlay, so it
    // shows what was actually persisted.
    const listed = (await (await fetch(`${baseUrl}/api/runs`)).json()) as RunSummary[];
    const row = listed.find((r) => r.id === runId);
    expect(row?.status).toBe("stopped");
    expect(row?.stopReason).toMatch(/stopped by user/i);
  });

  it("rejects bad config with 400", async () => {
    const { baseUrl } = await bootServer();
    const res = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: { ...oneMaxConfig(), mutationRate: 5 } }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects unknown operator id with 422", async () => {
    const { baseUrl } = await bootServer();
    const cfg = oneMaxConfig();
    (cfg.selection as { id: string }).id = "does-not-exist";
    const res = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: cfg }),
    });
    expect(res.status).toBe(422);
  });
});

describe("POST /api/problems/:id/genome-length", () => {
  it("reports the length a problem's params imply", async () => {
    // genebaer-7tu: the client cannot derive this. JSON Schema can describe a
    // `target` string but not "one gene per character of it".
    const { baseUrl } = await bootServer();
    const res = await fetch(`${baseUrl}/api/problems/weasel/genome-length`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ params: { target: "METHINKS" } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ genomeLength: 8 });
  });

  it("tracks the params rather than returning a fixed number", async () => {
    const { baseUrl } = await bootServer();
    const ask = async (target: string) => {
      const res = await fetch(`${baseUrl}/api/problems/weasel/genome-length`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ params: { target } }),
      });
      return ((await res.json()) as { genomeLength: number | null }).genomeLength;
    };
    expect(await ask("AB")).toBe(2);
    expect(await ask("ABCDE")).toBe(5);
  });

  it("reports null where any genome length genuinely works", async () => {
    // Claiming a requirement here would let the form overwrite a size the user
    // chose deliberately.
    const { baseUrl } = await bootServer();
    const res = await fetch(`${baseUrl}/api/problems/one-max/genome-length`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ params: {} }),
    });
    expect(await res.json()).toEqual({ genomeLength: null });
  });

  it("404s an unknown problem instead of inventing a length", async () => {
    const { baseUrl } = await bootServer();
    const res = await fetch(`${baseUrl}/api/problems/not-a-problem/genome-length`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ params: {} }),
    });
    expect(res.status).toBe(404);
  });

  it("422s params the problem itself rejects", async () => {
    // The form calls this while the user is still typing, so a half-entered
    // value must read as "cannot size that yet", not as a server fault.
    const { baseUrl } = await bootServer();
    const res = await fetch(`${baseUrl}/api/problems/mds/genome-length`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ params: { graph: "not-a-graph" } }),
    });
    expect(res.status).toBe(422);
  });
});

describe("rejecting a run whose encoding contradicts the problem", () => {
  function mismatchedConfig(length: number): RunConfig {
    return {
      problem: { id: "weasel", params: { target: "METHINKS IT IS LIKE A WEASEL" } },
      encoding: { id: "string", params: { length } },
      selection: { id: "tournament" },
      crossover: { id: "uniform" },
      mutation: { id: "char" },
      mutationRate: 0.05,
      populationSize: 8,
      elitism: 1,
      termination: [{ id: "max-generations", params: { maxGenerations: 2 } }],
      seed: 1,
    };
  }

  it("422s instead of starting a run that optimises the wrong thing", async () => {
    // genebaer-1os: this returned 200. Weasel scored against the 28-character
    // overlap and ignored the surplus four genes, so the run looked healthy
    // while optimising something other than what was asked for.
    const { baseUrl } = await bootServer();
    const res = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: mismatchedConfig(32) }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/exactly 28 genes/);
    expect(body.error).toMatch(/produces 32/);
  });

  it("creates no run row for the rejected config", async () => {
    // A 422 that still persisted a run would leave a corpse in the history.
    const { baseUrl } = await bootServer();
    await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: mismatchedConfig(32) }),
    });
    const runs = (await (await fetch(`${baseUrl}/api/runs`)).json()) as unknown[];
    expect(runs).toHaveLength(0);
  });

  it("still accepts the correctly sized config", async () => {
    const { baseUrl } = await bootServer();
    const res = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: mismatchedConfig(28) }),
    });
    expect(res.status).toBe(200);
  });
});

describe("reporting why a run failed", () => {
  /** An image run left on the default in-process evaluator, which cannot score it. */
  function unscorableConfig(): RunConfig {
    return {
      problem: { id: "image-prompt", params: { prompt: "a cat" } },
      encoding: { id: "numeric", params: { dimensions: 240, min: 0, max: 1 } },
      selection: { id: "tournament" },
      crossover: { id: "uniform" },
      mutation: { id: "gaussian" },
      mutationRate: 0.05,
      populationSize: 8,
      elitism: 1,
      termination: [{ id: "max-generations", params: { maxGenerations: 3 } }],
      seed: 1,
    };
  }

  async function failedRun(baseUrl: string): Promise<RunDetail> {
    const { runId } = (await (
      await fetch(`${baseUrl}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: unscorableConfig() }),
      })
    ).json()) as CreateRunResponse;

    for (let i = 0; i < 100; i++) {
      const detail = (await (await fetch(`${baseUrl}/api/runs/${runId}`)).json()) as RunDetail;
      if (detail.status === "error") return detail;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("run never reached error status");
  }

  it("persists the reason, so a reload still explains the failure", async () => {
    // genebaer-29p: this returned status 'error' with stopReason null. The
    // engine's message — which names the fix — existed only in server stdout.
    const { baseUrl } = await bootServer();
    const detail = await failedRun(baseUrl);
    expect(detail.stopReason).toBeTruthy();
    expect(detail.stopReason).toMatch(/cannot be scored in-process/);
    // The advice is the valuable part; it must survive intact.
    expect(detail.stopReason).toMatch(/clip-similarity/);
  });

  it("marks the failed run terminal, so elapsed time is not zero", async () => {
    // setStatus left finished_at null, so the UI computed elapsed from
    // createdAt and displayed 0 for a run that plainly ran.
    const { baseUrl } = await bootServer();
    const detail = await failedRun(baseUrl);
    expect(detail.finishedAt).toBeTypeOf("number");
    expect(detail.finishedAt!).toBeGreaterThanOrEqual(detail.createdAt);
  });

  it("tells a subscribed client why, not merely that", async () => {
    // Deliberately fails on a LATER generation. An immediate config failure
    // races the subscription — the run is already dead before a client can
    // subscribe, which is precisely why the reason is also persisted and the
    // UI falls back to it. This exercises the live path a long-running failure
    // actually takes, such as an evaluator dying mid-run.
    class FailsLater extends FitnessEvaluator<unknown> {
      static override readonly operatorId = "fails-on-third";
      static override readonly displayName = "Fails on third";
      static override readonly description = "Test evaluator.";
      static override readonly paramsSchema = {};
      private calls = 0;
      evaluateBatch(genomes: unknown[]): Promise<number[]> {
        this.calls += 1;
        if (this.calls >= 3) {
          return Promise.reject(new Error("scorer went away mid-run"));
        }
        return Promise.resolve(genomes.map(() => 1));
      }
    }
    const registry = createServerRegistry().register("evaluator", FailsLater);
    app = createServer({ dbPath: ":memory:", logger: false, registry });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((resolve) => ws.on("open", resolve));

    const errorFrame = new Promise<string>((resolve) => {
      ws.on("message", (raw: Buffer) => {
        const msg = JSON.parse(String(raw)) as WsServerMessage;
        if (msg.type === "error") resolve(msg.reason);
      });
    });

    const { runId } = (await (
      await fetch(`${baseUrl}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          config: { ...oneMaxConfig(), evaluator: { id: "fails-on-third" } },
        }),
      })
    ).json()) as CreateRunResponse;
    ws.send(JSON.stringify({ type: "subscribe", runId }));

    expect(await errorFrame).toMatch(/scorer went away mid-run/);
    ws.close();
  });
});
