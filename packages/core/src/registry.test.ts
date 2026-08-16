import { describe, expect, it } from "vitest";
import { createDefaultRegistry } from "./defaults.js";
import type { FitnessProblem } from "./operators/problem/base.js";

describe("sizing an encoding to a problem", () => {
  it("names the param that sets genome size, per encoding", () => {
    // genebaer-7tu: it is "length" for binary and string but "dimensions" for
    // numeric. A hardcoded map in the UI would go stale the moment someone adds
    // an encoding, and silently — the run would just be the wrong size.
    const byId = new Map(
      createDefaultRegistry()
        .listMetadata("encoding")
        .map((m) => [m.id, m.sizeParam]),
    );
    expect(byId.get("binary")).toBe("length");
    expect(byId.get("string")).toBe("length");
    expect(byId.get("numeric")).toBe("dimensions");
  });

  it("gives every encoding a size param, so none is silently unsizable", () => {
    for (const meta of createDefaultRegistry().listMetadata("encoding")) {
      expect(meta.sizeParam, `${meta.id} declares no sizeParam`).toBeTruthy();
      expect(Object.keys(meta.paramsSchema)).toContain(meta.sizeParam);
    }
  });

  it("leaves sizeParam off operators that are not encodings", () => {
    for (const kind of ["problem", "selection", "mutation"] as const) {
      for (const meta of createDefaultRegistry().listMetadata(kind)) {
        expect(meta.sizeParam).toBeUndefined();
      }
    }
  });
});

describe("problems that fix their own genome length", () => {
  it("reports one gene per target character for weasel", () => {
    const registry = createDefaultRegistry();
    const weasel = registry.create<FitnessProblem<string[]>>("problem", "weasel", {
      target: "HELLO",
    });
    expect(weasel.requiredGenomeLength).toBe(5);
  });

  it("reports one gene per vertex for mds", () => {
    const registry = createDefaultRegistry();
    const mds = registry.create<FitnessProblem<number[]>>("problem", "mds", {
      graph: "petersen",
    });
    expect(mds.requiredGenomeLength).toBe(10);
  });

  it("reports null where any length genuinely works", () => {
    // OneMax and Sphere score whatever the encoding produces; claiming a
    // requirement would let the form overwrite a size the user chose on purpose.
    const registry = createDefaultRegistry();
    for (const id of ["one-max", "sphere", "rastrigin"]) {
      const problem = registry.create<FitnessProblem<unknown>>("problem", id, {});
      expect(problem.requiredGenomeLength, id).toBeNull();
    }
  });
});

describe("refusing a misconfigured problem", () => {
  it("rejects an unknown mds graph rather than quietly using another one", () => {
    // A typo used to yield the Petersen graph, so the run solved a different
    // problem than the one asked for and looked entirely healthy doing it.
    const registry = createDefaultRegistry();
    expect(() =>
      registry.create<FitnessProblem<number[]>>("problem", "mds", { graph: "cycle8" }),
    ).toThrow(/unknown graph/);
  });

  it("still takes the default when the param is simply absent", () => {
    const registry = createDefaultRegistry();
    const mds = registry.create<FitnessProblem<number[]>>("problem", "mds", {});
    expect(mds.requiredGenomeLength).toBe(10);
  });
});
