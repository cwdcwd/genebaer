import { describe, expect, it } from "vitest";
import { JobQueue } from "./job-queue.js";
import { WorkerRegistry, capabilityKey } from "./worker-registry.js";

const P: Record<string, unknown> = {};

describe("WorkerRegistry", () => {
  it("registers and deregisters workers mid-run", () => {
    const r = new WorkerRegistry();
    const w = r.register([{ evaluatorId: "clip", version: "1" }], "worker-thread", 0);
    expect(r.size).toBe(1);
    expect(r.get(w.workerId)?.kind).toBe("worker-thread");

    expect(r.deregister(w.workerId)).toBe(true);
    expect(r.size).toBe(0);
    expect(r.deregister(w.workerId)).toBe(false);
  });

  it("reports the capabilities a worker advertised as id@version keys", () => {
    const r = new WorkerRegistry();
    const w = r.register(
      [
        { evaluatorId: "clip", version: "1" },
        { evaluatorId: "aesthetic", version: "3" },
      ],
      "browser",
      0,
    );
    expect(r.capabilityKeys(w.workerId).sort()).toEqual(["aesthetic@3", "clip@1"]);
    expect(r.capabilityKeys("no-such-worker")).toEqual([]);
  });

  it("answers whether anyone can serve a contract right now", () => {
    const r = new WorkerRegistry();
    expect(r.canServe("clip", "1")).toBe(false);

    const w = r.register([{ evaluatorId: "clip", version: "1" }], "browser", 0);
    expect(r.canServe("clip", "1")).toBe(true);
    // Same id, different version — deliberately NOT servable.
    expect(r.canServe("clip", "2")).toBe(false);

    r.deregister(w.workerId);
    expect(r.canServe("clip", "1")).toBe(false);
  });

  it("reaps workers that stop heartbeating and keeps the ones that do not", () => {
    const r = new WorkerRegistry();
    const alive = r.register([{ evaluatorId: "clip", version: "1" }], "a", 0);
    const dead = r.register([{ evaluatorId: "clip", version: "1" }], "b", 0);

    r.touch(alive.workerId, 900);
    const reaped = r.reapStale(500, 1000);

    expect(reaped).toEqual([dead.workerId]);
    expect(r.size).toBe(1);
    expect(r.get(alive.workerId)).toBeDefined();
  });

  it("refuses to touch an unregistered worker", () => {
    const r = new WorkerRegistry();
    expect(r.touch("ghost", 0)).toBe(false);
  });
});

describe("capability matching against the queue", () => {
  it("offers a worker only the jobs it advertised", () => {
    const q = new JobQueue();
    const r = new WorkerRegistry();
    void q.submit("clip", "1", P, ["x"]);
    void q.submit("aesthetic", "1", P, ["y"]);

    const w = r.register([{ evaluatorId: "clip", version: "1" }], "browser", 0);
    const lease = q.claimWithLease(w.workerId, r.capabilityKeys(w.workerId), 10, 1000, 0);

    expect(lease).not.toBeNull();
    expect(lease!.jobs).toHaveLength(1);
    expect(lease!.jobs[0]!.evaluatorId).toBe("clip");
  });

  it("never hands a v1 worker a v2 job", () => {
    // The whole reason version is in the key: scores from two model versions
    // are not comparable, and mixing them inside one run would distort the
    // fitness landscape mid-flight with no error anywhere.
    const q = new JobQueue();
    const r = new WorkerRegistry();
    void q.submit("clip", "2", P, ["x"]);

    const old = r.register([{ evaluatorId: "clip", version: "1" }], "browser", 0);
    expect(
      q.claimWithLease(old.workerId, r.capabilityKeys(old.workerId), 10, 1000, 0),
    ).toBeNull();

    const current = r.register([{ evaluatorId: "clip", version: "2" }], "browser", 0);
    expect(
      q.claimWithLease(current.workerId, r.capabilityKeys(current.workerId), 10, 1000, 0),
    ).not.toBeNull();
  });

  it("detects a contract nobody can serve, so it need not queue silently forever", () => {
    const q = new JobQueue();
    const r = new WorkerRegistry();
    void q.submit("clip", "1", P, ["x"]);
    r.register([{ evaluatorId: "aesthetic", version: "1" }], "browser", 0);

    expect(r.canServe("clip", "1")).toBe(false);
    expect(q.stats().pending).toBe(1); // queued, and nobody is coming
  });

  it("releases a reaped worker's leases so its jobs are re-dispatched", async () => {
    const q = new JobQueue();
    const r = new WorkerRegistry();
    const scores = q.submit("clip", "1", P, ["x", "y"]);
    const w = r.register([{ evaluatorId: "clip", version: "1" }], "browser", 0);
    q.claimWithLease(w.workerId, r.capabilityKeys(w.workerId), 10, 60_000, 0);

    // Worker goes silent; liveness reaping is independent of lease expiry and
    // must also hand the work back.
    for (const dead of r.reapStale(500, 1000)) q.releaseWorker(dead);

    const w2 = r.register([{ evaluatorId: "clip", version: "1" }], "browser", 1000);
    const lease = q.claimWithLease(w2.workerId, r.capabilityKeys(w2.workerId), 10, 60_000, 1000)!;
    expect(lease.jobs).toHaveLength(2);
    for (const job of lease.jobs) q.submitScore(job.evaluationId, job.index, 1);
    await expect(scores).resolves.toEqual([1, 1]);
  });
});

describe("capabilityKey", () => {
  it("pairs id and version so the two are never confused", () => {
    expect(capabilityKey("clip", "1")).toBe("clip@1");
    expect(capabilityKey("clip", "1")).not.toBe(capabilityKey("clip", "2"));
  });
});
