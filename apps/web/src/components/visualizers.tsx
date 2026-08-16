"use client";

import { useEffect, useRef } from "react";

/* ------------------------------------------------------------------ */
/* Shared canvas scaffolding                                           */
/* ------------------------------------------------------------------ */

function Canvas({
  height = 280,
  draw,
  deps,
}: {
  height?: number;
  draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => void;
  deps: unknown[];
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    draw(ctx, width, height);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return (
    <canvas
      ref={ref}
      style={{ width: "100%", height }}
      className="rounded-md border border-border bg-background"
    />
  );
}

/* ------------------------------------------------------------------ */
/* one-max — row of glowing cells (lit = 1)                            */
/* ------------------------------------------------------------------ */

export function OneMaxVisual({ bits }: { bits: number[] }) {
  return (
    <div className="flex flex-wrap gap-1 rounded-md border border-border bg-background p-3">
      {bits.map((b, i) => (
        <div
          key={i}
          className="rounded-sm transition-all duration-150"
          style={{
            width: bits.length > 128 ? 6 : 12,
            height: bits.length > 128 ? 6 : 12,
            background: b ? "#38d9a9" : "#1a1a26",
            boxShadow: b ? "0 0 6px 1px rgba(56,217,169,0.7)" : "none",
          }}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* weasel — monospace diff, matched chars highlighted                  */
/* ------------------------------------------------------------------ */

export function WeaselVisual({
  current,
  target,
}: {
  current: string;
  target: string;
}) {
  return (
    <div className="mono rounded-md border border-border bg-background p-3 text-sm leading-8 tracking-wider">
      <div className="mb-1 text-[10px] uppercase tracking-widest text-muted">best</div>
      <div>
        {current.split("").map((ch, i) => {
          const hit = ch === target[i];
          return (
            <span
              key={i}
              className={
                hit
                  ? "text-accent-2"
                  : "text-muted/60"
              }
              style={hit ? { textShadow: "0 0 8px rgba(56,217,169,0.8)" } : undefined}
            >
              {ch === " " ? " " : ch}
            </span>
          );
        })}
      </div>
      <div className="mt-2 text-[10px] uppercase tracking-widest text-muted">target</div>
      <div className="text-foreground/80">{target}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* sphere / rastrigin — 2D projection of first two vector components   */
/* ------------------------------------------------------------------ */

function VectorVisual({ vec }: { vec: number[] }) {
  return (
    <Canvas
      height={280}
      deps={[...vec]}
      draw={(ctx, w, h) => {
        // Gradient backdrop approximating a fitness landscape.
        const grad = ctx.createRadialGradient(w / 2, h / 2, 4, w / 2, h / 2, w / 1.8);
        grad.addColorStop(0, "rgba(124,108,240,0.28)");
        grad.addColorStop(0.5, "rgba(124,108,240,0.08)");
        grad.addColorStop(1, "rgba(10,10,15,0)");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);

        // Grid + axes through origin.
        ctx.strokeStyle = "rgba(38,38,58,0.8)";
        ctx.lineWidth = 1;
        for (let x = 0; x <= w; x += w / 10) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, h);
          ctx.stroke();
        }
        for (let y = 0; y <= h; y += h / 10) {
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
          ctx.stroke();
        }
        ctx.strokeStyle = "rgba(139,139,163,0.5)";
        ctx.beginPath();
        ctx.moveTo(w / 2, 0);
        ctx.lineTo(w / 2, h);
        ctx.moveTo(0, h / 2);
        ctx.lineTo(w, h / 2);
        ctx.stroke();

        // Scale to the data range (fallback domain [-5, 5] like sphere/rastrigin).
        const maxAbs = Math.max(5.12, ...vec.map((v) => Math.abs(v)));
        const scale = Math.min(w, h) / (2 * maxAbs * 1.1);
        const x0 = vec[0] ?? 0;
        const y0 = vec[1] ?? 0;
        const px = w / 2 + x0 * scale;
        const py = h / 2 - y0 * scale;

        // Line from origin (optimum) to current best.
        ctx.strokeStyle = "rgba(56,217,169,0.7)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(w / 2, h / 2);
        ctx.lineTo(px, py);
        ctx.stroke();

        // Optimum marker.
        ctx.fillStyle = "rgba(239,87,102,0.9)";
        ctx.beginPath();
        ctx.arc(w / 2, h / 2, 4, 0, Math.PI * 2);
        ctx.fill();

        // Best point with glow.
        ctx.shadowColor = "#38d9a9";
        ctx.shadowBlur = 12;
        ctx.fillStyle = "#38d9a9";
        ctx.beginPath();
        ctx.arc(px, py, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;

        // Component bars along the bottom for dimensions beyond 2.
        if (vec.length > 2) {
          const barH = 34;
          const n = Math.min(vec.length, 24);
          const bw = w / n;
          for (let i = 0; i < n; i++) {
            const v = vec[i] ?? 0;
            const bh = (v / maxAbs) * barH;
            ctx.fillStyle =
              i < 2 ? "#38d9a9" : "rgba(124,108,240,0.6)";
            ctx.fillRect(i * bw + 1, h - (v >= 0 ? 0 : barH) - Math.min(0, bh), bw - 2, Math.abs(bh) || 1);
          }
        }

        ctx.fillStyle = "rgba(139,139,163,0.9)";
        ctx.font = "10px ui-monospace, monospace";
        ctx.fillText(
          `x=${x0.toFixed(3)}  y=${y0.toFixed(3)}${vec.length > 2 ? `  (dim ${vec.length})` : ""}`,
          8,
          14,
        );
      }}
    />
  );
}

/* ------------------------------------------------------------------ */
/* mds — graph with selected & dominated vertices highlighted          */
/* ------------------------------------------------------------------ */

interface MdsData {
  graph: { n: number; edges: [number, number][] };
  selected: number[];
}

function MdsVisual({ data }: { data: MdsData }) {
  const { graph, selected } = data;
  return (
    <Canvas
      height={300}
      deps={[graph.n, graph.edges.length, selected.join(",")]}
      draw={(ctx, w, h) => {
        const n = graph.n;
        if (n === 0) return;
        const sel = new Set(selected);
        // Dominated = adjacent to a selected vertex (but not selected themselves).
        const dominated = new Set<number>();
        for (const [a, b] of graph.edges) {
          if (sel.has(a) && !sel.has(b)) dominated.add(b);
          if (sel.has(b) && !sel.has(a)) dominated.add(a);
        }

        // Circular layout.
        const cx = w / 2;
        const cy = h / 2;
        const r = Math.min(w, h) / 2 - 30;
        const pos: [number, number][] = [];
        for (let i = 0; i < n; i++) {
          const angle = (2 * Math.PI * i) / n - Math.PI / 2;
          pos.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
        }

        // Edges.
        for (const [a, b] of graph.edges) {
          const pa = pos[a];
          const pb = pos[b];
          if (!pa || !pb) continue;
          const hot = sel.has(a) || sel.has(b);
          ctx.strokeStyle = hot ? "rgba(124,108,240,0.55)" : "rgba(38,38,58,0.9)";
          ctx.lineWidth = hot ? 1.4 : 1;
          ctx.beginPath();
          ctx.moveTo(pa[0], pa[1]);
          ctx.lineTo(pb[0], pb[1]);
          ctx.stroke();
        }

        // Vertices.
        const radius = n > 60 ? 4 : 8;
        for (let i = 0; i < n; i++) {
          const p = pos[i]!;
          const isSel = sel.has(i);
          const isDom = dominated.has(i);
          if (isSel) {
            ctx.shadowColor = "#38d9a9";
            ctx.shadowBlur = 12;
          }
          ctx.fillStyle = isSel ? "#38d9a9" : isDom ? "#7c6cf0" : "#26263a";
          ctx.beginPath();
          ctx.arc(p[0], p[1], radius, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
          ctx.strokeStyle = "rgba(139,139,163,0.4)";
          ctx.stroke();
        }

        // Legend.
        ctx.font = "10px ui-monospace, monospace";
        ctx.fillStyle = "#38d9a9";
        ctx.fillText("● selected", 8, 14);
        ctx.fillStyle = "#7c6cf0";
        ctx.fillText("● dominated", 8, 28);
        ctx.fillStyle = "rgba(139,139,163,0.9)";
        ctx.fillText(
          `${sel.size}/${n} covered-ish | selected=${sel.size}`,
          8,
          h - 8,
        );
      }}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Dispatcher keyed by problem id                                      */
/* ------------------------------------------------------------------ */

function isNumberArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((x) => typeof x === "number");
}

/* ------------------------------------------------------------------ */
/* image-prompt — the evolved image itself                             */
/* ------------------------------------------------------------------ */

export interface ImageFrame {
  width: number;
  height: number;
  channels: number;
  prompt?: string;
  /** Raw RGB bytes, width * height * 3. */
  rgb: number[];
}

/** True when a frame's byte count matches the dimensions it declares. */
export function isImageFrame(data: unknown): data is ImageFrame {
  if (typeof data !== "object" || data === null) return false;
  const f = data as Partial<ImageFrame>;
  if (!Number.isInteger(f.width) || !Number.isInteger(f.height)) return false;
  if ((f.width ?? 0) < 1 || (f.height ?? 0) < 1) return false;
  if (!Array.isArray(f.rgb)) return false;
  // A mismatch would render a skewed or truncated image that still looks
  // plausible, which is worse than rendering nothing.
  return f.rgb.length === (f.width ?? 0) * (f.height ?? 0) * 3;
}

/**
 * Pack RGB bytes into the RGBA buffer a canvas wants, opaque throughout.
 *
 * Pure and exported so it can actually be tested: jsdom does not implement
 * `getContext`, so a test that only mounts the component proves it did not
 * crash and nothing more. This is where the pixels are actually decided.
 */
export function toRgba(frame: ImageFrame): Uint8ClampedArray {
  const pixels = frame.width * frame.height;
  const out = new Uint8ClampedArray(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    out[i * 4] = frame.rgb[i * 3] ?? 0;
    out[i * 4 + 1] = frame.rgb[i * 3 + 1] ?? 0;
    out[i * 4 + 2] = frame.rgb[i * 3 + 2] ?? 0;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** Letterboxed placement, so a non-square genome is never stretched. */
export function fitRect(
  frame: { width: number; height: number },
  boxW: number,
  boxH: number,
): { x: number; y: number; width: number; height: number } {
  const scale = Math.min(boxW / frame.width, boxH / frame.height);
  const width = frame.width * scale;
  const height = frame.height * scale;
  return { x: (boxW - width) / 2, y: (boxH - height) / 2, width, height };
}

export function ImageVisual({ frame }: { frame: ImageFrame }) {
  return (
    <Canvas
      height={280}
      deps={[frame.width, frame.height, frame.rgb]}
      draw={(ctx, width, height) => {
        ctx.clearRect(0, 0, width, height);

        // Build the image at its true size, then blit it scaled. Drawing
        // pixel-by-pixel at display size would blur genome structure away.
        const source = ctx.createImageData(frame.width, frame.height);
        source.data.set(toRgba(frame));

        // Letterbox to preserve aspect ratio; a stretched genome misleads.
        const box = fitRect(frame, width, height);

        const offscreen = document.createElement("canvas");
        offscreen.width = frame.width;
        offscreen.height = frame.height;
        const octx = offscreen.getContext("2d");
        if (!octx) return;
        octx.putImageData(source, 0, 0);

        // Nearest-neighbour: at 32x32 the individual genes ARE the content,
        // and smoothing would hide exactly what the run is doing.
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(offscreen, box.x, box.y, box.width, box.height);
      }}
    />
  );
}

export function ProblemVisual({
  problemId,
  data,
}: {
  problemId: string;
  data: unknown;
}) {
  if (data === null || data === undefined) {
    return (
      <div className="flex h-40 items-center justify-center rounded-md border border-dashed border-border text-xs text-muted">
        Waiting for first best genome…
      </div>
    );
  }

  switch (problemId) {
    case "image-prompt":
      // A frame whose byte count does not match its dimensions renders nothing
      // rather than a skewed image that still looks plausible.
      return isImageFrame(data) ? (
        <ImageVisual frame={data} />
      ) : (
        <FallbackVisual data={data} />
      );
    case "one-max":
      return isNumberArray(data) ? (
        <OneMaxVisual bits={data} />
      ) : (
        <FallbackVisual data={data} />
      );
    case "weasel": {
      const d = data as { current?: string; target?: string };
      return typeof d?.current === "string" && typeof d?.target === "string" ? (
        <WeaselVisual current={d.current} target={d.target} />
      ) : (
        <FallbackVisual data={data} />
      );
    }
    case "sphere":
    case "rastrigin":
      return isNumberArray(data) ? (
        <VectorVisual vec={data} />
      ) : (
        <FallbackVisual data={data} />
      );
    case "mds": {
      const d = data as MdsData;
      return d?.graph && Array.isArray(d.selected) ? (
        <MdsVisual data={d} />
      ) : (
        <FallbackVisual data={data} />
      );
    }
    default:
      return <FallbackVisual data={data} />;
  }
}

function FallbackVisual({ data }: { data: unknown }) {
  return (
    <pre className="mono max-h-64 overflow-auto rounded-md border border-border bg-background p-3 text-[11px] text-accent-2">
      {typeof data === "string" ? data : JSON.stringify(data, null, 2)}
    </pre>
  );
}
