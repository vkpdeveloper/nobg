"use client";

import { useEffect, useRef, useState } from "react";
import {
  Eraser,
  Hand,
  Lasso,
  Redo2,
  RotateCcw,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { Job } from "@/hooks/use-remover";
import type { Point } from "@/lib/cleanup/mask";
import type { EditorRequest, EditorResponse } from "@/lib/cleanup/protocol";

type Mode = "smart" | "erase" | "restore" | "pan";
const button =
  "inline-flex min-h-10 min-w-10 items-center justify-center gap-2 rounded-lg px-3 text-sm transition-[background-color,scale] hover:bg-muted active:scale-[0.96] disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 motion-reduce:transition-none";

export default function CleanupEditor({
  job,
  onClose,
  onApply,
}: {
  job: Job;
  onClose: () => void;
  onApply: (blob: Blob) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const worker = useRef<Worker | null>(null);
  const active = useRef<{
    id: number;
    points: Point[];
    last: Point;
    client: Point;
  } | null>(null);
  const brushPending = useRef<Point[]>([]);
  const brushInFlight = useRef(false);
  const releasePending = useRef(false);
  const sendBrush = useRef<() => void>(() => {});
  const [mode, setMode] = useState<Mode>("smart");
  const [size, setSize] = useState(40);
  const [hardness, setHardness] = useState(0.8);
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(1);
  const [dimensions, setDimensions] = useState({
    width: job.width ?? 1,
    height: job.height ?? 1,
  });
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });
  const [selection, setSelection] = useState({
    components: 0,
    pixels: 0,
    ambiguous: false,
  });
  const [path, setPath] = useState<Point[]>([]);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [changed, setChanged] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const applyRef = useRef(onApply);
  useEffect(() => {
    applyRef.current = onApply;
  }, [onApply]);

  const post = (message: EditorRequest) => worker.current?.postMessage(message);
  const command = (type: "clear" | "remove" | "undo" | "redo") => {
    if (!ready || busy || saving) return;
    setBusy(true);
    post({ type });
  };

  useEffect(() => {
    const node = dialog.current!;
    node.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const editorWorker = new Worker(
      new URL("../workers/cleanup.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.current = editorWorker;
    editorWorker.onmessage = (event: MessageEvent<EditorResponse>) => {
      const message = event.data;
      if (message.type === "error") {
        setError(message.message);
        setReady(false);
        active.current = null;
        editorWorker.terminate();
        setBusy(false);
        setSaving(false);
        return;
      }
      if (message.type === "export") {
        applyRef.current(message.blob);
        return;
      }
      const target = canvas.current;
      if (target) {
        if (target.width !== message.bitmap.width)
          target.width = message.bitmap.width;
        if (target.height !== message.bitmap.height)
          target.height = message.bitmap.height;
        const ctx = target.getContext("2d")!;
        ctx.clearRect(0, 0, target.width, target.height);
        ctx.drawImage(message.bitmap, 0, 0);
      }
      message.bitmap.close();
      setDimensions({ width: message.width, height: message.height });
      setHistory({ canUndo: message.canUndo, canRedo: message.canRedo });
      setSelection(message.selection);
      setReady(true);
      if (message.operation === "brush") {
        brushInFlight.current = false;
        sendBrush.current();
      } else if (message.operation !== "resize") {
        setBusy(!!active.current);
        if (["remove", "commit", "undo", "redo"].includes(message.operation))
          setChanged(true);
      }
    };
    editorWorker.onerror = () => {
      setError("The cleanup editor could not start. Close it and try again.");
      setReady(false);
      active.current = null;
      editorWorker.terminate();
      setBusy(false);
      setSaving(false);
    };
    editorWorker.postMessage({
      type: "init",
      blob: job.resultBlob!,
      base: job.cleanupBaseBlob ?? job.resultBlob!,
    } satisfies EditorRequest);
    return () => {
      editorWorker.terminate();
      worker.current = null;
      document.body.style.overflow = previousOverflow;
      node.close();
    };
  }, [job.resultBlob, job.cleanupBaseBlob]);

  useEffect(() => {
    const node = viewport.current!;
    const observer = new ResizeObserver(() =>
      setFit(
        Math.min(
          1,
          Math.max(1, node.clientWidth - 32) / dimensions.width,
          Math.max(1, node.clientHeight - 32) / dimensions.height,
        ),
      ),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [dimensions.width, dimensions.height]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "z" ||
        event.target instanceof HTMLInputElement
      )
        return;
      event.preventDefault();
      if (!ready || busy || saving) return;
      setBusy(true);
      worker.current?.postMessage({
        type: event.shiftKey ? "redo" : "undo",
      } satisfies EditorRequest);
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [ready, busy, saving]);

  const scale = fit * zoom;
  useEffect(() => {
    if (!ready) return;
    const displayScale = Math.min(1, scale * window.devicePixelRatio);
    post({
      type: "resize",
      width: Math.round(dimensions.width * displayScale),
      height: Math.round(dimensions.height * displayScale),
    });
  }, [ready, scale, dimensions.width, dimensions.height]);
  useEffect(() => {
    sendBrush.current = () => {
      if (brushInFlight.current) return;
      if (brushPending.current.length) {
        const points = brushPending.current;
        brushPending.current = [];
        brushInFlight.current = true;
        post({
          type: "brush",
          points,
          radius: size / 2,
          restore: mode === "restore",
          hardness,
        });
      } else if (releasePending.current) {
        releasePending.current = false;
        post({ type: "commit" });
      }
    };
  }, [size, mode, hardness]);
  const point = (event: React.PointerEvent): Point => {
    const bounds = surface.current!.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(dimensions.width, (event.clientX - bounds.left) / scale),
      ),
      y: Math.max(
        0,
        Math.min(dimensions.height, (event.clientY - bounds.top) / scale),
      ),
    };
  };
  const close = () => {
    if (saving || busy) return;
    if (changed) setConfirmClose(true);
    else onClose();
  };
  const finish = (event: React.PointerEvent, cancel = false) => {
    const gesture = active.current;
    if (!gesture || event.pointerId !== gesture.id) return;
    active.current = null;
    setPath([]);
    if (mode === "pan") {
      setBusy(false);
      return;
    }
    if (cancel) {
      brushPending.current = [];
      releasePending.current = false;
      post({ type: mode === "smart" ? "clear" : "cancel" });
    } else if (mode === "smart") {
      setBusy(true);
      post({ type: "select", points: [...gesture.points, point(event)] });
    } else {
      const end = point(event);
      brushPending.current.push(gesture.last, end);
      releasePending.current = true;
      sendBrush.current();
    }
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby="cleanup-title"
      className="cleanup-dialog m-auto flex h-[min(900px,94dvh)] w-[min(1200px,96vw)] max-w-none flex-col overflow-hidden rounded-2xl border border-border bg-background p-0 text-foreground shadow-2xl backdrop:bg-black/60"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 id="cleanup-title" className="font-semibold">
            Clean up
          </h2>
          <p className="truncate text-xs text-muted-foreground">{job.name}</p>
        </div>
        <button
          className={button}
          aria-label="Close editor"
          onClick={close}
          disabled={busy || saving}
        >
          <X size={18} />
        </button>
      </header>
      <div
        className="flex flex-wrap items-center gap-1 border-b border-border p-2"
        role="toolbar"
        aria-label="Cleanup tools"
      >
        {(
          [
            { id: "smart", label: "Smart Remove", Icon: Lasso },
            { id: "erase", label: "Erase", Icon: Eraser },
            { id: "restore", label: "Restore", Icon: RotateCcw },
            { id: "pan", label: "Pan", Icon: Hand },
          ] as const
        ).map(({ id, label, Icon }) => (
          <button
            key={id}
            className={`${button} ${mode === id ? "bg-muted font-medium" : ""}`}
            aria-pressed={mode === id}
            disabled={!ready || busy || saving}
            onClick={() => {
              setMode(id);
              setCursor(null);
              if (selection.components) command("clear");
            }}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1">
          <button
            className={button}
            aria-label="Undo"
            disabled={!history.canUndo || busy || saving}
            onClick={() => command("undo")}
          >
            <Undo2 size={18} />
          </button>
          <button
            className={button}
            aria-label="Redo"
            disabled={!history.canRedo || busy || saving}
            onClick={() => command("redo")}
          >
            <Redo2 size={18} />
          </button>
        </div>
      </div>
      {(mode === "erase" || mode === "restore") && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border px-4 py-2 text-xs">
          <label className="flex items-center gap-2">
            Size{" "}
            <input
              aria-label="Brush size"
              type="range"
              min="2"
              max="300"
              value={size}
              disabled={busy || saving}
              onChange={(e) => setSize(Number(e.target.value))}
            />
            <span className="w-12 tabular-nums">{size} px</span>
          </label>
          <label className="flex items-center gap-2">
            Hardness{" "}
            <input
              aria-label="Brush hardness"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={hardness}
              disabled={busy || saving}
              onChange={(e) => setHardness(Number(e.target.value))}
            />
          </label>
        </div>
      )}
      <div
        ref={viewport}
        className="relative min-h-0 flex-1 overflow-auto bg-muted/40 overscroll-contain"
      >
        <div className="grid min-h-full min-w-full w-max place-items-center p-4">
          <div
            ref={surface}
            className="checkerboard relative shrink-0 touch-none outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
            style={{
              width: dimensions.width * scale,
              height: dimensions.height * scale,
              cursor:
                mode === "pan"
                  ? "grab"
                  : mode === "smart"
                    ? "crosshair"
                    : "none",
            }}
            onPointerDown={(e) => {
              if (!ready || busy || saving || active.current || e.button !== 0)
                return;
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              const p = point(e);
              active.current = {
                id: e.pointerId,
                points: [p],
                last: p,
                client: { x: e.clientX, y: e.clientY },
              };
              if (mode === "pan") setBusy(true);
              if (mode === "smart") {
                command("clear");
                setPath([p]);
              } else if (mode !== "pan") {
                setBusy(true);
                post({ type: "begin" });
                brushPending.current = [p];
                sendBrush.current();
              }
            }}
            onPointerMove={(e) => {
              const p = point(e);
              setCursor(p);
              const gesture = active.current;
              if (!gesture || gesture.id !== e.pointerId) return;
              if (mode === "pan") {
                viewport.current!.scrollLeft -= e.clientX - gesture.client.x;
                viewport.current!.scrollTop -= e.clientY - gesture.client.y;
                gesture.client = { x: e.clientX, y: e.clientY };
              } else if (mode === "smart") {
                if (
                  Math.hypot(p.x - gesture.last.x, p.y - gesture.last.y) *
                    scale <
                  2
                )
                  return;
                gesture.points.push(p);
                gesture.last = p;
                setPath([...gesture.points]);
              } else {
                if (!brushPending.current.length)
                  brushPending.current.push(gesture.last);
                brushPending.current.push(p);
                gesture.last = p;
                sendBrush.current();
              }
            }}
            onPointerUp={(e) => finish(e)}
            onPointerCancel={(e) => finish(e, true)}
            onLostPointerCapture={(e) => {
              if (active.current) finish(e, true);
            }}
            onPointerLeave={() => setCursor(null)}
          >
            <canvas
              ref={canvas}
              className="block size-full"
              aria-label="Image cleanup canvas"
            />
            <svg
              className="pointer-events-none absolute inset-0 size-full overflow-visible"
              viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
              aria-hidden="true"
            >
              {path.length > 1 && (
                <polygon
                  points={path.map((p) => `${p.x},${p.y}`).join(" ")}
                  fill="rgba(244,63,94,0.12)"
                  stroke="#f43f5e"
                  strokeWidth={2 / scale}
                  strokeDasharray={`${5 / scale} ${3 / scale}`}
                />
              )}
              {cursor && (mode === "erase" || mode === "restore") && (
                <>
                  <circle
                    cx={cursor.x}
                    cy={cursor.y}
                    r={size / 2}
                    fill="none"
                    stroke="black"
                    strokeWidth={3 / scale}
                  />
                  <circle
                    cx={cursor.x}
                    cy={cursor.y}
                    r={size / 2}
                    fill="none"
                    stroke="white"
                    strokeWidth={1 / scale}
                  />
                </>
              )}
            </svg>
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-1">
        <p role="status" className="text-xs text-muted-foreground">
          {error ||
            (!ready
              ? "Preparing full-resolution mask…"
              : busy
                ? "Updating…"
                : selection.components
                  ? `${selection.components} region${selection.components === 1 ? "" : "s"} highlighted.${selection.ambiguous ? " Attached or partly enclosed regions were skipped." : ""}`
                  : selection.ambiguous
                    ? "This region extends outside your circle. Circle it fully, or use Erase if it is attached."
                    : mode === "smart"
                      ? "Circle the leftover object. Review the highlight, then remove."
                      : mode === "restore"
                        ? "Paint to restore your cleanup edits to the original cutout."
                        : mode === "erase"
                          ? "Paint to erase. Zoom in for fine edges."
                          : "Drag to move around the zoomed image.")}
        </p>
        <div className="flex shrink-0 items-center">
          <button
            className={button}
            aria-label="Zoom out"
            disabled={zoom <= 1 || busy}
            onClick={() => setZoom((z) => Math.max(1, z / 1.5))}
          >
            <ZoomOut size={17} />
          </button>
          <button
            className={`${button} tabular-nums`}
            aria-label="Fit image"
            disabled={busy}
            onClick={() => setZoom(1)}
          >
            {Math.round(scale * 100)}%
          </button>
          <button
            className={button}
            aria-label="Zoom in"
            disabled={zoom >= 12 || busy}
            onClick={() => setZoom((z) => Math.min(12, z * 1.5))}
          >
            <ZoomIn size={17} />
          </button>
        </div>
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border p-3">
        {confirmClose ? (
          <>
            <p className="text-sm">Discard your cleanup edits?</p>
            <div className="flex gap-2">
              <button className={button} onClick={() => setConfirmClose(false)}>
                Keep editing
              </button>
              <button
                className={`${button} text-destructive`}
                onClick={onClose}
              >
                Discard edits
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="flex gap-1">
              {selection.components > 0 && (
                <>
                  <button
                    className={`${button} bg-rose-600 text-white hover:bg-rose-700`}
                    disabled={busy || saving}
                    onClick={() => command("remove")}
                  >
                    Remove selected
                  </button>
                  <button
                    className={button}
                    disabled={busy || saving}
                    onClick={() => command("clear")}
                  >
                    Clear selection
                  </button>
                </>
              )}
            </div>
            <button
              className={`${button} bg-primary text-primary-foreground hover:bg-primary/90`}
              disabled={
                !ready || busy || saving || !!error || selection.components > 0
              }
              onClick={() => {
                setSaving(true);
                post({ type: "export" });
              }}
            >
              {saving ? "Saving…" : "Apply changes"}
            </button>
          </>
        )}
      </footer>
    </dialog>
  );
}
