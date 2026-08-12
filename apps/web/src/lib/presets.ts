"use client";

import type { RunConfig } from "@genebaer/shared-types";

const STORAGE_KEY = "genebaer.presets";

function readAll(): Record<string, RunConfig> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, RunConfig>;
    }
    return {};
  } catch {
    return {};
  }
}

export function listPresets(): string[] {
  return Object.keys(readAll()).sort();
}

export function loadPreset(name: string): RunConfig | null {
  return readAll()[name] ?? null;
}

export function savePreset(name: string, config: RunConfig): void {
  const all = readAll();
  all[name] = config;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

export function deletePreset(name: string): void {
  const all = readAll();
  delete all[name];
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}
