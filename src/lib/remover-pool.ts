import { detectCapabilities } from "./device";

export type Device = "webgpu" | "wasm";

export type EngineStatus =
  | { state: "idle"; progress: number; device: null }
  | { state: "loading"; progress: number; device: null }
  | { state: "ready"; progress: number; device: Device }
  | { state: "error"; progress: number; device: null };

export type JobEvent =
  | { id: string; state: "processing" }
  | { id: string; state: "done"; blob: Blob; width: number; height: number }
  | { id: string; state: "error"; message: string };

interface WorkerRecord {
  worker: Worker;
  ready: boolean;
  busy: boolean;
}

type StatusListener = (s: EngineStatus) => void;
type JobListener = (e: JobEvent) => void;

type WorkerOutMessage =
  | { type: "progress"; loaded: number; total: number }
  | { type: "ready"; device: Device }
  | { type: "result"; id: string; blob: Blob; width: number; height: number }
  | { type: "error"; id?: string; message: string };

class RemoverPool {
  private workers: WorkerRecord[] = [];
  private queue: { id: string; file: Blob }[] = [];
  private concurrency = 1;
  private started = false;
  private status: EngineStatus = { state: "idle", progress: 0, device: null };
  private statusListeners = new Set<StatusListener>();
  private jobListeners = new Set<JobListener>();

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
    this.status = s;
    for (const fn of this.statusListeners) fn(s);
  }

  private emitJob(e: JobEvent) {
    for (const fn of this.jobListeners) fn(e);
  }

  async warmup() {
    if (this.started || typeof window === "undefined") return;
    this.started = true;
    try {
      const caps = await detectCapabilities();
      this.concurrency = caps.concurrency;
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
    const worker = new Worker(
      new URL("../workers/remover.worker.ts", import.meta.url),
      { type: "module" },
    );
    const rec: WorkerRecord = { worker, ready: false, busy: false };
    worker.onmessage = (e: MessageEvent) => this.onMessage(rec, e.data);
    worker.onerror = () => {
      if (!rec.ready && this.status.state !== "ready")
        this.setStatus({ state: "error", progress: 0, device: null });
    };
    this.workers.push(rec);
    if (this.status.state !== "ready")
      this.setStatus({ state: "loading", progress: 0, device: null });
    worker.postMessage({ type: "load" });
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
      this.emitJob({ id: job.id, state: "processing" });
      rec.worker.postMessage({ type: "process", id: job.id, file: job.file });
    }
  }

  private onMessage(rec: WorkerRecord, msg: WorkerOutMessage) {
    switch (msg.type) {
      case "progress": {
        if (this.status.state === "loading" || this.status.state === "idle") {
          const progress = msg.total > 0 ? Math.min(msg.loaded / msg.total, 1) : 0;
          this.setStatus({ state: "loading", progress, device: null });
        }
        break;
      }
      case "ready": {
        rec.ready = true;
        if (msg.device === "wasm") this.concurrency = 1;
        this.setStatus({ state: "ready", progress: 1, device: msg.device });
        this.maybeGrow();
        this.pump();
        break;
      }
      case "result": {
        rec.busy = false;
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
          this.emitJob({ id: msg.id, state: "error", message: msg.message });
        } else if (!rec.ready && this.status.state !== "ready") {
          this.setStatus({ state: "error", progress: 0, device: null });
        }
        this.pump();
        break;
      }
    }
  }
}

export const removerPool = new RemoverPool();
