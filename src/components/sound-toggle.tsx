"use client";

import { useSyncExternalStore } from "react";
import { Volume2, VolumeX } from "lucide-react";
import { sounds } from "@/lib/sounds";

export function SoundToggle() {
  const enabled = useSyncExternalStore(
    (cb) => sounds.subscribe(cb),
    () => sounds.enabled,
    () => true,
  );

  return (
    <button
      type="button"
      aria-label={enabled ? "Mute sounds" : "Unmute sounds"}
      onClick={() => sounds.setEnabled(!enabled)}
      className="flex size-10 items-center justify-center rounded-xl text-muted-foreground transition-[color,background-color,scale] duration-150 hover:bg-muted hover:text-foreground active:scale-[0.96]"
    >
      {enabled ? (
        <Volume2 className="size-[18px]" />
      ) : (
        <VolumeX className="size-[18px]" />
      )}
    </button>
  );
}
