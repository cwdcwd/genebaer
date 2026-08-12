import type { RunStatus } from "@genebaer/shared-types";
import { cn } from "@/lib/utils";

export function Badge({
  className,
  tone = "neutral",
  children,
}: {
  className?: string;
  tone?: "neutral" | "ok" | "warn" | "danger" | "accent";
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        tone === "neutral" && "border-border bg-surface-2 text-muted",
        tone === "ok" && "border-accent-2/30 bg-accent-2/10 text-accent-2",
        tone === "warn" && "border-warn/30 bg-warn/10 text-warn",
        tone === "danger" && "border-danger/30 bg-danger/10 text-danger",
        tone === "accent" && "border-accent/30 bg-accent/10 text-accent",
        className,
      )}
    >
      {children}
    </span>
  );
}

const statusTone: Record<RunStatus, { tone: "neutral" | "ok" | "warn" | "danger" | "accent"; dot?: boolean }> = {
  pending: { tone: "neutral" },
  running: { tone: "accent", dot: true },
  paused: { tone: "warn" },
  finished: { tone: "ok" },
  stopped: { tone: "neutral" },
  error: { tone: "danger" },
};

export function StatusBadge({ status }: { status: RunStatus }) {
  const { tone, dot } = statusTone[status];
  return (
    <Badge tone={tone}>
      {dot && <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />}
      {status}
    </Badge>
  );
}
