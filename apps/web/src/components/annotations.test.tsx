import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Annotations } from "./annotations";
import type { RunAnnotation } from "@/lib/use-run-stream";

afterEach(cleanup);

const caption = (generation: number, text: string): RunAnnotation => ({
  generation,
  kind: "caption",
  text,
});

describe("Annotations", () => {
  it("explains how to get captions when there are none", () => {
    // Silence would read as "broken" rather than "not configured".
    render(<Annotations annotations={[]} />);
    expect(screen.getByText(/captionEvery/)).toBeDefined();
  });

  it("shows the newest caption with the generation it describes", () => {
    // A caption detached from its generation cannot be compared against the
    // fitness curve, which is the whole reason to read it.
    render(<Annotations annotations={[caption(50, "a red blob on white")]} />);
    expect(screen.getByText("a red blob on white")).toBeDefined();
    expect(screen.getByText(/generation 50/i)).toBeDefined();
  });

  it("keeps older captions available rather than overwriting silently", () => {
    render(
      <Annotations
        annotations={[caption(50, "newest"), caption(25, "older"), caption(0, "oldest")]}
      />,
    );
    expect(screen.getByText("newest")).toBeDefined();
    expect(screen.getByText(/2 earlier/)).toBeDefined();
    expect(screen.getByText(/older/)).toBeDefined();
    expect(screen.getByText(/oldest/)).toBeDefined();
  });

  it("does not offer a history section for a single caption", () => {
    render(<Annotations annotations={[caption(10, "only one")]} />);
    expect(screen.queryByText(/earlier/)).toBeNull();
  });
});
