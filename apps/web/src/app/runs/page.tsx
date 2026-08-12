"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { RunSummary } from "@genebaer/shared-types";
import { api } from "@/lib/api";
import { formatFitness, formatTime } from "@/lib/utils";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusFilter } from "@/components/status-filter";

const MAX_COMPARE = 4;

export default function RunsPage() {
  const router = useRouter();
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<string>("all");

  useEffect(() => {
    api
      .listRuns()
      .then((list) => setRuns([...list].sort((a, b) => b.createdAt - a.createdAt)))
      .catch((err) => setError((err as Error).message));
  }, []);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_COMPARE) next.add(id);
      return next;
    });
  };

  const visible = (runs ?? []).filter(
    (r) => statusFilter === "all" || r.status === statusFilter,
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Runs</h1>
        <div className="flex items-center gap-3">
          <StatusFilter value={statusFilter} onChange={setStatusFilter} />
          <Button
            variant="secondary"
            disabled={selected.size < 2}
            onClick={() => router.push(`/compare?ids=${[...selected].join(",")}`)}
          >
            Compare ({selected.size}/{MAX_COMPARE})
          </Button>
        </div>
      </div>

      {error && (
        <p className="mono rounded-md border border-danger/40 bg-danger/10 p-3 text-xs text-danger">
          {error}
        </p>
      )}

      {!runs && !error && (
        <p className="py-16 text-center text-sm text-muted">Loading runs…</p>
      )}

      {runs && visible.length === 0 && (
        <p className="py-16 text-center text-sm text-muted">
          No runs yet — build an experiment to start one.
        </p>
      )}

      {runs && visible.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border bg-surface text-xs uppercase tracking-wider text-muted">
                <th className="w-10 px-3 py-2.5"></th>
                <th className="px-3 py-2.5">Problem</th>
                <th className="px-3 py-2.5">Encoding</th>
                <th className="px-3 py-2.5">Status</th>
                <th className="px-3 py-2.5 text-right">Best fitness</th>
                <th className="px-3 py-2.5 text-right">Gen</th>
                <th className="px-3 py-2.5">Created</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((run) => {
                const live = run.status === "running" || run.status === "paused";
                return (
                  <tr
                    key={run.id}
                    onClick={() => router.push(`/runs/${run.id}`)}
                    className="cursor-pointer border-b border-border/50 transition-colors hover:bg-surface"
                  >
                    <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(run.id)}
                        disabled={!selected.has(run.id) && selected.size >= MAX_COMPARE}
                        onChange={() => toggleSelect(run.id)}
                        className="h-4 w-4 cursor-pointer accent-accent"
                      />
                    </td>
                    <td className="mono px-3 py-2.5">{run.config.problem.id}</td>
                    <td className="mono px-3 py-2.5 text-muted">{run.config.encoding.id}</td>
                    <td className="px-3 py-2.5">
                      <StatusBadge status={run.status} />
                    </td>
                    <td className="mono px-3 py-2.5 text-right">
                      {formatFitness(run.finalBestFitness)}
                      {live && run.finalBestFitness === null && (
                        <span className="text-muted"> (live)</span>
                      )}
                    </td>
                    <td className="mono px-3 py-2.5 text-right text-muted">
                      {run.currentGeneration}
                    </td>
                    <td className="px-3 py-2.5 text-muted">{formatTime(run.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
