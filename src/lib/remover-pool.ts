import { detectCapabilities, isMobileDevice } from "./device";
import { track } from "./analytics";
import type { ModelPhase } from "./model-download";

export type Device = "webgpu" | "wasm";

export type EngineStatus = { mobile?: boolean } & (
  | { state: "idle"; progress: number; device: null }
  | { state: "loading"; progress: number; device: null; phase?: ModelPhase }
  | { state: "ready"; progress: number; device: Device }
  | { state: "error"; progress: number; device: null; message?: string });

export type JobEvent =
  | { id: string; state: "processing" }
  | { id: string; state: "done"; blob: Blob; width: number; height: number }
  | { id: string; state: "error"; message: string };

interface WorkerRecord {
  worker: Worker;
  ready: boolean;
  busy: boolean;
  job?: { id: string; file: Blob };
  forceWasm: boolean;
}

type StatusListener = (s: EngineStatus) => void;
type JobListener = (e: JobEvent) => void;

type WorkerOutMessage =
  | { type: "progress"; loaded: number; total: number; phase?: ModelPhase }
  | { type: "ready"; device: Device }
  | { type: "fallback" }
  | { type: "result"; id: string; blob: Blob; width: number; height: number }
  | { type: "error"; id?: string; message: string };

class RemoverPool {
  private workers: WorkerRecord[] = [];
  private queue: { id: string; file: Blob }[] = [];
  private concurrency = 1;
  private started = false;
  private forceWasm = false;
  private status: EngineStatus = { state: "idle", progress: 0, device: null };
  private statusListeners = new Set<StatusListener>();
  private jobListeners = new Set<JobListener>();
  private warmStartedAt = 0;
  private trackedReady = false;
  private trackedFailed = false;

  getStatus(): EngineStatus {
    return this.status;
  }

  onStatus(fn: StatusListener): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  onJob(fn: JobListener): () => void {
    this.jobListeners.add(fn);
    return () => this.jobListeners.delete(fn);
  }

  private setStatus(s: EngineStatus) {
    this.status = { ...s, mobile: isMobileDevice() };
    for (const fn of this.statusListeners) fn(this.status);
  }

  private emitJob(e: JobEvent) {
    for (const fn of this.jobListeners) fn(e);
  }

  private failPending(message: string) {
    this.started = false;
    this.setStatus({ state: "error", progress: 0, device: null, message });
    if (!this.trackedFailed) {
      this.trackedFailed = true;
      track("engine_failed", { message });
    }
    for (const job of this.queue.splice(0)) {
      this.emitJob({ id: job.id, state: "error", message });
    }
  }

  private failWorker(rec: WorkerRecord, message: string) {
    if (!this.workers.includes(rec)) return;
    rec.worker.terminate();
    this.workers = this.workers.filter((worker) => worker !== rec);
    if (rec.job) this.emitJob({ id: rec.job.id, state: "error", message });
    if (this.workers.length === 0) this.failPending(message);
    else this.pump();
  }

  async warmup() {
    if (this.started || typeof window === "undefined") return;
    this.started = true;
    this.warmStartedAt = performance.now();
    if (!window.isSecureContext) {
      this.failPending("Open this site over HTTPS to process images on your phone.");
      return;
    }
    // Persistence can only be requested from the window, not from a worker.
    // Browsers may deny it; the saved model is still reused for as long as it exists.
    void navigator.storage?.persist?.().catch(() => false);
    try {
      const caps = await detectCapabilities();
      this.concurrency = this.forceWasm ? 1 : caps.concurrency;
    } catch {
      this.concurrency = 1;
    }
    this.spawn();
  }

  enqueue(id: string, file: Blob) {
    this.queue.push({ id, file });
    void this.warmup();
    this.maybeGrow();
    this.pump();
  }

  private spawn() {
    let worker: Worker;
    try {
      worker = new Worker(
        new URL("../workers/remover.worker.ts", import.meta.url),
        { type: "module" },
      );
    } catch {
      this.concurrency = this.workers.length || 1;
      if (this.workers.length === 0) this.failPending("Could not start image processing. Reload and try again.");
      return;
    }
    const rec: WorkerRecord = { worker, ready: false, busy: false, forceWasm: this.forceWasm };
    worker.onmessage = (e: MessageEvent) => this.onMessage(rec, e.data);
    worker.onerror = () => this.failWorker(rec, "Image processing stopped. Try a smaller image or reload and try again.");
    worker.onmessageerror = () => this.failWorker(rec, "Could not read the processed image. Reload and try again.");
    this.workers.push(rec);
    if (this.status.state !== "ready")
      this.setStatus({ state: "loading", progress: 0, device: null });
    worker.postMessage({ type: "load", ...(this.forceWasm ? { device: "wasm" } : {}) });
  }

  private maybeGrow() {
    if (this.status.state !== "ready") return;
    while (
      this.queue.length > this.workers.length &&
      this.workers.length < this.concurrency
    ) {
      this.spawn();
    }
  }

  private pump() {
    for (const rec of this.workers) {
      if (this.queue.length === 0) break;
      if (!rec.ready || rec.busy) continue;
      const job = this.queue.shift()!;
      rec.busy = true;
      rec.job = job;
      this.emitJob({ id: job.id, state: "processing" });
      rec.worker.postMessage({ type: "process", id: job.id, file: job.file });
    }
  }

  private onMessage(rec: WorkerRecord, msg: WorkerOutMessage) {
    if (!this.workers.includes(rec)) return;
    switch (msg.type) {
      case "fallback": {
        if (rec.forceWasm) {
          this.failWorker(rec, "CPU image processing could not start. Reload and try again.");
          break;
        }
        // Stop all GPU workers before allocating the CPU model. Replay active
        // jobs as well as the remaining queue; no uploaded image is lost.
        const interrupted = this.workers.flatMap((worker) => worker.job ? [worker.job] : []);
        for (const worker of this.workers) worker.worker.terminate();
        this.workers = [];
        this.queue.unshift(...interrupted);
        this.forceWasm = true;
        this.concurrency = 1;
        this.setStatus({ state: "loading", progress: 0, device: null, phase: "loading" });
        this.spawn();
        break;
      }
      case "progress": {
        if (this.status.state === "loading" || this.status.state === "idle") {
          const progress = msg.total > 0 ? Math.min(msg.loaded / msg.total, 1) : 0;
          this.setStatus({ state: "loading", progress, device: null, phase: msg.phase });
        }
        break;
      }
      case "ready": {
        rec.ready = true;
        if (msg.device === "wasm") this.concurrency = 1;
        this.setStatus({ state: "ready", progress: 1, device: msg.device });
        if (!this.trackedReady) {
          this.trackedReady = true;
          track("engine_ready", {
            device: msg.device,
            load_ms: Math.round(performance.now() - this.warmStartedAt),
            concurrency: this.concurrency,
          });
        }
        this.maybeGrow();
        this.pump();
        break;
      }
      case "result": {
        rec.busy = false;
        rec.job = undefined;
        this.emitJob({
          id: msg.id,
          state: "done",
          blob: msg.blob,
          width: msg.width,
          height: msg.height,
        });
        this.pump();
        break;
      }
      case "error": {
        rec.busy = false;
        if (msg.id) {
          rec.job = undefined;
          this.emitJob({ id: msg.id, state: "error", message: msg.message });
        } else {
          this.failWorker(rec, msg.message);
        }
        this.pump();
        break;
      }
    }
  }
}

export const removerPool = new RemoverPool();
