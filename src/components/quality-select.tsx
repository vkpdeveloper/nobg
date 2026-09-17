"use client";

import { useSyncExternalStore } from "react";
import { removerPool } from "@/lib/remover-pool";
import { TIERS, TIER_ORDER, type Tier } from "@/lib/model-config";
import { track } from "@/lib/analytics";

export function QualitySelect() {
  const snapshot = useSyncExternalStore(
    (cb) => removerPool.onStatus(cb),
    () => `${removerPool.getQuality()}|${removerPool.getAutoTier()}`,
    () => "auto|",
  );
  const [quality, autoTier] = snapshot.split("|") as [Tier | "auto", Tier | ""];

  return (
    <select
      aria-label="Model quality"
      value={quality}
      onChange={(e) => {
        const value = e.target.value as Tier | "auto";
        removerPool.setQuality(value);
        track("quality_changed", { quality: value });
      }}
      className="h-10 rounded-xl bg-transparent px-2 text-sm text-muted-foreground transition-[color,background-color] duration-150 hover:bg-muted hover:text-foreground"
    >
      <option value="auto" title="Picked automatically from this device's capabilities.">
        {autoTier ? `Auto · ${TIERS[autoTier].label}` : "Auto"}
      </option>
      {TIER_ORDER.map((tier) => (
        <option key={tier} value={tier} title={TIERS[tier].description}>
          {TIERS[tier].label}
        </option>
      ))}
    </select>
  );
}
