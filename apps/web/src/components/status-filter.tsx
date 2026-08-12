"use client";

import type { RunStatus } from "@genebaer/shared-types";
import { Select } from "./ui/select";

/**
 * Dropdown to filter runs by status. Extracted as its own component because the
 * runs page previously re-mutated DOM in-place; keeping the selector isolated
 * keeps the history table render pure.
 */
export function StatusFilter({
  value,
  onChange,
}: {
  value: string;
  onChange: (status: string) => void;
}) {
  const statuses: (RunStatus | "all")[] = [
    "all",
    "running",
    "paused",
    "finished",
    "stopped",
    "error",
    "pending",
  ];
  return (
    <Select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-36"
      aria-label="Filter by status"
    >
      {statuses.map((s) => (
        <option key={s} value={s}>
          {s === "all" ? "All statuses" : s}
        </option>
      ))}
    </Select>
  );
}
