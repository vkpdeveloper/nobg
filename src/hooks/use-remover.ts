"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { removerPool, type EngineStatus } from "@/lib/remover-pool";
import { sounds } from "@/lib/sounds";

export interface Job {
  id: string;
  file: File;
  name: string;
  originalUrl: string;
  status: "queued" | "processing" | "done" | "error";
  resultUrl?: string;
  resultBlob?: Blob;
  cleanupBaseBlob?: Blob;
  width?: number;
  height?: number;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export function useRemover() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [engine, setEngine] = useState<EngineStatus>(() =>
    removerPool.getStatus(),
  );
  const inFlightRef = useRef(new Set<string>());
  const batchDoneRef = useRef(0);

  useEffect(() => {
    const offStatus = removerPool.onStatus(setEngine);
    const offJob = removerPool.onJob((e) => {
      if (e.state === "processing") {
        setJobs((prev) =>
          prev.map((j) =>
            j.id === e.id
              ? { ...j, status: "processing", startedAt: Date.now() }
              : j,
          ),
        );
      } else if (e.state === "done") {
        const url = URL.createObjectURL(e.blob);
        setJobs((prev) =>
          prev.map((j) =>
            j.id === e.id
              ? {
                  ...j,
                  status: "done",
                  resultUrl: url,
                  resultBlob: e.blob,
                  width: e.width,
                  height: e.height,
                  finishedAt: Date.now(),
                }
              : j,
          ),
        );
        if (inFlightRef.current.delete(e.id)) {
          batchDoneRef.current += 1;
          if (inFlightRef.current.size === 0) {
            if (batchDoneRef.current >= 2) sounds.chime();
            else sounds.tick();
            batchDoneRef.current = 0;
          } else {
            sounds.tick();
          }
        }
      } else {
        inFlightRef.current.delete(e.id);
        setJobs((prev) =>
          prev.map((j) =>
            j.id === e.id
              ? {
                  ...j,
                  status: "error",
                  error: e.message,
                  finishedAt: Date.now(),
                }
              : j,
          ),
        );
      }
    });
    void removerPool.warmup();
    return () => {
      offStatus();
      offJob();
    };
  }, []);

  const addFiles = useCallback((files: FileList | File[]) => {
    const images = Array.from(files).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (images.length === 0) return;
    const created: Job[] = images.map((f) => ({
      id: crypto.randomUUID(),
      file: f,
      name: f.name || "pasted-image.png",
      originalUrl: URL.createObjectURL(f),
      status: "queued",
    }));
    for (const job of created) inFlightRef.current.add(job.id);
    setJobs((prev) => [...prev, ...created]);
    for (const job of created) removerPool.enqueue(job.id, job.file);
  }, []);

  const removeJob = useCallback((id: string) => {
    inFlightRef.current.delete(id);
    setJobs((prev) => {
      const job = prev.find((j) => j.id === id);
      if (job) {
        URL.revokeObjectURL(job.originalUrl);
        if (job.resultUrl) URL.revokeObjectURL(job.resultUrl);
      }
      return prev.filter((j) => j.id !== id);
    });
  }, []);

  const clearAll = useCallback(() => {
    setJobs((prev) => {
      for (const job of prev) {
        URL.revokeObjectURL(job.originalUrl);
        if (job.resultUrl) URL.revokeObjectURL(job.resultUrl);
      }
      return [];
    });
  }, []);

  const updateResult = useCallback((id: string, blob: Blob) => {
    const url = URL.createObjectURL(blob);
    setJobs((prev) => {
      if (!prev.some((job) => job.id === id)) {
        URL.revokeObjectURL(url);
        return prev;
      }
      return prev.map((job) => {
        if (job.id !== id) return job;
        if (job.resultUrl) URL.revokeObjectURL(job.resultUrl);
        return { ...job, cleanupBaseBlob: job.cleanupBaseBlob ?? job.resultBlob, resultBlob: blob, resultUrl: url };
      });
    });
  }, []);

  return { jobs, engine, addFiles, removeJob, clearAll, updateResult };
}
