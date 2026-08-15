import { describe, expect, it } from "vitest";
import { JobQueue } from "./job-queue.js";

const P: Record<string, unknown> = {};
const LEASE = 1000;

describe("lease lifecycle", () => {
  it("hands jobs out under a lease and reports null when there is no work", () => {
    const q = new JobQueue();
    void q.submit("test", P, ["a", "b"]);

    const lease = q.claimWithLease("w1", ["test"], 10, LEASE, 0);
    expect(lease).not.toBeNull();
    expect(lease!.workerId).toBe("w1");
    expect(lease!.jobs).toHaveLength(2);
    expect(lease!.expiresAt).toBe(LEASE);
    expect(q.stats().activeLeases).toBe(1);

    // Nothing left to claim.
    expect(q.claimWithLease("w2", ["test"], 10, LEASE, 0)).toBeNull();
  });

  it("only offers a lease for contracts the worker advertised", () => {
    const q = new JobQueue();
    void q.submit("clip", P, ["x"]);
    expect(q.claimWithLease("w1", ["other"], 10, LEASE, 0)).toBeNull();
    expect(q.claimWithLease("w1", ["clip"], 10, LEASE, 0)).not.toBeNull();
  });
});

describe("lease expiry and re-dispatch", () => {
  it("returns a vanished worker's jobs so the generation can still complete", async () => {
    // THE failure this whole mechanism exists for: the engine is generational,
    // so it waits for every score. Without expiry, one closed tab hangs the
    // run forever.
    const q = new JobQueue();
    const scores = q.submit("test", P, ["a", "b"]);

    const lease = q.claimWithLease("ghost", ["test"], 10, LEASE, 0)!;
    expect(lease.jobs).toHaveLength(2);
    // ...worker disappears without submitting anything.

    expect(q.expireLeases(LEASE + 1)).toBe(1);
    expect(q.stats().activeLeases).toBe(0);
    expect(q.stats().expiredLeases).toBe(1);

    // Another worker picks the work up and the run completes.
    const second = q.claimWithLease("w2", ["test"], 10, LEASE, LEASE + 1)!;
    expect(second.jobs).toHaveLength(2);
    for (const job of second.jobs) q.submitScore(job.evaluationId, job.index, job.index);
    await expect(scores).resolves.toEqual([0, 1]);
  });

  it("does not expire a lease that still has time", () => {
    const q = new JobQueue();
    void q.submit("test", P, ["a"]);
    q.claimWithLease("w1", ["test"], 10, LEASE, 0);
    expect(q.expireLeases(LEASE - 1)).toBe(0);
    expect(q.stats().activeLeases).toBe(1);
  });

  it("re-dispatches ONLY the jobs the worker had not already scored", async () => {
    // A worker may submit part of its batch before stalling. Re-scoring the
    // finished ones would be wasted work.
    const q = new JobQueue();
    const scores = q.submit("test", P, ["a", "b", "c"]);
    const lease = q.claimWithLease("slow", ["test"], 10, LEASE, 0)!;

    q.submitScore(lease.jobs[0]!.evaluationId, 0, 100);
    q.expireLeases(LEASE + 1);

    const redispatched = q.claimWithLease("w2", ["test"], 10, LEASE, LEASE + 1)!;
    expect(redispatched.jobs.map((j) => j.index).sort()).toEqual([1, 2]);

    for (const job of redispatched.jobs) {
      q.submitScore(job.evaluationId, job.index, job.index);
    }
    // Index 0 keeps the original worker's score.
    await expect(scores).resolves.toEqual([100, 1, 2]);
  });

  it("accepts a late score from an expired lease if nobody else scored that job", async () => {
    const q = new JobQueue();
    const scores = q.submit("test", P, ["a"]);
    const lease = q.claimWithLease("slow", ["test"], 10, LEASE, 0)!;
    q.expireLeases(LEASE + 1);

    // The slow worker finally answers. The job is still unscored, so its work
    // is perfectly good — discarding it would waste an inference.
    expect(q.submitScore(lease.jobs[0]!.evaluationId, 0, 42)).toBe(true);
    await expect(scores).resolves.toEqual([42]);
  });

  it("never lets a late score overwrite one another worker already recorded", async () => {
    const q = new JobQueue();
    const scores = q.submit("test", P, ["a"]);
    const slow = q.claimWithLease("slow", ["test"], 10, LEASE, 0)!;
    q.expireLeases(LEASE + 1);
    const fast = q.claimWithLease("fast", ["test"], 10, LEASE, LEASE + 1)!;

    q.submitScore(fast.jobs[0]!.evaluationId, 0, 1);
    // Slow worker's answer arrives second and must be discarded.
    expect(q.submitScore(slow.jobs[0]!.evaluationId, 0, 999)).toBe(false);
    await expect(scores).resolves.toEqual([1]);
  });
});

describe("heartbeat", () => {
  it("extends a live lease without re-claiming", () => {
    const q = new JobQueue();
    void q.submit("test", P, ["a"]);
    const lease = q.claimWithLease("w1", ["test"], 10, LEASE, 0)!;

    expect(q.heartbeat(lease.leaseId, LEASE, 500)).toBe(true);
    // Previously would have expired at 1000; now good until 1500.
    expect(q.expireLeases(1200)).toBe(0);
    expect(q.expireLeases(1600)).toBe(1);
  });

  it("refuses an unknown or already-expired lease so the worker knows to re-claim", () => {
    const q = new JobQueue();
    void q.submit("test", P, ["a"]);
    const lease = q.claimWithLease("w1", ["test"], 10, LEASE, 0)!;

    expect(q.heartbeat("no-such-lease", LEASE, 0)).toBe(false);
    q.expireLeases(LEASE + 1);
    expect(q.heartbeat(lease.leaseId, LEASE, LEASE + 2)).toBe(false);
  });
});

describe("worker disconnect", () => {
  it("releases every lease a departed worker held, leaving other workers alone", () => {
    const q = new JobQueue();
    void q.submit("test", P, ["a", "b", "c"]);
    q.claimWithLease("gone", ["test"], 1, LEASE, 0);
    q.claimWithLease("gone", ["test"], 1, LEASE, 0);
    const stays = q.claimWithLease("stays", ["test"], 1, LEASE, 0)!;
    expect(q.stats().activeLeases).toBe(3);

    expect(q.releaseWorker("gone")).toBe(2);
    expect(q.stats().activeLeases).toBe(1);

    // The departed worker's two jobs are claimable again; the remaining
    // worker's job is untouched and still leased to it.
    const back = q.claimWithLease("w2", ["test"], 10, LEASE, 0)!;
    expect(back.jobs).toHaveLength(2);
    expect(back.jobs.map((j) => j.index)).not.toContain(stays.jobs[0]!.index);
  });

  it("completes the generation after a disconnect, with no job lost or doubled", async () => {
    const q = new JobQueue();
    const scores = q.submit("test", P, ["a", "b"]);
    q.claimWithLease("gone", ["test"], 10, LEASE, 0);
    q.releaseWorker("gone");

    const back = q.claimWithLease("w2", ["test"], 10, LEASE, 0)!;
    expect(back.jobs).toHaveLength(2);
    for (const job of back.jobs) q.submitScore(job.evaluationId, job.index, job.index * 10);
    await expect(scores).resolves.toEqual([0, 10]);
  });
});
