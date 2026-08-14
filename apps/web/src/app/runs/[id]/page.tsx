"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type {
  GenerationStats,
  RunControlAction,
  RunDetail,
  RunStatus,
} from "@genebaer/shared-types";
import { ApiError, api } from "@/lib/api";
import { useRunStream } from "@/lib/use-run-stream";
import { formatElapsed, formatFitness, formatTime } from "@/lib/utils";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { DiversityChart, FitnessChart } from "@/components/fitness-chart";
import { ProblemVisual } from "@/components/visualizers";

export default function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loadError, setLoadError] = useState<number | null>(null);
  const [restStatus, setRestStatus] = useState<RunStatus | null>(null);
  const [visualFrame, setVisualFrame] = useState<unknown>(null);
  const [controlError, setControlError] = useState<string | null>(null);

  const stream = useRunStream(loadError ? null : id);

  // Hydrate from REST once.
  useEffect(() => {
    api
      .getRun(id)
      .then((d) => {
        setDetail(d);
        setRestStatus(d.status);
      })
      .catch((err) => {
        if (err instanceof ApiError) setLoadError(err.status);
        else setLoadError(-1);
      });
    api
      .getVisual(id)
      .then((frame) => setVisualFrame(frame.data))
      .catch(() => {
        /* 404 = no visual frame yet, fine */
      });
  }, [id]);

  // Merge REST-hydrated stats with WS-streamed stats.
  const stats = useMemo<GenerationStats[]>(() => {
    const base = detail?.stats ?? [];
    if (stream.stats.length === 0) return base;
    const lastBase = base[base.length - 1]?.generation ?? -1;
    const extra = stream.stats.filter((s) => s.generation > lastBase);
    return [...base, ...extra];
  }, [detail, stream.stats]);

  const status: RunStatus | null = stream.status ?? restStatus;
  const live = status === "running" || status === "paused" || status === "pending";

  const sendControl = useCallback(
    async (action: RunControlAction) => {
      setControlError(null);
      try {
        const res = await api.controlRun(id, action);
        setRestStatus(res.status);
        if (action === "step") {
          // Step emits a single generation; give WS a moment, but also refresh detail.
          const d = await api.getRun(id);
          setDetail(d);
        }
      } catch (err) {
        setControlError((err as Error).message);
      }
    },
    [id],
  );

  const currentGen = stats[stats.length - 1]?.generation ?? detail?.currentGeneration ?? 0;
  const currentBest =
    stream.lastBest?.fitness ??
    stats[stats.length - 1]?.bestFitness ??
    detail?.finalBestFitness;
  const elapsedTotal = detail
    ? (detail.finishedAt ?? (live ? Date.now() : detail.finishedAt ?? detail.createdAt)) - detail.createdAt
    : null;

  const visualData =
    stream.lastBest?.genome ?? stats[stats.length - 1]?.bestGenome ?? visualFrame;

  if (loadError === 404) {
    return (
      <div className="mx-auto max-w-md py-20 text-center">
        <div className="mono mb-2 text-5xl">404</div>
        <p className="text-sm text-muted">
          Run <span className="mono text-foreground">{id}</span> was not found.
        </p>
        <Link href="/runs" className="mt-4 inline-block text-sm text-accent hover:underline">
          ← Back to runs
        </Link>
      </div>
    );
  }

  if (loadError !== null) {
    return (
      <div className="mx-auto max-w-md py-20 text-center">
        <p className="text-sm text-danger">Failed to load run (error {loadError}).</p>
        <Link href="/runs" className="mt-4 inline-block text-sm text-accent hover:underline">
          ← Back to runs
        </Link>
      </div>
    );
  }

  if (!detail) {
    return <p className="py-16 text-center text-sm text-muted">Loading run…</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mono text-lg font-semibold">
          {detail.config.problem.id}
          <span className="text-muted"> / </span>
          {detail.config.encoding.id}
        </h1>
        {status && <StatusBadge status={status} />}
        {stream.connected && live && (
          <Badge tone="accent">ws live</Badge>
        )}
        <span className="mono ml-auto text-xs text-muted">{detail.id}</span>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_400px]">
        {/* Left column — charts */}
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Fitness</CardTitle>
            </CardHeader>
            {stats.length > 0 ? (
              <FitnessChart stats={stats} />
            ) : (
              <EmptyChart label="Waiting for generations…" />
            )}
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Diversity</CardTitle>
            </CardHeader>
            {stats.length > 0 ? (
              <DiversityChart stats={stats} />
            ) : (
              <EmptyChart label="Waiting for generations…" height={160} />
            )}
          </Card>
        </div>

        {/* Right column — controls, visualizer, genome, stats */}
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Control</CardTitle>
              {status && <StatusBadge status={status} />}
            </CardHeader>
            <div className="flex flex-wrap gap-2">
              {status === "running" && (
                <Button size="sm" variant="secondary" onClick={() => { void sendControl("pause"); }}>
                  ⏸ Pause
                </Button>
              )}
              {(status === "paused" || status === "pending") && (
                <Button size="sm" onClick={() => { void sendControl("resume"); }}>
                  ▶ Resume
                </Button>
              )}
              {status === "paused" && (
                <Button size="sm" variant="outline" onClick={() => { void sendControl("step"); }}>
                  ⏭ Step
                </Button>
              )}
              {live && (
                <Button size="sm" variant="danger" onClick={() => { void sendControl("stop"); }}>
                  ■ Stop
                </Button>
              )}
              {!live && detail.finishedAt && (
                <span className="text-xs text-muted">
                  Finished {formatTime(detail.finishedAt)}
                </span>
              )}
            </div>
            {controlError && (
              <p className="mono mt-2 rounded border border-danger/40 bg-danger/10 p-2 text-[11px] text-danger">
                {controlError}
              </p>
            )}
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Best genome visual</CardTitle>
              <span className="mono text-[10px] text-muted">
                {detail.config.problem.id}
              </span>
            </CardHeader>
            <ProblemVisual problemId={detail.config.problem.id} data={visualData} />
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Best genome</CardTitle>
              {stream.lastBest && (
                <span className="mono text-[10px] text-muted">
                  gen {stream.lastBest.generation}
                </span>
              )}
            </CardHeader>
            <GenomeInspector genome={stream.lastBest?.genome ?? stats[stats.length - 1]?.bestGenome} />
          </Card>

          <div className="grid grid-cols-3 gap-2">
            <StatCard label="Generation" value={String(currentGen)} />
            <StatCard label="Best fitness" value={formatFitness(currentBest)} />
            <StatCard label="Elapsed" value={formatElapsed(elapsedTotal)} />
          </div>

          {stream.finished && (
            <Card>
              <CardHeader>
                <CardTitle>Finished</CardTitle>
              </CardHeader>
              <p className="text-sm">
                Reason: <span className="mono text-accent-2">{stream.finished.reason}</span>
              </p>
              <p className="mt-1 text-sm text-muted">
                final best {formatFitness(stream.finished.finalBestFitness)} after{" "}
                {stream.finished.generations} generations
              </p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3 text-center">
      <div className="text-[10px] uppercase tracking-widest text-muted">{label}</div>
      <div className="mono mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}

function GenomeInspector({ genome }: { genome: unknown }) {
  if (genome === undefined || genome === null) {
    return <p className="text-xs text-muted">No genome yet.</p>;
  }
  return (
    <pre className="mono max-h-48 overflow-auto rounded-md border border-border bg-background p-3 text-[11px] text-accent-2">
      {typeof genome === "string" ? genome : JSON.stringify(genome, null, 2)}
    </pre>
  );
}

function EmptyChart({ label, height = 280 }: { label: string; height?: number }) {
  return (
    <div
      className="flex items-center justify-center rounded-md border border-dashed border-border text-xs text-muted"
      style={{ height }}
    >
      {label}
    </div>
  );
}
