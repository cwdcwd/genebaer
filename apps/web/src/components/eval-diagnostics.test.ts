import { describe, expect, it } from "vitest";
import { diagnose, hitRate } from "./eval-diagnostics";
import type { EvalStats } from "@/lib/api";

function stats(over: Partial<EvalStats> = {}): EvalStats {
  return {
    queue: { pending: 0, openEvaluations: 0, activeLeases: 0, expiredLeases: 0 },
    cache: { hits: 0, misses: 0, dedupedInBatch: 0 },
    workers: [],
    blockers: [],
    ...over,
  };
}

const blocker = (over: Partial<EvalStats["blockers"][number]> = {}) => ({
  evaluationId: "e1",
  contract: "clip-similarity@1",
  remaining: 4,
  unclaimed: 0,
  queueWaitMs: 10,
  scoringMs: 100,
  heldBy: ["w1"],
  servable: true,
  ...over,
});

describe("hitRate", () => {
  it("is null before anything has been looked up, not zero", () => {
    // Reporting 0% for an untouched cache reads as "broken", not "unused".
    expect(hitRate({ hits: 0, misses: 0, dedupedInBatch: 0 })).toBeNull();
    expect(hitRate(null)).toBeNull();
  });

  it("computes hits over total lookups", () => {
    expect(hitRate({ hits: 3, misses: 1, dedupedInBatch: 0 })).toBeCloseTo(0.75);
    expect(hitRate({ hits: 0, misses: 5, dedupedInBatch: 0 })).toBe(0);
  });
});

describe("diagnose", () => {
  it("says nothing when nothing is blocked", () => {
    expect(diagnose(stats())).toBeNull();
  });

  it("leads with the unservable contract — the usual cause of a stall", () => {
    // Ordered by what a person should DO about it: an unservable contract is
    // unfixable by waiting, so it must not be reported as "workers are busy".
    const msg = diagnose(stats({ blockers: [blocker({ servable: false, unclaimed: 4 })] }));
    expect(msg).toMatch(/no connected worker can serve/i);
    expect(msg).toMatch(/clip-similarity@1/);
  });

  it("distinguishes no workers at all from workers being busy", () => {
    const none = diagnose(
      stats({ blockers: [blocker({ unclaimed: 4, heldBy: [] })], workers: [] }),
    );
    expect(none).toMatch(/no workers connected/i);

    const busy = diagnose(
      stats({
        blockers: [blocker({ unclaimed: 4, heldBy: [] })],
        workers: [
          { workerId: "w1", kind: "worker-thread", capabilities: [], lastSeen: 0 },
        ],
      }),
    );
    expect(busy).toMatch(/waiting to be claimed/i);
  });

  it("names the straggler case when everything is claimed", () => {
    // The generational barrier means the slowest claim sets the pace.
    const msg = diagnose(stats({ blockers: [blocker({ unclaimed: 0, heldBy: ["w1", "w2"] })] }));
    expect(msg).toMatch(/slowest/i);
    expect(msg).toMatch(/2 worker/);
  });
});
