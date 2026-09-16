"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";

const EASE = "cubic-bezier(0.2,0,0,1)";
const noop = () => () => {};

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );

  const dark = mounted && resolvedTheme === "dark";

  return (
    <button
      type="button"
      aria-label="Toggle theme"
      onClick={() => setTheme(dark ? "light" : "dark")}
      className="relative flex size-10 items-center justify-center rounded-xl text-muted-foreground transition-[color,background-color,scale] duration-150 hover:bg-muted hover:text-foreground active:scale-[0.96]"
    >
      <Sun
        className="size-[18px] transition-[opacity,scale] duration-200"
        style={{
          transitionTimingFunction: EASE,
          opacity: dark ? 0 : 1,
          scale: dark ? "0.25" : "1",
        }}
      />
      <Moon
        className="absolute size-[18px] transition-[opacity,scale] duration-200"
        style={{
          transitionTimingFunction: EASE,
          opacity: dark ? 1 : 0,
          scale: dark ? "1" : "0.25",
        }}
      />
    </button>
  );
}
