import { describe, expect, it } from "vitest";
import { createDefaultRegistry } from "@genebaer/core";
import { createServerRegistry } from "./registry.js";

describe("what a default server actually serves", () => {
  it("registers the image problem, which core cannot", () => {
    // The gap this closes: every test that exercised image runs built its own
    // registry and passed it in, so the feature worked in tests and was
    // unreachable from a running server — /api/problems simply did not list it.
    const ids = createServerRegistry()
      .listMetadata("problem")
      .map((m) => m.id);
    expect(ids).toContain("image-prompt");
  });

  it("registers the model-backed evaluator alongside the in-process one", () => {
    const ids = createServerRegistry()
      .listMetadata("evaluator")
      .map((m) => m.id);
    expect(ids).toContain("clip-similarity");
    // 'local' must survive: it is the default for a config omitting the field.
    expect(ids).toContain("local");
  });

  it("exposes the evaluator params the UI needs to offer", () => {
    // A registered evaluator whose params never reach the form is only half
    // reachable — 'augmentations' is the entire adversarial-robustness defence.
    const clip = createServerRegistry()
      .listMetadata("evaluator")
      .find((m) => m.id === "clip-similarity");
    expect(Object.keys(clip?.paramsSchema ?? {})).toEqual(
      expect.arrayContaining(["prompt", "augmentations"]),
    );
  });

  it("keeps everything core already provided", () => {
    // A server registry that *replaced* rather than extended the defaults would
    // silently drop one-max, weasel and friends.
    const server = createServerRegistry();
    for (const meta of createDefaultRegistry().listMetadata()) {
      expect(server.has(meta.kind, meta.id)).toBe(true);
    }
  });
});
