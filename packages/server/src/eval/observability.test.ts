import { afterEach, describe, expect, it } from "vitest";
import { JobQueue } from "./job-queue.js";
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

async function boot(): Promise<{ base: string; srv: GenebaerServer }> {
  app = createServer({ dbPath: ":memory:", logger: false, leaseMs: 60_000 });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { base: `http://127.0.0.1:${String(port)}`, srv: app };
}

interface Blocker {
  evaluationId: string;
  contract: string;
  remaining: number;
  unclaimed: number;
  queueWaitMs: number;
  scoringMs: number;
  heldBy: string[];
  servable: boolean;
}

describe("inflight reporting", () => {
  it("names which jobs are outstanding and who holds them", () => {
    const q = new JobQueue();
    ignore(q.submit("clip", "1", P, ["a", "b", "c"]));
    q.claimWithLease("w1", ["clip@1"], 2, 60_000, 0);

    const [evaluation] = q.inflight(100);
    expect(evaluation!.total).toBe(3);
    expect(evaluation!.outstanding).toHaveLength(3);
    // Two are held by a worker, one is still sitting in the queue.
    expect(evaluation!.outstanding.filter((j) => j.workerId === "w1")).toHaveLength(2);
    expect(evaluation!.unclaimed).toBe(1);
  });

  it("stops listing a job once it has been scored", () => {
    const q = new JobQueue();
    ignore(q.submit("clip", "1", P, ["a", "b"]));
    const lease = q.claimWithLease("w1", ["clip@1"], 10, 60_000, 0)!;
    q.submitScore(lease.jobs[0]!.evaluationId, 0, 0.5);

    const [evaluation] = q.inflight();
    expect(evaluation!.outstanding.map((j) => j.index)).toEqual([1]);
  });

  it("splits queue wait from scoring time", () => {
    // These need very different fixes: waiting means too few workers, scoring
    // means the workers are slow. Reporting one number would hide which.
    const q = new JobQueue();
    ignore(q.submit("clip", "1", P, ["a"]));

    const beforeClaim = q.inflight()[0]!;
    expect(beforeClaim.scoringMs).toBe(0);
    expect(beforeClaim.queueWaitMs).toBeGreaterThanOrEqual(0);

    q.claimWithLease("w1", ["clip@1"], 10, 60_000);
    const afterClaim = q.inflight()[0]!;
    // Queue wait is now frozen; scoring time has started running.
    expect(afterClaim.queueWaitMs).toBeGreaterThanOrEqual(0);
    expect(afterClaim.scoringMs).toBeGreaterThanOrEqual(0);
  });

  it("reports nothing once every generation has settled", async () => {
    const q = new JobQueue();
    const scores = q.submit("clip", "1", P, ["a"]);
    const lease = q.claimWithLease("w1", ["clip@1"], 10, 60_000, 0)!;
    q.submitScore(lease.jobs[0]!.evaluationId, 0, 1);
    await scores;
    expect(q.inflight()).toEqual([]);
  });
});

describe("GET /api/eval/stats", () => {
  it("reports queue depth, cache, workers and blockers together", async () => {
    const { base, srv } = await boot();
    ignore(srv.jobQueue.submit("clip", "1", P, ["a", "b"]));
    await fetch(`${base}/api/workers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capabilities: [{ evaluatorId: "clip", version: "1" }],
        kind: "test",
      }),
    });

    const stats = (await (await fetch(`${base}/api/eval/stats`)).json()) as {
      queue: { pending: number; openEvaluations: number; expiredLeases: number };
      cache: { hits: number; misses: number } | null;
      workers: { kind: string }[];
      blockers: Blocker[];
    };

    expect(stats.queue.pending).toBe(2);
    expect(stats.queue.openEvaluations).toBe(1);
    expect(stats.cache).not.toBeNull();
    expect(stats.workers[0]?.kind).toBe("test");
    expect(stats.blockers).toHaveLength(1);
    expect(stats.blockers[0]!.contract).toBe("clip@1");
    expect(stats.blockers[0]!.remaining).toBe(2);
  });

  it("says plainly when nothing can serve the blocked contract", async () => {
    // The single most common cause of a run that is not advancing, and the one
    // that is invisible without this.
    const { base, srv } = await boot();
    ignore(srv.jobQueue.submit("nobody-serves-this", "1", P, ["a"]));

    const stats = (await (await fetch(`${base}/api/eval/stats`)).json()) as {
      blockers: Blocker[];
    };
    expect(stats.blockers[0]!.servable).toBe(false);
    expect(stats.blockers[0]!.unclaimed).toBe(1);
    expect(stats.blockers[0]!.heldBy).toEqual([]);
  });

  it("identifies the worker holding a generation open", async () => {
    const { base, srv } = await boot();
    ignore(srv.jobQueue.submit("clip", "1", P, ["a"]));
    const reg = (await (
      await fetch(`${base}/api/workers/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capabilities: [{ evaluatorId: "clip", version: "1" }] }),
      })
    ).json()) as { workerId: string };
    await fetch(`${base}/api/workers/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerId: reg.workerId, max: 10 }),
    });

    const stats = (await (await fetch(`${base}/api/eval/stats`)).json()) as {
      blockers: Blocker[];
    };
    // Straggler visibility: the barrier moves at the pace of this worker.
    expect(stats.blockers[0]!.heldBy).toEqual([reg.workerId]);
    expect(stats.blockers[0]!.unclaimed).toBe(0);
    expect(stats.blockers[0]!.servable).toBe(true);
  });

  it("counts lease expiries so a re-dispatch loop is visible", async () => {
    const { base, srv } = await boot();
    void srv;
    // Short leases, then let them lapse.
    const short = createServer({ dbPath: ":memory:", logger: false, leaseMs: 1 });
    await short.listen({ port: 0, host: "127.0.0.1" });
    const addr = short.app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const shortBase = `http://127.0.0.1:${String(port)}`;
    try {
      ignore(short.jobQueue.submit("clip", "1", P, ["a"]));
      const reg = (await (
        await fetch(`${shortBase}/api/workers/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ capabilities: [{ evaluatorId: "clip", version: "1" }] }),
        })
      ).json()) as { workerId: string };
      await fetch(`${shortBase}/api/workers/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerId: reg.workerId, max: 10 }),
      });
      await new Promise((r) => setTimeout(r, 20));

      const stats = (await (await fetch(`${shortBase}/api/eval/stats`)).json()) as {
        queue: { expiredLeases: number };
      };
      expect(stats.queue.expiredLeases).toBeGreaterThan(0);
    } finally {
      await short.close();
    }
    void base;
  });

  it("exposes cache hit and miss counts", async () => {
    const { base, srv } = await boot();
    srv.scoreCache.set("k", 1);
    srv.scoreCache.get("k");
    srv.scoreCache.get("missing");

    const stats = (await (await fetch(`${base}/api/eval/stats`)).json()) as {
      cache: { hits: number; misses: number };
    };
    expect(stats.cache.hits).toBeGreaterThanOrEqual(1);
    expect(stats.cache.misses).toBeGreaterThanOrEqual(1);
  });
});
