import type { WorkerServerMessage } from "@genebaer/shared-types";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { JobQueue } from "./job-queue.js";
import { WorkerRegistry } from "./worker-registry.js";
import { WorkerConnection, parseWorkerMessage } from "./worker-socket.js";
import { setActiveQueue } from "./queued-evaluator.js";
import { createServer, type GenebaerServer } from "../server.js";

const P: Record<string, unknown> = {};
let app: GenebaerServer | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  setActiveQueue(null);
});

function ignore(p: Promise<unknown>): void {
  p.catch(() => undefined);
}

/** Drive a connection directly — the protocol needs no socket to be tested. */
function connect(queue: JobQueue, registry: WorkerRegistry, leaseMs = 30_000) {
  const sent: WorkerServerMessage[] = [];
  const conn = new WorkerConnection((m) => sent.push(m), {
    queue,
    registry,
    leaseMs,
    kind: "browser",
  });
  return { conn, sent };
}

describe("parseWorkerMessage", () => {
  it("accepts a worker frame", () => {
    expect(parseWorkerMessage('{"type":"worker.claim","max":4}')).toEqual({
      type: "worker.claim",
      max: 4,
    });
  });

  it("rejects malformed or foreign frames rather than throwing", () => {
    // Run subscriptions share the same server; a stray frame must not crash a
    // worker connection.
    expect(parseWorkerMessage("not json")).toBeNull();
    expect(parseWorkerMessage("null")).toBeNull();
    expect(parseWorkerMessage('{"type":"subscribe","runId":"r"}')).toBeNull();
    expect(parseWorkerMessage('{"nope":1}')).toBeNull();
  });
});

describe("WorkerConnection protocol", () => {
  it("registers and reports the lease duration back", () => {
    const registry = new WorkerRegistry();
    const { conn, sent } = connect(new JobQueue(), registry, 1234);
    conn.handle({ type: "worker.register", capabilities: [{ evaluatorId: "clip", version: "1" }] });

    expect(sent[0]).toEqual({
      type: "worker.registered",
      workerId: conn.id,
      leaseMs: 1234,
    });
    expect(registry.size).toBe(1);
    expect(registry.list()[0]!.kind).toBe("browser");
  });

  it("refuses to work before registering", () => {
    const { conn, sent } = connect(new JobQueue(), new WorkerRegistry());
    conn.handle({ type: "worker.claim", max: 4 });
    expect(sent[0]?.type).toBe("worker.leaseLost");
    if (sent[0]?.type === "worker.leaseLost") {
      expect(sent[0].reason).toMatch(/register/i);
    }
  });

  it("reports idle when nothing matches its capabilities", () => {
    const queue = new JobQueue();
    ignore(queue.submit("other", "1", P, ["x"]));
    const { conn, sent } = connect(queue, new WorkerRegistry());
    conn.handle({ type: "worker.register", capabilities: [{ evaluatorId: "clip", version: "1" }] });
    conn.handle({ type: "worker.claim", max: 4 });
    expect(sent.at(-1)?.type).toBe("worker.idle");
  });

  it("leases jobs and accepts the scores back", async () => {
    const queue = new JobQueue();
    const scores = queue.submit("clip", "1", { prompt: "a cat" }, ["g0", "g1"]);
    const { conn, sent } = connect(queue, new WorkerRegistry());
    conn.handle({ type: "worker.register", capabilities: [{ evaluatorId: "clip", version: "1" }] });
    conn.handle({ type: "worker.claim", max: 10 });

    const lease = sent.at(-1);
    expect(lease?.type).toBe("worker.lease");
    if (lease?.type !== "worker.lease") throw new Error("expected a lease");
    expect(lease.jobs).toHaveLength(2);
    expect(lease.jobs[0]!.params).toEqual({ prompt: "a cat" });

    for (const job of lease.jobs) {
      conn.handle({
        type: "worker.score",
        leaseId: lease.leaseId,
        evaluationId: job.evaluationId,
        index: job.index,
        score: job.index + 1,
      });
    }
    await expect(scores).resolves.toEqual([1, 2]);
  });

  it("tells a worker its lease is gone instead of letting it grind on dead work", () => {
    const queue = new JobQueue();
    ignore(queue.submit("clip", "1", P, ["g0"]));
    const { conn, sent } = connect(queue, new WorkerRegistry(), 1);
    conn.handle({ type: "worker.register", capabilities: [{ evaluatorId: "clip", version: "1" }] });
    conn.handle({ type: "worker.claim", max: 10 });
    const lease = sent.at(-1);
    if (lease?.type !== "worker.lease") throw new Error("expected a lease");

    queue.expireLeases(Date.now() + 1000);
    conn.handle({ type: "worker.heartbeat", leaseId: lease.leaseId });

    const last = sent.at(-1);
    expect(last?.type).toBe("worker.leaseLost");
  });

  it("fails an evaluation the worker says it cannot score", async () => {
    const queue = new JobQueue();
    const scores = queue.submit("clip", "1", P, ["g0"]);
    const rejects = expect(scores).rejects.toThrow(/no WebGPU/);
    const { conn, sent } = connect(queue, new WorkerRegistry());
    conn.handle({ type: "worker.register", capabilities: [{ evaluatorId: "clip", version: "1" }] });
    conn.handle({ type: "worker.claim", max: 10 });
    const lease = sent.at(-1);
    if (lease?.type !== "worker.lease") throw new Error("expected a lease");

    conn.handle({
      type: "worker.fail",
      leaseId: lease.leaseId,
      evaluationId: lease.jobs[0]!.evaluationId,
      reason: "no WebGPU in this browser",
    });
    await rejects;
  });

  it("returns jobs immediately when the tab closes", () => {
    // Closing a browser should not cost a full lease timeout.
    const queue = new JobQueue();
    ignore(queue.submit("clip", "1", P, ["g0", "g1"]));
    const registry = new WorkerRegistry();
    const { conn } = connect(queue, registry, 60_000);
    conn.handle({ type: "worker.register", capabilities: [{ evaluatorId: "clip", version: "1" }] });
    conn.handle({ type: "worker.claim", max: 10 });
    expect(queue.stats().pending).toBe(0);

    conn.close();
    expect(queue.stats().pending).toBe(2);
    expect(registry.size).toBe(0);
  });
});

describe("browser workers over a real socket", () => {
  async function boot(): Promise<{ wsUrl: string; srv: GenebaerServer }> {
    app = createServer({ dbPath: ":memory:", logger: false, leaseMs: 30_000 });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    return { wsUrl: `ws://127.0.0.1:${String(port)}/ws/worker`, srv: app };
  }

  it("serves a whole evaluation from a browser-style connection", async () => {
    const { wsUrl, srv } = await boot();
    const scores = srv.jobQueue.submit("clip", "1", P, ["a", "b", "c"]);

    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));

    ws.on("message", (raw: Buffer) => {
      const msg = JSON.parse(raw.toString()) as WorkerServerMessage;
      if (msg.type === "worker.registered") {
        ws.send(JSON.stringify({ type: "worker.claim", max: 10 }));
      }
      if (msg.type === "worker.lease") {
        for (const job of msg.jobs) {
          ws.send(
            JSON.stringify({
              type: "worker.score",
              leaseId: msg.leaseId,
              evaluationId: job.evaluationId,
              index: job.index,
              score: job.index / 4,
            }),
          );
        }
      }
    });
    ws.send(
      JSON.stringify({
        type: "worker.register",
        capabilities: [{ evaluatorId: "clip", version: "1" }],
      }),
    );

    await expect(scores).resolves.toEqual([0, 0.25, 0.5]);
    ws.close();
  });

  it("re-dispatches when the tab closes mid-claim, and the run continues", async () => {
    const { wsUrl, srv } = await boot();
    const scores = srv.jobQueue.submit("clip", "1", P, ["a"]);

    // First tab claims, then vanishes without answering.
    const ghost = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => ghost.on("open", () => resolve()));
    await new Promise<void>((resolve) => {
      ghost.on("message", (raw: Buffer) => {
        const msg = JSON.parse(raw.toString()) as WorkerServerMessage;
        if (msg.type === "worker.registered") {
          ghost.send(JSON.stringify({ type: "worker.claim", max: 10 }));
        }
        if (msg.type === "worker.lease") resolve();
      });
      ghost.send(
        JSON.stringify({
          type: "worker.register",
          capabilities: [{ evaluatorId: "clip", version: "1" }],
        }),
      );
    });
    ghost.close();
    await new Promise((r) => setTimeout(r, 50));

    // A second tab picks the work up. Nothing was lost.
    const rescuer = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => rescuer.on("open", () => resolve()));
    rescuer.on("message", (raw: Buffer) => {
      const msg = JSON.parse(raw.toString()) as WorkerServerMessage;
      if (msg.type === "worker.registered") {
        rescuer.send(JSON.stringify({ type: "worker.claim", max: 10 }));
      }
      if (msg.type === "worker.lease") {
        for (const job of msg.jobs) {
          rescuer.send(
            JSON.stringify({
              type: "worker.score",
              leaseId: msg.leaseId,
              evaluationId: job.evaluationId,
              index: job.index,
              score: 42,
            }),
          );
        }
      }
    });
    rescuer.send(
      JSON.stringify({
        type: "worker.register",
        capabilities: [{ evaluatorId: "clip", version: "1" }],
      }),
    );

    await expect(scores).resolves.toEqual([42]);
    rescuer.close();
  });

  it("keeps a browser worker and a thread-style worker on the same run", async () => {
    // Mixed worker kinds serving one evaluation is the point of the epic.
    const { wsUrl, srv } = await boot();
    const scores = srv.jobQueue.submit("clip", "1", P, ["a", "b", "c", "d"]);

    // A "server-side" worker claiming directly, as a pool would.
    const direct = srv.workerRegistry.register(
      [{ evaluatorId: "clip", version: "1" }],
      "worker-thread",
    );
    const lease = srv.jobQueue.claimWithLease(
      direct.workerId,
      srv.workerRegistry.capabilityKeys(direct.workerId),
      2,
      30_000,
    )!;
    for (const job of lease.jobs) {
      srv.jobQueue.submitScore(job.evaluationId, job.index, 1);
    }

    // ...and a browser tab taking the rest.
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    ws.on("message", (raw: Buffer) => {
      const msg = JSON.parse(raw.toString()) as WorkerServerMessage;
      if (msg.type === "worker.registered") {
        ws.send(JSON.stringify({ type: "worker.claim", max: 10 }));
      }
      if (msg.type === "worker.lease") {
        for (const job of msg.jobs) {
          ws.send(
            JSON.stringify({
              type: "worker.score",
              leaseId: msg.leaseId,
              evaluationId: job.evaluationId,
              index: job.index,
              score: 2,
            }),
          );
        }
      }
    });
    ws.send(
      JSON.stringify({
        type: "worker.register",
        capabilities: [{ evaluatorId: "clip", version: "1" }],
      }),
    );

    const result = await scores;
    expect(result).toHaveLength(4);
    // Two scored by each kind of worker, in one generation.
    expect(result.filter((s) => s === 1)).toHaveLength(2);
    expect(result.filter((s) => s === 2)).toHaveLength(2);
    ws.close();
  });
});

describe("payload budget", () => {
  const MAX_PAYLOAD = 8 << 20;

  function leaseFrame(population: number, side: number): string {
    const bytesPerImage = side * side * 3;
    const jobs = Array.from({ length: population }, (_, index) => ({
      evaluationId: "00000000-0000-0000-0000-000000000000",
      index,
      genome: {
        width: side,
        height: side,
        channels: 3,
        rgb: new Array<number>(bytesPerImage).fill(200),
      },
      evaluatorId: "clip-similarity",
      params: { prompt: "a red circle on a white background" },
    }));
    return JSON.stringify({ type: "worker.lease", leaseId: "x", expiresAt: 0, jobs });
  }

  it("JSON encoding costs roughly 4x the raw pixel bytes", () => {
    // The trap that made the original estimate wrong: 40 x 12,288 bytes is
    // ~491 KB raw, but JSON writes each byte as decimal text ("200,").
    // Estimating from raw size would have understated this by ~4x and the
    // frame would simply have been dropped in production.
    const raw = 40 * 64 * 64 * 3;
    const encoded = Buffer.byteLength(leaseFrame(40, 64));
    expect(encoded).toBeGreaterThan(raw * 3);
    expect(encoded).toBeLessThan(raw * 5);
  });

  it("a population of 40 at 64x64 RGB fits inside the raised maxPayload", () => {
    const encoded = Buffer.byteLength(leaseFrame(40, 64));
    // ~1.97 MB — comfortably over the original 1 MB, which is why it was
    // raised to 8 MB deliberately rather than discovered in production.
    expect(encoded).toBeGreaterThan(1 << 20);
    expect(encoded).toBeLessThan(MAX_PAYLOAD);
  });

  it("leaves headroom for a larger batch than any run currently uses", () => {
    expect(Buffer.byteLength(leaseFrame(64, 64))).toBeLessThan(MAX_PAYLOAD);
  });

  it("is uncomfortably tight at 128x128, and past it beyond that", () => {
    // 40 at 128x128 measures ~7.87 MB: it fits, but with under 7% headroom,
    // which is not margin so much as luck. Recorded as a number rather than a
    // reassurance, because the failure mode is a dropped frame and a
    // generation that stalls with no obvious cause.
    const at128 = Buffer.byteLength(leaseFrame(40, 128));
    expect(at128).toBeLessThan(MAX_PAYLOAD);
    expect(at128).toBeGreaterThan(MAX_PAYLOAD * 0.9);

    // Beyond that a browser worker must take smaller batches, which the claim
    // `max` already controls — no protocol change needed, just a smaller ask.
    expect(Buffer.byteLength(leaseFrame(64, 128))).toBeGreaterThan(MAX_PAYLOAD);
    expect(Buffer.byteLength(leaseFrame(8, 128))).toBeLessThan(MAX_PAYLOAD);
  });
});
