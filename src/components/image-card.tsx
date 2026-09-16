"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Download, Loader2, X } from "lucide-react";
import { cn } from "cn";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Job } from "@/hooks/use-remover";

const clipboardSupported =
  typeof window !== "undefined" && "ClipboardItem" in window;

export function ImageCard({
  job,
  index,
  onRemove,
}: {
  job: Job;
  index: number;
  onRemove: (id: string) => void;
}) {
  const [comparing, setComparing] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const done = job.status === "done";

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  const copy = async () => {
    if (!job.resultBlob || !clipboardSupported) return;
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": job.resultBlob }),
      ]);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard write failed (permission denied etc.)
    }
  };

  const base = job.name.replace(/\.[^.]+$/, "") || "image";

  return (
    <div
      className="animate-card-enter overflow-hidden rounded-2xl border border-border/60 bg-card shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-12px_rgb(0_0_0/0.1)]"
      style={{ animationDelay: `${Math.min(index, 5) * 60}ms` }}
    >
      <div
        className="checkerboard group relative aspect-square select-none"
        onPointerDown={() => done && setComparing(true)}
        onPointerUp={() => setComparing(false)}
        onPointerLeave={() => setComparing(false)}
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* original */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={job.originalUrl}
          alt={job.name}
          draggable={false}
          className={cn(
            "absolute inset-0 size-full object-contain outline-1 -outline-offset-1 outline-black/10 transition-opacity duration-200 dark:outline-white/10",
            done && !comparing ? "opacity-0" : "opacity-100",
            !done && "opacity-60",
          )}
        />
        {/* result */}
        {job.resultUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={job.resultUrl}
            alt={`${job.name} without background`}
            draggable={false}
            className={cn(
              "absolute inset-0 size-full object-contain outline-1 -outline-offset-1 outline-black/10 transition-opacity duration-200 dark:outline-white/10",
              done && !comparing ? "opacity-100" : "opacity-0",
            )}
          />
        )}

        {!done && job.status !== "error" && (
          <div className="absolute inset-0 overflow-hidden">
            <div className="animate-shimmer absolute inset-y-0 w-1/2 bg-gradient-to-r from-transparent via-white/25 to-transparent dark:via-white/10" />
            <div className="absolute inset-x-0 bottom-3 flex justify-center">
              <span className="flex items-center gap-1.5 rounded-full bg-background/80 px-3 py-1 text-xs text-muted-foreground backdrop-blur-sm">
                {job.status === "processing" ? (
                  <>
                    <Loader2 className="size-3 animate-spin" />
                    Removing…
                  </>
                ) : (
                  "Queued"
                )}
              </span>
            </div>
          </div>
        )}

        {job.status === "error" && (
          <div className="absolute inset-x-0 bottom-3 flex justify-center">
            <span
              title={job.error}
              className="rounded-full bg-background/80 px-3 py-1 text-xs text-destructive backdrop-blur-sm"
            >
              Couldn&apos;t process this image
            </span>
          </div>
        )}

        {done && (
          <div className="badge-done pointer-events-none absolute right-2.5 top-2.5 flex size-7 items-center justify-center rounded-full bg-emerald-500 text-white shadow-md">
            <svg viewBox="0 0 24 24" className="size-4" fill="none">
              <path
                className="check-path"
                d="M5 13l4 4L19 7"
                stroke="currentColor"
                strokeWidth={3}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        )}

        {done && !comparing && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center opacity-0 transition-opacity duration-200 group-hover:opacity-100">
            <span className="rounded-full bg-background/80 px-3 py-1 text-xs text-muted-foreground backdrop-blur-sm">
              Hold to compare
            </span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 border-t border-border/60 px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">{job.name}</p>
          {job.width != null && job.height != null && (
            <p className="text-xs tabular-nums text-muted-foreground">
              {job.width}×{job.height}
            </p>
          )}
        </div>
        {clipboardSupported ? (
          <CardAction label="Copy" onClick={copy} disabled={!done}>
            <span className="relative flex size-4 items-center justify-center">
              <Copy
                className="absolute size-4 transition-[opacity,scale] duration-150"
                style={{ opacity: copied ? 0 : 1, scale: copied ? "0.25" : "1" }}
              />
              <Check
                className="absolute size-4 text-emerald-500 transition-[opacity,scale] duration-150"
                style={{ opacity: copied ? 1 : 0, scale: copied ? "1" : "0.25" }}
              />
            </span>
            {copied && <span className="text-xs">Copied</span>}
          </CardAction>
        ) : (
          <Tooltip>
            <TooltipTrigger render={<span className="flex" />}>
              <CardAction label="Copy" disabled>
                <Copy className="size-4" />
              </CardAction>
            </TooltipTrigger>
            <TooltipContent>Not supported in this browser</TooltipContent>
          </Tooltip>
        )}
        {done && job.resultUrl && (
          <a
            href={job.resultUrl}
            download={`${base}-nobg.png`}
            aria-label="Download"
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-[color,background-color,scale] duration-150 hover:bg-muted hover:text-foreground active:scale-[0.96]"
          >
            <Download className="size-4" />
          </a>
        )}
        <CardAction label="Remove" onClick={() => onRemove(job.id)}>
          <X className="size-4" />
        </CardAction>
      </div>
    </div>
  );
}

function CardAction({
  label,
  children,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      className={cn(
        "flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-lg px-1.5 text-muted-foreground transition-[color,background-color,scale] duration-150 hover:bg-muted hover:text-foreground active:scale-[0.96] disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
