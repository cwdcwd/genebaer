"use client";

import type { RunAnnotation } from "@/lib/use-run-stream";

/**
 * Captions of the best genome, newest first.
 *
 * A CLIP cosine similarity is a number with no human meaning — 0.19 tells you
 * nothing about whether a run is going anywhere. This is the part that answers
 * that question, so it shows the generation each caption describes: a caption
 * detached from its generation cannot be compared against the fitness curve.
 */
export function Annotations({ annotations }: { annotations: RunAnnotation[] }) {
  if (annotations.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted">
        No captions yet. Set <span className="mono">captionEvery</span> on the problem
        to have a model describe the best genome periodically.
      </div>
    );
  }

  const [latest, ...older] = annotations;
  return (
    <div className="space-y-2">
      <div className="rounded-md border border-border bg-background p-3">
        <div className="mb-1 text-[10px] uppercase tracking-widest text-muted">
          generation {latest!.generation}
        </div>
        <div className="text-sm text-foreground">{latest!.text}</div>
      </div>

      {older.length > 0 && (
        <details className="rounded-md border border-border bg-background/50">
          <summary className="cursor-pointer px-3 py-2 text-[10px] uppercase tracking-widest text-muted">
            {older.length} earlier
          </summary>
          <ul className="space-y-1 px-3 pb-3">
            {older.map((a) => (
              <li key={a.generation} className="text-xs text-muted">
                <span className="mono text-muted/70">gen {a.generation}</span>{" "}
                {a.text}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
