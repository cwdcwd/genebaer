import type { RunConfig, WsServerMessage } from "@genebaer/shared-types";
import { createDefaultRegistry } from "@genebaer/core";
import { ImagePrompt, encodingParamsFor } from "@genebaer/vision";
import { afterEach, describe, expect, it } from "vitest";
import { CaptionQueue } from "./caption-queue.js";
import { QueuedEvaluator, setActiveQueue } from "./queued-evaluator.js";
import { createServer, type GenebaerServer } from "../server.js";

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

function imageConfig(captionEvery?: number): RunConfig {
  return {
    problem: {
      id: "image-prompt",
      params: {
        ...SHAPE,
        prompt: "a red circle",
        ...(captionEvery === undefined ? {} : { captionEvery }),
      },
    },
    encoding: { id: "binary", params: encodingParamsFor(SHAPE) },
    selection: { id: "tournament" },
    crossover: { id: "one-point" },
    mutation: { id: "bit-flip" },
    mutationRate: 0.01,
    populationSize: 4,
    elitism: 1,
    termination: [{ id: "max-generations", params: { maxGenerations: 6 } }],
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
  const queue = app.jobQueue;
  drain = setInterval(() => {
    for (const job of queue.claim(["instant@1"], 100)) {
      queue.submitScore(job.evaluationId, job.index, Math.random());
    }
  }, 1);
  return { base: `http://127.0.0.1:${String(port)}`, srv: app };
}

async function startRun(base: string, captionEvery?: number): Promise<string> {
  const res = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config: imageConfig(captionEvery) }),
  });
  return ((await res.json()) as { runId: string }).runId;
}

async function waitFor(predicate: () => boolean, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return predicate();
}

describe("CaptionQueue", () => {
  it("hands out requests and reports results to listeners", () => {
    const q = new CaptionQueue();
    const seen: string[] = [];
    q.onResult((r) => seen.push(`${r.runId}:${String(r.generation)}:${r.caption}`));

    const req = q.request("run-1", 25, { rgb: [1, 2, 3] });
    expect(q.claim(10)).toHaveLength(1);
    q.complete(req.requestId, "run-1", 25, "a blurry red shape");

    expect(seen).toEqual(["run-1:25:a blurry red shape"]);
    expect(q.stats().completed).toBe(1);
  });

  it("refuses an empty caption, which says nothing", () => {
    const q = new CaptionQueue();
    const req = q.request("r", 1, {});
    expect(q.complete(req.requestId, "r", 1, "")).toBe(false);
  });

  it("drops stale requests rather than re-dispatching them", () => {
    // Nothing waits on a caption, so re-dispatch machinery would be cost with
    // no benefit. Dropping is the correct behaviour, not a limitation.
    const q = new CaptionQueue();
    q.request("r", 1, {});
    expect(q.expire(1000, Date.now() + 5000)).toBe(1);
    expect(q.stats().pending).toBe(0);
    expect(q.stats().dropped).toBe(1);
  });

  it("removes a request on claim, so two workers never caption the same frame", () => {
    const q = new CaptionQueue();
    q.request("r", 1, {});
    expect(q.claim(10)).toHaveLength(1);
    expect(q.claim(10)).toHaveLength(0);
  });
});

describe("caption cadence", () => {
  it("requests a caption only every N generations, best genome only", async () => {
    const { base, srv } = await boot();
    const runId = await startRun(base, 2);

    await waitFor(() => srv.captionQueue.stats().pending >= 2);
    const pending = srv.captionQueue.claim(100);

    // 6 generations at every-2 means a handful of requests, NOT one per
    // individual per generation, which would be 24.
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.length).toBeLessThan(6);
    expect(pending.every((r) => r.runId === runId)).toBe(true);
    expect(pending.every((r) => r.generation % 2 === 0)).toBe(true);
  });

  it("requests nothing when the problem does not ask for captions", async () => {
    const { base, srv } = await boot();
    await startRun(base); // no captionEvery
    await new Promise((r) => setTimeout(r, 200));
    expect(srv.captionQueue.stats().pending).toBe(0);
  });

  it("sends a rendered image, so the worker never sees bit packing", async () => {
    const { base, srv } = await boot();
    await startRun(base, 1);
    await waitFor(() => srv.captionQueue.stats().pending > 0);
    const [req] = srv.captionQueue.claim(1);

    const payload = req!.payload as { width: number; height: number; rgb: number[] };
    expect(payload.width).toBe(SHAPE.width);
    expect(payload.rgb).toHaveLength(SHAPE.width * SHAPE.height * 3);
  });
});

describe("caption delivery", () => {
  it("reaches run subscribers attached to the generation it describes", async () => {
    const { base, srv } = await boot();
    const runId = await startRun(base, 1);

    const received: WsServerMessage[] = [];
    srv.runManager.subscribe(runId, (m) => received.push(m));

    await waitFor(() => srv.captionQueue.stats().pending > 0);
    const [req] = srv.captionQueue.claim(1);
    srv.captionQueue.complete(req!.requestId, runId, req!.generation, "a red blob");

    const annotation = received.find((m) => m.type === "annotation");
    expect(annotation).toBeDefined();
    if (annotation?.type === "annotation") {
      expect(annotation.text).toBe("a red blob");
      expect(annotation.generation).toBe(req!.generation);
      expect(annotation.kind).toBe("caption");
    }
  });

  it("keeps evolving when captioning fails entirely", async () => {
    // A caption is a progress check for a human. If the VLM never answers, the
    // CLIP-driven run must be completely unaffected.
    const { base, srv } = await boot();
    const runId = await startRun(base, 1);

    // Never claim, never complete — captions simply pile up and expire.
    await waitFor(() => (srv.runManager.status(runId) ?? "") === "finished", 4000);
    expect(srv.runManager.status(runId)).toBe("finished");

    const detail = (await (await fetch(`${base}/api/runs/${runId}`)).json()) as {
      stats: unknown[];
    };
    expect(detail.stats.length).toBeGreaterThan(0);
  });
});

describe("caption worker endpoints", () => {
  it("claims and submits over HTTP like any other worker traffic", async () => {
    const { base, srv } = await boot();
    const runId = await startRun(base, 1);
    const reg = (await (
      await fetch(`${base}/api/workers/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          capabilities: [{ evaluatorId: "moondream-caption", version: "1" }],
          kind: "captioner",
        }),
      })
    ).json()) as { workerId: string };

    await waitFor(() => srv.captionQueue.stats().pending > 0);

    const claimed = (await (
      await fetch(`${base}/api/workers/caption/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerId: reg.workerId, max: 1 }),
      })
    ).json()) as { requests: { requestId: string; generation: number }[] };
    expect(claimed.requests).toHaveLength(1);

    const submitted = (await (
      await fetch(`${base}/api/workers/caption/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workerId: reg.workerId,
          requestId: claimed.requests[0]!.requestId,
          runId,
          generation: claimed.requests[0]!.generation,
          caption: "a noisy square",
        }),
      })
    ).json()) as { accepted: boolean };
    expect(submitted.accepted).toBe(true);
  });

  it("rejects a malformed caption submission", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/api/workers/caption/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerId: "w", requestId: "r" }),
    });
    expect(res.status).toBe(400);
  });
});
