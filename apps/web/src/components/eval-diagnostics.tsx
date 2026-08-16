"use client";

import { useEffect, useState } from "react";
import { api, type EvalStats } from "@/lib/api";

/**
 * Why a run is not advancing.
 *
 * Every failure mode in distributed evaluation looks identical from outside —
 * the run simply stops moving. A missing worker, a re-dispatch loop, one
 * straggler holding the generational barrier, and a cold cache are
 * indistinguishable without this. A stalled run is exactly when a person needs
 * these numbers, and until now it was exactly when they could not see them.
 */

/** Cache hit rate, or null when nothing has been looked up yet. */
export function hitRate(cache: EvalStats["cache"]): number | null {
  if (!cache) return null;
  const total = cache.hits + cache.misses;
  return total === 0 ? null : cache.hits / total;
}

/**
 * The single sentence explaining a stall, or null when nothing is blocked.
 *
 * Ordered by what a person should do about it, not by what is easiest to
 * detect: nobody can serve it > nobody has picked it up > someone is slow.
 */
export function diagnose(stats: EvalStats): string | null {
  const blocker = stats.blockers[0];
  if (!blocker) return null;

  if (!blocker.servable) {
    return `No connected worker can serve ${blocker.contract}. The run cannot progress until one registers.`;
  }
  if (blocker.unclaimed > 0 && stats.workers.length === 0) {
    return `${String(blocker.unclaimed)} job(s) waiting and no workers connected.`;
  }
  if (blocker.unclaimed > 0) {
    return `${String(blocker.unclaimed)} job(s) waiting to be claimed — workers may be busy.`;
  }
  return `Waiting on ${String(blocker.remaining)} job(s) held by ${String(
    blocker.heldBy.length,
  )} worker(s). The generation finishes at the pace of the slowest.`;
}

export function EvalDiagnostics({ pollMs = 2000 }: { pollMs?: number }) {
  const [stats, setStats] = useState<EvalStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = (): void => {
      api
        .evalStats()
        .then((s) => {
          if (!alive) return;
          setStats(s);
          setError(null);
        })
        .catch((err: unknown) => {
          if (alive) setError((err as Error).message);
        });
    };
    tick();
    const timer = setInterval(tick, pollMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [pollMs]);

  if (error) {
    return (
      <p className="mono text-[11px] text-danger">Diagnostics unavailable: {error}</p>
    );
  }
  if (!stats) {
    return <p className="text-xs text-muted">Loading diagnostics…</p>;
  }

  const rate = hitRate(stats.cache);
  const problem = diagnose(stats);

  return (
    <div className="space-y-3">
      {problem && (
        <p
          className="mono rounded border border-warning/40 bg-warning/10 p-2 text-[11px] text-warning"
          data-testid="blocker"
        >
          {problem}
        </p>
      )}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <Stat label="queued jobs" value={String(stats.queue.pending)} />
        <Stat label="open generations" value={String(stats.queue.openEvaluations)} />
        <Stat label="active leases" value={String(stats.queue.activeLeases)} />
        <Stat
          label="lease expiries"
          value={String(stats.queue.expiredLeases)}
          hint={
            stats.queue.expiredLeases > 0
              ? "workers are claiming and not finishing"
              : undefined
          }
        />
        <Stat
          label="cache hit rate"
          value={rate === null ? "—" : `${(rate * 100).toFixed(0)}%`}
        />
        <Stat label="workers" value={String(stats.workers.length)} />
      </dl>

      {stats.workers.length > 0 && (
        <ul className="space-y-1">
          {stats.workers.map((w) => (
            <li key={w.workerId} className="mono text-[11px] text-muted">
              <span className="text-foreground">{w.kind}</span>{" "}
              {w.capabilities.map((c) => `${c.evaluatorId}@${c.version}`).join(", ")}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  /** exactOptionalPropertyTypes: an absent hint and an undefined hint differ. */
  hint?: string | undefined;
}) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-widest text-muted">{label}</dt>
      <dd className="mono text-foreground" title={hint}>
        {value}
      </dd>
    </div>
  );
}
