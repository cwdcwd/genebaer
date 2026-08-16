import { describe, expect, it } from "vitest";
import type { OperatorMeta } from "@genebaer/shared-types";
import {
  BROWSER_EVALUATOR_ID,
  capabilityFromOperators,
  unsupportedMessage,
} from "./worker-capability";

function evaluatorMeta(over: Partial<OperatorMeta> = {}): OperatorMeta {
  return {
    id: BROWSER_EVALUATOR_ID,
    kind: "evaluator",
    displayName: "CLIP similarity",
    description: "Scores an image against a prompt.",
    paramsSchema: {},
    version: "clip-vit-base-patch32.2",
    ...over,
  };
}

/**
 * Metadata with no `version` key at all.
 *
 * Under exactOptionalPropertyTypes, `version: undefined` is not the same thing
 * as an absent key — and absent is what a server that never set one actually
 * sends, so that is what these tests must exercise.
 */
function versionlessMeta(over: Partial<OperatorMeta> = {}): OperatorMeta {
  const { version: _version, ...rest } = evaluatorMeta(over);
  return rest;
}

describe("resolving the capability from server metadata", () => {
  it("takes whatever version the server declares", () => {
    // The point of the whole change: the browser follows the server. A bump on
    // the server must not need a matching edit here.
    expect(capabilityFromOperators([evaluatorMeta({ version: "anything.9" })])).toEqual({
      evaluatorId: BROWSER_EVALUATOR_ID,
      version: "anything.9",
    });
  });

  it("ignores operators of other kinds that share the id", () => {
    const problem = evaluatorMeta({ kind: "problem", version: "wrong" });
    expect(capabilityFromOperators([problem])).toBeNull();
  });

  it("picks the evaluator out of a full registry listing", () => {
    const operators: OperatorMeta[] = [
      evaluatorMeta({ id: "local", version: "1" }),
      versionlessMeta({ kind: "problem", id: "one-max" }),
      evaluatorMeta(),
    ];
    expect(capabilityFromOperators(operators)?.version).toBe("clip-vit-base-patch32.2");
  });
});

describe("refusing to guess", () => {
  it("returns null when the server has no such evaluator", () => {
    // Registering anyway is the bug being fixed: the worker would be accepted
    // and then never offered a job, which reads as "no work available".
    expect(capabilityFromOperators([])).toBeNull();
    expect(
      capabilityFromOperators([evaluatorMeta({ id: "some-other-evaluator" })]),
    ).toBeNull();
  });

  it("returns null when the evaluator reports no version", () => {
    expect(capabilityFromOperators([versionlessMeta()])).toBeNull();
    expect(capabilityFromOperators([evaluatorMeta({ version: "" })])).toBeNull();
  });

  it("explains which of the two situations happened", () => {
    // "not registered" and "registered but versionless" need different fixes,
    // so one generic message would send a reader down the wrong path.
    expect(unsupportedMessage([])).toMatch(/no 'clip-similarity' evaluator registered/);
    expect(unsupportedMessage([versionlessMeta()])).toMatch(/did not report a version/);
  });
});
