import type { RunConfig } from "@genebaer/shared-types";
import { beforeEach, describe, expect, it } from "vitest";
import { deletePreset, listPresets, loadPreset, savePreset } from "./presets";

const STORAGE_KEY = "genebaer.presets";

function config(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    problem: { id: "one-max" },
    encoding: { id: "binary" },
    selection: { id: "tournament" },
    crossover: { id: "one-point" },
    mutation: { id: "bit-flip" },
    mutationRate: 0.01,
    populationSize: 100,
    elitism: 2,
    termination: [{ id: "max-generations", params: { generations: 50 } }],
    seed: 123,
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("presets round-trip", () => {
  it("saves a config and loads it back intact", () => {
    const cfg = config({ seed: 999 });
    savePreset("baseline", cfg);
    expect(loadPreset("baseline")).toEqual(cfg);
  });

  it("returns null for a name that was never saved", () => {
    expect(loadPreset("missing")).toBeNull();
  });

  it("overwrites an existing preset of the same name", () => {
    savePreset("p", config({ seed: 1 }));
    savePreset("p", config({ seed: 2 }));
    expect(loadPreset("p")?.seed).toBe(2);
    expect(listPresets()).toEqual(["p"]);
  });
});

describe("listPresets", () => {
  it("returns an empty list when nothing is stored", () => {
    expect(listPresets()).toEqual([]);
  });

  it("sorts names rather than relying on insertion order", () => {
    savePreset("zeta", config());
    savePreset("alpha", config());
    savePreset("mid", config());
    expect(listPresets()).toEqual(["alpha", "mid", "zeta"]);
  });
});

describe("deletePreset", () => {
  it("removes only the named preset", () => {
    savePreset("keep", config());
    savePreset("drop", config());
    deletePreset("drop");
    expect(listPresets()).toEqual(["keep"]);
    expect(loadPreset("drop")).toBeNull();
  });

  it("is a no-op for an unknown name", () => {
    savePreset("keep", config());
    expect(() => deletePreset("nope")).not.toThrow();
    expect(listPresets()).toEqual(["keep"]);
  });
});

describe("corrupt storage", () => {
  it("degrades to empty rather than throwing on malformed JSON", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    expect(listPresets()).toEqual([]);
    expect(loadPreset("anything")).toBeNull();
  });

  it("ignores a stored value that is not an object", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify("a string"));
    expect(listPresets()).toEqual([]);
  });

  it("recovers by overwriting corrupt storage on the next save", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    savePreset("fresh", config());
    expect(listPresets()).toEqual(["fresh"]);
  });
});
