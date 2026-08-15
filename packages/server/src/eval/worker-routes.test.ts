import { afterEach, describe, expect, it } from "vitest";
import { JobQueue } from "./job-queue.js";
import { setActiveQueue } from "./queued-evaluator.js";
import { createServer, type GenebaerServer } from "../server.js";

let app: GenebaerServer | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  setActiveQueue(null);
});

async function boot(leaseMs = 30_000): Promise<{ base: string; srv: GenebaerServer }> {
  app = createServer({ dbPath: ":memory:", logger: false, leaseMs });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { base: `http://127.0.0.1:${String(port)}`, srv: app };
}

/**
 * Abandon a submission on purpose. Server shutdown rejects outstanding
 * evaluations, and a test that never awaits one would surface that as an
 * unhandled rejection. The engine always awaits, so this is test-only.
 */
function ignore(p: Promise<unknown>): void {
  p.catch(() => undefined);
}

async function post<T>(base: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

describe("worker HTTP transport", () => {
  it("registers a worker and reports it with its capabilities", async () => {
    const { base } = await boot();
    const reg = await post<{ workerId: string; leaseMs: number }>(
      base,
      "/api/workers/register",
      { capabilities: [{ evaluatorId: "clip", version: "1" }], kind: "test" },
    );
    expect(reg.workerId).toBeTruthy();
    expect(reg.leaseMs).toBe(30_000);

    const listed = (await (await fetch(`${base}/api/workers`)).json()) as {
      workers: { workerId: string; kind: string }[];
    };
    expect(listed.workers).toHaveLength(1);
    expect(listed.workers[0]!.kind).toBe("test");
  });

  it("rejects a malformed registration", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/api/workers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capabilities: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("tells an unknown worker to re-register rather than idling it forever", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/api/workers/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerId: "ghost", max: 4 }),
    });
    expect(res.status).toBe(404);
  });

  it("reports idle when no job matches the worker", async () => {
    const { base } = await boot();
    const reg = await post<{ workerId: string }>(base, "/api/workers/register", {
      capabilities: [{ evaluatorId: "clip", version: "1" }],
    });
    const claim = await post<{ idle?: boolean }>(base, "/api/workers/claim", {
      workerId: reg.workerId,
      max: 4,
    });
    expect(claim.idle).toBe(true);
  });

  it("drives a whole evaluation end to end over HTTP", async () => {
    const { base, srv } = await boot();
    // Submit work directly to the server's queue, as a queued evaluator would.
    const pending = srv.jobQueue.submit("clip", "1", { prompt: "a cat" }, ["g0", "g1", "g2"]);

    const reg = await post<{ workerId: string }>(base, "/api/workers/register", {
      capabilities: [{ evaluatorId: "clip", version: "1" }],
      kind: "test",
    });

    const claim = await post<{
      leaseId: string;
      jobs: { evaluationId: string; index: number; genome: unknown; params: Record<string, unknown> }[];
    }>(base, "/api/workers/claim", { workerId: reg.workerId, max: 10 });

    expect(claim.jobs).toHaveLength(3);
    // The worker gets everything it needs to score: the genome and the params.
    expect(claim.jobs[0]!.params).toEqual({ prompt: "a cat" });

    for (const job of claim.jobs) {
      const out = await post<{ applied: boolean }>(base, "/api/workers/score", {
        workerId: reg.workerId,
        leaseId: claim.leaseId,
        evaluationId: job.evaluationId,
        index: job.index,
        score: job.index / 10,
      });
      expect(out.applied).toBe(true);
    }

    await expect(pending).resolves.toEqual([0, 0.1, 0.2]);
  });

  it("never offers a v1 worker a v2 job over the wire", async () => {
    const { base, srv } = await boot();
    ignore(srv.jobQueue.submit("clip", "2", {}, ["g0"]));
    const reg = await post<{ workerId: string }>(base, "/api/workers/register", {
      capabilities: [{ evaluatorId: "clip", version: "1" }],
    });
    const claim = await post<{ idle?: boolean }>(base, "/api/workers/claim", {
      workerId: reg.workerId,
      max: 10,
    });
    expect(claim.idle).toBe(true);
  });

  it("re-dispatches to a second worker after the first one's lease expires", async () => {
    const { base, srv } = await boot(1); // 1ms leases
    const pending = srv.jobQueue.submit("clip", "1", {}, ["g0"]);

    const ghost = await post<{ workerId: string }>(base, "/api/workers/register", {
      capabilities: [{ evaluatorId: "clip", version: "1" }],
    });
    const first = await post<{ leaseId: string; jobs: unknown[] }>(
      base,
      "/api/workers/claim",
      { workerId: ghost.workerId, max: 10 },
    );
    expect(first.jobs).toHaveLength(1);
    // ...ghost never answers.

    await new Promise((r) => setTimeout(r, 20));

    const rescuer = await post<{ workerId: string }>(base, "/api/workers/register", {
      capabilities: [{ evaluatorId: "clip", version: "1" }],
    });
    const second = await post<{
      leaseId: string;
      jobs: { evaluationId: string; index: number }[];
    }>(base, "/api/workers/claim", { workerId: rescuer.workerId, max: 10 });

    expect(second.jobs).toHaveLength(1);
    await post(base, "/api/workers/score", {
      workerId: rescuer.workerId,
      leaseId: second.leaseId,
      evaluationId: second.jobs[0]!.evaluationId,
      index: 0,
      score: 7,
    });
    await expect(pending).resolves.toEqual([7]);
  });

  it("reports a dead lease on heartbeat so the worker re-claims", async () => {
    const { base, srv } = await boot(1);
    ignore(srv.jobQueue.submit("clip", "1", {}, ["g0"]));
    const reg = await post<{ workerId: string }>(base, "/api/workers/register", {
      capabilities: [{ evaluatorId: "clip", version: "1" }],
    });
    const claim = await post<{ leaseId: string }>(base, "/api/workers/claim", {
      workerId: reg.workerId,
      max: 10,
    });
    await new Promise((r) => setTimeout(r, 20));
    // Any worker call sweeps expired leases first.
    await fetch(`${base}/api/workers`);

    const beat = await post<{ extended: boolean }>(base, "/api/workers/heartbeat", {
      workerId: reg.workerId,
      leaseId: claim.leaseId,
    });
    expect(beat.extended).toBe(false);
  });

  it("returns a deregistered worker's jobs to the queue", async () => {
    const { base, srv } = await boot();
    ignore(srv.jobQueue.submit("clip", "1", {}, ["g0", "g1"]));
    const reg = await post<{ workerId: string }>(base, "/api/workers/register", {
      capabilities: [{ evaluatorId: "clip", version: "1" }],
    });
    await post(base, "/api/workers/claim", { workerId: reg.workerId, max: 10 });
    expect(srv.jobQueue.stats().pending).toBe(0);

    await post(base, "/api/workers/deregister", { workerId: reg.workerId });
    expect(srv.jobQueue.stats().pending).toBe(2);
  });

  it("fails an evaluation a worker reports it cannot score", async () => {
    const { base, srv } = await boot();
    const pending = srv.jobQueue.submit("clip", "1", {}, ["g0"]);
    // Attach the rejection handler BEFORE triggering the failure: the reject
    // lands during the /fail call, and a handler attached afterwards is too
    // late to stop Node reporting it as unhandled.
    const rejects = expect(pending).rejects.toThrow(/model failed to load/);

    const reg = await post<{ workerId: string }>(base, "/api/workers/register", {
      capabilities: [{ evaluatorId: "clip", version: "1" }],
    });
    const claim = await post<{ jobs: { evaluationId: string }[] }>(
      base,
      "/api/workers/claim",
      { workerId: reg.workerId, max: 10 },
    );
    await post(base, "/api/workers/fail", {
      workerId: reg.workerId,
      evaluationId: claim.jobs[0]!.evaluationId,
      reason: "model failed to load",
    });
    await rejects;
  });

  it("exposes queue stats for observability", async () => {
    const { base, srv } = await boot();
    ignore(srv.jobQueue.submit("clip", "1", {}, ["g0", "g1"]));
    const listed = (await (await fetch(`${base}/api/workers`)).json()) as {
      queue: { pending: number; openEvaluations: number };
    };
    expect(listed.queue.pending).toBe(2);
    expect(listed.queue.openEvaluations).toBe(1);
  });
});

describe("JobQueue + registry integration invariants", () => {
  it("keeps a worker's own jobs when another worker deregisters", () => {
    const q = new JobQueue();
    void q.submit("clip", "1", {}, ["a", "b"]);
    q.claimWithLease("keeper", ["clip@1"], 1, 60_000, 0);
    q.claimWithLease("leaver", ["clip@1"], 1, 60_000, 0);

    q.releaseWorker("leaver");
    expect(q.stats().activeLeases).toBe(1);
    expect(q.stats().pending).toBe(1);
  });
});
