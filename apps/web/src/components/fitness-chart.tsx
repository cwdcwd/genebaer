"use client";

import type { GenerationStats } from "@genebaer/shared-types";
import {
  CartesianGrid,
  Legend,
  Line,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  LineChart,
} from "recharts";

const tooltipStyle = {
  backgroundColor: "#12121a",
  border: "1px solid #26263a",
  borderRadius: 8,
  fontSize: 12,
} as const;

const axisStyle = { fill: "#8b8ba3", fontSize: 11 } as const;

export function FitnessChart({ stats }: { stats: GenerationStats[] }) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart data={stats} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <CartesianGrid stroke="#26263a" strokeDasharray="3 3" />
        <XAxis dataKey="generation" tick={axisStyle} stroke="#26263a" />
        <YAxis tick={axisStyle} stroke="#26263a" width={60} />
        <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: "#8b8ba3" }} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Line
          type="monotone"
          dataKey="bestFitness"
          name="best"
          stroke="#38d9a9"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="meanFitness"
          name="mean"
          stroke="#7c6cf0"
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="worstFitness"
          name="worst"
          stroke="#ef5766"
          strokeWidth={1}
          strokeDasharray="4 4"
          dot={false}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export function DiversityChart({ stats }: { stats: GenerationStats[] }) {
  return (
    <ResponsiveContainer width="100%" height={160}>
      <LineChart data={stats} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <CartesianGrid stroke="#26263a" strokeDasharray="3 3" />
        <XAxis dataKey="generation" tick={axisStyle} stroke="#26263a" />
        <YAxis tick={axisStyle} stroke="#26263a" width={60} />
        <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: "#8b8ba3" }} />
        <Line
          type="monotone"
          dataKey="diversity"
          name="diversity"
          stroke="#f0b429"
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
