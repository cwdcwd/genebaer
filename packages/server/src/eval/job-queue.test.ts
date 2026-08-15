import { describe, expect, it } from "vitest";
import { JobQueue, type EvalJob } from "./job-queue.js";

const P: Record<string, unknown> = {};

describe("JobQueue barrier", () => {
  it("resolves only when every job in the generation has reported", async () => {
    const q = new JobQueue();
    const scores = q.submit("test", P, ["a", "b", "c"]);
    let settled = false;
    void scores.then(() => (settled = true));

    const jobs = q.claim(["test"], 10);
    expect(jobs).toHaveLength(3);

    q.submitScore(jobs[0]!.evaluationId, 0, 1);
    q.submitScore(jobs[0]!.evaluationId, 1, 2);
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false); // still one outstanding

    q.submitScore(jobs[0]!.evaluationId, 2, 3);
    await expect(scores).resolves.toEqual([1, 2, 3]);
  });

  it("reassembles by index, NOT by arrival order", async () => {
    // Workers finish out of order by nature. Assembling by arrival would
    // silently pair genomes with other genomes' scores.
    const q = new JobQueue();
    const scores = q.submit("test", P, ["a", "b", "c", "d"]);
    const jobs = q.claim(["test"], 10);
    const id = jobs[0]!.evaluationId;

    // Deliberately shuffled submission order.
    q.submitScore(id, 2, 30);
    q.submitScore(id, 0, 10);
    q.submitScore(id, 3, 40);
    q.submitScore(id, 1, 20);

    await expect(scores).resolves.toEqual([10, 20, 30, 40]);
  });

  it("resolves immediately for an empty population", async () => {
    const q = new JobQueue();
    await expect(q.submit("test", P, [])).resolves.toEqual([]);
  });

  it("keeps concurrent evaluations independent", async () => {
    const q = new JobQueue();
    const a = q.submit("test", P, ["a1", "a2"]);
    const b = q.submit("test", P, ["b1"]);
    const jobs = q.claim(["test"], 10);
    expect(jobs).toHaveLength(3);

    const aId = jobs.find((j) => j.genome === "a1")!.evaluationId;
    const bId = jobs.find((j) => j.genome === "b1")!.evaluationId;
    expect(aId).not.toBe(bId);

    q.submitScore(bId, 0, 99);
    await expect(b).resolves.toEqual([99]);

    q.submitScore(aId, 0, 1);
    q.submitScore(aId, 1, 2);
    await expect(a).resolves.toEqual([1, 2]);
  });
});

describe("JobQueue claiming", () => {
  it("only offers jobs a worker advertised capability for", () => {
    const q = new JobQueue();
    void q.submit("clip", P, ["x"]);
    void q.submit("other", P, ["y"]);

    const clipJobs = q.claim(["clip"], 10);
    expect(clipJobs).toHaveLength(1);
    expect(clipJobs[0]!.evaluatorId).toBe("clip");

    const otherJobs = q.claim(["other"], 10);
    expect(otherJobs).toHaveLength(1);
    expect(otherJobs[0]!.evaluatorId).toBe("other");
  });

  it("returns nothing for a capability no job needs", () => {
    const q = new JobQueue();
    void q.submit("clip", P, ["x"]);
    expect(q.claim(["nope"], 10)).toEqual([]);
    expect(q.claim([], 10)).toEqual([]);
  });

  it("respects the max and never hands the same job to two workers", () => {
    const q = new JobQueue();
    void q.submit("test", P, ["a", "b", "c", "d", "e"]);
    const first = q.claim(["test"], 2);
    const second = q.claim(["test"], 2);
    const third = q.claim(["test"], 10);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(third).toHaveLength(1);

    const seen = [...first, ...second, ...third].map((j) => j.index);
    expect(new Set(seen).size).toBe(5);
  });

  it("requeues unscored jobs and drops ones already scored", () => {
    const q = new JobQueue();
    void q.submit("test", P, ["a", "b"]);
    const jobs = q.claim(["test"], 10);
    const id = jobs[0]!.evaluationId;

    q.submitScore(id, 0, 5);
    q.requeue(jobs);

    // Index 0 already has a score, so only index 1 comes back.
    const again = q.claim(["test"], 10);
    expect(again.map((j) => j.index)).toEqual([1]);
  });
});

describe("JobQueue hostile submissions", () => {
  function claimed(): { q: JobQueue; id: string; jobs: EvalJob[] } {
    const q = new JobQueue();
    void q.submit("test", P, ["a", "b"]);
    const jobs = q.claim(["test"], 10);
    return { q, id: jobs[0]!.evaluationId, jobs };
  }

  it("ignores a score for an unknown evaluation id", () => {
    const { q } = claimed();
    expect(q.submitScore("no-such-evaluation", 0, 1)).toBe(false);
  });

  it("is idempotent for a duplicate submission", async () => {
    const q = new JobQueue();
    const scores = q.submit("test", P, ["a", "b"]);
    const jobs = q.claim(["test"], 10);
    const id = jobs[0]!.evaluationId;

    expect(q.submitScore(id, 0, 11)).toBe(true);
    // A re-delivery must not count twice, or the barrier would resolve early
    // with a hole in the scores.
    expect(q.submitScore(id, 0, 999)).toBe(false);
    expect(q.submitScore(id, 1, 22)).toBe(true);

    await expect(scores).resolves.toEqual([11, 22]);
  });

  it("ignores an out-of-range index", () => {
    const { q, id } = claimed();
    expect(q.submitScore(id, -1, 1)).toBe(false);
    expect(q.submitScore(id, 99, 1)).toBe(false);
    expect(q.submitScore(id, 1.5, 1)).toBe(false);
  });

  it("ignores a late score for an already-settled evaluation", async () => {
    const q = new JobQueue();
    const scores = q.submit("test", P, ["a"]);
    const jobs = q.claim(["test"], 10);
    const id = jobs[0]!.evaluationId;
    q.submitScore(id, 0, 7);
    await expect(scores).resolves.toEqual([7]);
    expect(q.submitScore(id, 0, 8)).toBe(false);
  });

  it("fails the evaluation on a non-finite score instead of poisoning selection", async () => {
    const q = new JobQueue();
    const scores = q.submit("test", P, ["a", "b"]);
    const jobs = q.claim(["test"], 10);
    q.submitScore(jobs[0]!.evaluationId, 0, Number.NaN);
    await expect(scores).rejects.toThrow(/non-finite|NaN/i);
  });

  it("rejects outstanding evaluations on cancelAll", async () => {
    const q = new JobQueue();
    const scores = q.submit("test", P, ["a"]);
    q.cancelAll("server shutting down");
    await expect(scores).rejects.toThrow(/shutting down/);
    expect(q.stats().pending).toBe(0);
  });
});

describe("JobQueue stats", () => {
  it("reports pending jobs and open evaluations", async () => {
    const q = new JobQueue();
    expect(q.stats()).toEqual({ pending: 0, openEvaluations: 0, activeLeases: 0, expiredLeases: 0 });

    const scores = q.submit("test", P, ["a", "b"]);
    expect(q.stats()).toEqual({ pending: 2, openEvaluations: 1, activeLeases: 0, expiredLeases: 0 });

    const jobs = q.claim(["test"], 1);
    expect(q.stats().pending).toBe(1);

    q.submitScore(jobs[0]!.evaluationId, 0, 1);
    q.submitScore(jobs[0]!.evaluationId, 1, 2);
    await scores;
    expect(q.stats()).toEqual({ pending: 0, openEvaluations: 0, activeLeases: 0, expiredLeases: 0 });
  });
});
