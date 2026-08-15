import type { RunConfig } from "@genebaer/shared-types";
import { createDefaultRegistry } from "@genebaer/core";
import { ImagePrompt, encodingParamsFor, isPng } from "@genebaer/vision";
import { afterEach, describe, expect, it } from "vitest";
import { JobQueue } from "./job-queue.js";
import { QueuedEvaluator, setActiveQueue } from "./queued-evaluator.js";
import { createServer, type GenebaerServer } from "../server.js";

/** Scores instantly, so a run reaches a completed generation quickly. */
class InstantEvaluator extends QueuedEvaluator {
  static override readonly operatorId = "instant";
  static override readonly version = "1";
  static override readonly displayName = "Instant";
  static override readonly description = "Test evaluator.";
  static override readonly paramsSchema = {} as const;
}

let app: GenebaerServer | null = null;
let drain: NodeJS.Timeout | null = null;

afterEach(async () => {
  if (drain) clearInterval(drain);
  drain = null;
  if (app) {
    await app.close();
    app = null;
  }
  setActiveQueue(null);
});

const SHAPE = { width: 4, height: 4 };

function imageConfig(): RunConfig {
  return {
    problem: { id: "image-prompt", params: { ...SHAPE, prompt: "a red circle" } },
    encoding: { id: "binary", params: encodingParamsFor(SHAPE) },
    selection: { id: "tournament" },
    crossover: { id: "one-point" },
    mutation: { id: "bit-flip" },
    mutationRate: 0.01,
    populationSize: 4,
    elitism: 1,
    termination: [{ id: "max-generations", params: { maxGenerations: 2 } }],
    seed: 5,
    evaluator: { id: "instant" },
  };
}

async function boot(): Promise<{ base: string; srv: GenebaerServer }> {
  const registry = createDefaultRegistry()
    .register("problem", ImagePrompt)
    .register("evaluator", InstantEvaluator);
  app = createServer({ dbPath: ":memory:", logger: false, registry });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  // Stand in for a worker so the run can actually progress.
  const queue: JobQueue = app.jobQueue;
  drain = setInterval(() => {
    for (const job of queue.claim(["instant@1"], 100)) {
      queue.submitScore(job.evaluationId, job.index, Math.random());
    }
  }, 1);
  return { base: `http://127.0.0.1:${String(port)}`, srv: app };
}

async function createRun(base: string): Promise<string> {
  const res = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config: imageConfig() }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { runId: string }).runId;
}

async function waitForGeneration(base: string, runId: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const detail = (await (await fetch(`${base}/api/runs/${runId}`)).json()) as {
      stats: unknown[];
    };
    if (detail.stats.length > 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("run produced no generation");
}

describe("PNG export", () => {
  it("returns a real PNG of the run's configured size", async () => {
    const { base } = await boot();
    const runId = await createRun(base);
    await waitForGeneration(base, runId);

    const res = await fetch(`${base}/api/runs/${runId}/image.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename=/);

    const png = Buffer.from(await res.arrayBuffer());
    expect(isPng(png)).toBe(true);
    // IHDR dimensions live at a fixed offset past the signature and length.
    expect(png.readUInt32BE(16)).toBe(SHAPE.width);
    expect(png.readUInt32BE(20)).toBe(SHAPE.height);
  });

  it("works while the run is still in progress, not only when finished", async () => {
    const { base } = await boot();
    const runId = await createRun(base);
    await waitForGeneration(base, runId);
    // No waiting for termination: the current best is a perfectly good export.
    const res = await fetch(`${base}/api/runs/${runId}/image.png`);
    expect(res.status).toBe(200);
  });

  it("still exports after the run has stopped", async () => {
    const { base } = await boot();
    const runId = await createRun(base);
    await waitForGeneration(base, runId);
    await fetch(`${base}/api/runs/${runId}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    });
    const res = await fetch(`${base}/api/runs/${runId}/image.png`);
    expect(res.status).toBe(200);
    expect(isPng(Buffer.from(await res.arrayBuffer()))).toBe(true);
  });

  it("gives a clear error before any generation exists, not an empty file", async () => {
    // A zero-byte or corrupt download is a much worse answer than a message.
    const { base, srv } = await boot();
    if (drain) clearInterval(drain);
    drain = null; // starve it so no generation completes
    const runId = await createRun(base);
    void srv;

    const res = await fetch(`${base}/api/runs/${runId}/image.png`);
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toHaveProperty("error");
  });

  it("404s for a run that does not exist", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/api/runs/does-not-exist/image.png`);
    expect(res.status).toBe(404);
  });

  it("409s for a run whose problem is not an image", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        config: {
          ...imageConfig(),
          problem: { id: "one-max" },
          encoding: { id: "binary", params: { length: 16 } },
          evaluator: undefined,
        },
      }),
    });
    const { runId } = (await res.json()) as { runId: string };
    const png = await fetch(`${base}/api/runs/${runId}/image.png`);
    expect(png.status).toBe(409);
  });
});
