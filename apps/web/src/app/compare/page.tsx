"use client";

import { Suspense, use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { RunDetail } from "@genebaer/shared-types";
import { api } from "@/lib/api";
import { formatFitness } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const PALETTE = ["#38d9a9", "#7c6cf0", "#f0b429", "#ef5766"];

function runLabel(run: RunDetail): string {
  const { problem, selection, seed, populationSize } = run.config;
  return `${problem.id} · ${selection.id} · seed=${seed} · pop=${populationSize}`;
}

function CompareInner({ ids }: { ids: string[] }) {
  const [runs, setRuns] = useState<RunDetail[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    // Fire-and-forget: every rejection is already handled per-id below.
    void Promise.all(
      ids.map((id) =>
        api.getRun(id).catch((err) => {
          setErrors((prev) => [...prev, `${id}: ${(err as Error).message}`]);
          return null;
        }),
      ),
    ).then((results) => {
      setRuns(results.filter((r): r is RunDetail => r !== null));
    });
  }, [ids]);

  // Overlay chart data: one row per generation index, one dataKey per run.
  const chartData = useMemo(() => {
    if (!runs) return [];
    const maxLen = Math.max(...runs.map((r) => r.stats.length), 0);
    const rows: Record<string, number>[] = [];
    for (let g = 0; g < maxLen; g++) {
      const row: Record<string, number> = { generation: g };
      runs.forEach((run, i) => {
        const stat = run.stats[g];
        if (stat) row[`run${i}`] = stat.bestFitness;
      });
      rows.push(row);
    }
    return rows;
  }, [runs]);

  // Config diff: fields whose stringified value differs across runs.
  const diffRows = useMemo(() => {
    if (!runs || runs.length < 2) return [];
    const flatten = (config: RunDetail["config"]): Record<string, string> => ({
      "problem.id": config.problem.id,
      "problem.params": JSON.stringify(config.problem.params ?? {}),
      "encoding.id": config.encoding.id,
      "encoding.params": JSON.stringify(config.encoding.params ?? {}),
      "selection.id": config.selection.id,
      "selection.params": JSON.stringify(config.selection.params ?? {}),
      "crossover.id": config.crossover.id,
      "crossover.params": JSON.stringify(config.crossover.params ?? {}),
      "mutation.id": config.mutation.id,
      "mutation.params": JSON.stringify(config.mutation.params ?? {}),
      mutationRate: String(config.mutationRate),
      populationSize: String(config.populationSize),
      elitism: String(config.elitism),
      termination: JSON.stringify(config.termination),
      seed: String(config.seed),
    });
    const flattened = runs.map((r) => flatten(r.config));
    const keys = Object.keys(flattened[0]!);
    return keys
      .filter((key) => new Set(flattened.map((f) => f[key])).size > 1)
      .map((key) => ({ key, values: flattened.map((f) => f[key] ?? "") }));
  }, [runs]);

  if (!runs) {
    return <p className="py-16 text-center text-sm text-muted">Loading runs…</p>;
  }

  if (runs.length === 0) {
    return (
      <div className="mx-auto max-w-md py-20 text-center">
        <p className="text-sm text-danger">None of the requested runs could be loaded.</p>
        <Link href="/runs" className="mt-4 inline-block text-sm text-accent hover:underline">
          ← Back to runs
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">
        Comparing {runs.length} run{runs.length > 1 ? "s" : ""}
      </h1>

      {errors.length > 0 && (
        <p className="mono rounded-md border border-warn/40 bg-warn/10 p-3 text-xs text-warn">
          {errors.join(" · ")}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Best fitness overlay</CardTitle>
          <div className="flex flex-wrap gap-2">
            {runs.map((run, i) => (
              <Link key={run.id} href={`/runs/${run.id}`}>
                <Badge tone="neutral">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: PALETTE[i % PALETTE.length] }}
                  />
                  {runLabel(run)}
                </Badge>
              </Link>
            ))}
          </div>
        </CardHeader>
        <ResponsiveContainer width="100%" height={360}>
          <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
            <CartesianGrid stroke="#26263a" strokeDasharray="3 3" />
            <XAxis dataKey="generation" tick={{ fill: "#8b8ba3", fontSize: 11 }} stroke="#26263a" />
            <YAxis tick={{ fill: "#8b8ba3", fontSize: 11 }} stroke="#26263a" width={60} />
            <Tooltip
              contentStyle={{
                backgroundColor: "#12121a",
                border: "1px solid #26263a",
                borderRadius: 8,
                fontSize: 12,
              }}
              labelStyle={{ color: "#8b8ba3" }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => {
              const idx = Number(String(v).replace("run", ""));
              const run = runs[idx];
              return run ? runLabel(run) : String(v);
            }} />
            {runs.map((run, i) => (
              <Line
                key={run.id}
                type="monotone"
                dataKey={`run${i}`}
                stroke={PALETTE[i % PALETTE.length]}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Config differences
            <span className="ml-2 text-[10px] normal-case tracking-normal text-muted">
              ({diffRows.length === 0 ? "configs identical" : `${diffRows.length} differing fields`})
            </span>
          </CardTitle>
        </CardHeader>
        {diffRows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wider text-muted">
                  <th className="px-3 py-2">Field</th>
                  {runs.map((run, i) => (
                    <th key={run.id} className="mono px-3 py-2">
                      <span
                        className="mr-1 inline-block h-2 w-2 rounded-full"
                        style={{ background: PALETTE[i % PALETTE.length] }}
                      />
                      {run.config.problem.id}/{run.config.encoding.id}
                      <span className="ml-1 text-muted">seed={run.config.seed}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {diffRows.map((row) => (
                  <tr key={row.key} className="border-b border-border/50">
                    <td className="mono px-3 py-2 text-muted">{row.key}</td>
                    {row.values.map((v, i) => (
                      <td key={i} className="mono px-3 py-2 text-xs">
                        {v}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted">
            All selected runs share the same configuration — only the outcomes differ
            {runs.every((r) => r.finalBestFitness === runs[0]?.finalBestFitness) &&
              ` (all reached ${formatFitness(runs[0]?.finalBestFitness)})`}
            .
          </p>
        )}
      </Card>
    </div>
  );
}

function CompareWithSearchParams({
  searchParams,
}: {
  searchParams: Promise<{ ids?: string }>;
}) {
  const sp = use(searchParams);
  const ids = (sp.ids ?? "").split(",").filter(Boolean).slice(0, 4);
  if (ids.length === 0) {
    return (
      <div className="mx-auto max-w-md py-20 text-center">
        <p className="text-sm text-muted">No run ids provided.</p>
        <Link href="/runs" className="mt-4 inline-block text-sm text-accent hover:underline">
          ← Back to runs
        </Link>
      </div>
    );
  }
  return <CompareInner ids={ids} />;
}

export default function ComparePage({
  searchParams,
}: {
  searchParams: Promise<{ ids?: string }>;
}) {
  return (
    <Suspense
      fallback={<p className="py-16 text-center text-sm text-muted">Loading…</p>}
    >
      <CompareWithSearchParams searchParams={searchParams} />
    </Suspense>
  );
}
