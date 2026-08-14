import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { createServer, type GenebaerServer } from "./server.js";
import type {
  CreateRunResponse,
  RunConfig,
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
