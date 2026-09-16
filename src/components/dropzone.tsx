"use client";

import { useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { cn } from "cn";
import { sounds } from "@/lib/sounds";
import type { EngineStatus } from "@/lib/remover-pool";
import { ReadyIndicator } from "./ready-indicator";

export function Dropzone({
  onFiles,
  engine,
}: {
  onFiles: (files: File[]) => void;
  engine: EngineStatus;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const onFilesRef = useRef(onFiles);

  useEffect(() => {
    onFilesRef.current = onFiles;
  }, [onFiles]);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.items ?? [])
        .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
        .map((i) => i.getAsFile())
        .filter((f): f is File => f !== null);
      if (files.length > 0) {
        sounds.unlock();
        onFilesRef.current(files);
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Upload images"
      onClick={() => {
        sounds.unlock();
        inputRef.current?.click();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          sounds.unlock();
          inputRef.current?.click();
        }
      }}
      onDragEnter={(e) => {
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        sounds.unlock();
        onFiles(Array.from(e.dataTransfer.files));
      }}
      className={cn(
        "relative flex min-h-64 w-full cursor-pointer flex-col items-center justify-center gap-3 rounded-3xl px-6 py-12 text-center outline-none transition-[border-color,background-color,box-shadow] duration-200 focus-visible:ring-3 focus-visible:ring-ring/50",
        dragging
          ? "border-2 border-solid border-foreground/30 bg-accent/60 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-8px_rgb(0_0_0/0.12),inset_0_0_0_1px_rgb(255_255_255/0.06)]"
          : "border-2 border-dashed border-border bg-card/50 shadow-[0_1px_2px_rgb(0_0_0/0.03),0_4px_16px_-6px_rgb(0_0_0/0.06)] hover:border-foreground/20 hover:bg-card",
      )}
    >
      <div
        className={cn(
          "flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground transition-[scale,color] duration-200",
          dragging && "scale-110 text-foreground",
        )}
      >
        <Upload className="size-5" />
      </div>
      <div>
        <p className="font-medium">{engine.mobile ? "Tap to choose images" : "Drop images here"}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {engine.mobile ? "Standard size · up to 1536 px" : "or click to browse"}
        </p>
      </div>
      <p className="text-xs text-muted-foreground/80">
        {engine.mobile ? "PNG, JPG, WEBP · processed one at a time" : "PNG, JPG, WEBP · multiple files supported · ⌘/Ctrl+V to paste"}
      </p>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) onFiles(Array.from(e.target.files));
          e.target.value = "";
        }}
      />
      <div className="absolute bottom-4 left-5">
        <ReadyIndicator engine={engine} />
      </div>
    </div>
  );
}
