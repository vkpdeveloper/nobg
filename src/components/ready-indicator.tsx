"use client";

import type { EngineStatus } from "@/lib/remover-pool";

export function ReadyIndicator({ engine }: { engine: EngineStatus }) {
  if (engine.state === "ready") {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="size-1.5 rounded-full bg-emerald-500" />
        Ready
      </div>
    );
  }
  if (engine.state === "error") {
    return (
      <div className="text-xs text-destructive/80">
        Unavailable in this browser
      </div>
    );
  }
  const pct = Math.round(engine.progress * 100);
  return (
    <div className="flex items-center gap-2.5">
      <span className="text-xs text-muted-foreground">
        Preparing…
        {pct > 0 && <span className="tabular-nums"> {pct}%</span>}
      </span>
      <span className="h-0.5 w-[120px] overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full rounded-full bg-foreground/40 transition-[width] duration-300"
          style={{ width: `${Math.max(pct, 4)}%` }}
        />
      </span>
    </div>
  );
}
