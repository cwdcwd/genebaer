import { describe, expect, it } from "vitest";
import type { RunAnnotation } from "./use-run-stream";

/**
 * The reducer the hook applies for annotation messages, extracted so it can be
 * tested without standing up a WebSocket. Kept in step with use-run-stream.ts.
 */
const MAX_ANNOTATIONS = 20;
function applyAnnotation(
  prev: RunAnnotation[],
  msg: { generation: number; kind: "caption"; text: string },
): RunAnnotation[] {
  if (prev.some((a) => a.generation === msg.generation)) return prev;
  return [{ generation: msg.generation, kind: msg.kind, text: msg.text }, ...prev].slice(
    0,
    MAX_ANNOTATIONS,
  );
}

const msg = (generation: number, text: string) =>
  ({ generation, kind: "caption" as const, text });

describe("annotation accumulation", () => {
  it("keeps the newest first, so the run view leads with current state", () => {
    let s: RunAnnotation[] = [];
    s = applyAnnotation(s, msg(0, "noise"));
    s = applyAnnotation(s, msg(25, "a blurry shape"));
    expect(s.map((a) => a.generation)).toEqual([25, 0]);
  });

  it("ignores a repeat for a generation already annotated", () => {
    // useRunStream reconnects with backoff; a redelivered caption must not
    // appear twice in the history.
    let s: RunAnnotation[] = [];
    s = applyAnnotation(s, msg(25, "a blurry shape"));
    s = applyAnnotation(s, msg(25, "a blurry shape"));
    expect(s).toHaveLength(1);
  });

  it("caps the history — captions are a progress check, not a log", () => {
    let s: RunAnnotation[] = [];
    for (let g = 0; g < 50; g++) s = applyAnnotation(s, msg(g, `gen ${String(g)}`));
    expect(s).toHaveLength(MAX_ANNOTATIONS);
    // The cap drops the OLDEST, never the newest.
    expect(s[0]?.generation).toBe(49);
  });

  it("preserves the caption text verbatim", () => {
    const s = applyAnnotation([], msg(1, "a red blob on a white field"));
    expect(s[0]?.text).toBe("a red blob on a white field");
  });
});
