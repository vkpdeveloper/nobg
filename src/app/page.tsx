"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { ChevronDown, Layers, Lock, Sparkles } from "lucide-react";
import { Header } from "@/components/header";
import { Dropzone } from "@/components/dropzone";
import { ImageCard } from "@/components/image-card";
import { FAQS, JsonLd } from "@/components/json-ld";
import { GITHUB_URL } from "@/lib/site";
import { track } from "@/lib/analytics";
import { useRemover } from "@/hooks/use-remover";

const CleanupEditor = dynamic(() => import("@/components/cleanup-editor"), { ssr: false });

const FEATURES = [
  {
    icon: Lock,
    title: "Runs on your device",
    body: "Nothing is uploaded, ever.",
  },
  {
    icon: Layers,
    title: "Batch friendly",
    body: "Drop as many images as you like.",
  },
  {
    icon: Sparkles,
    title: "Free & open source",
    body: "No accounts, no limits, no watermark.",
  },
];

export default function Home() {
  const { jobs, engine, addFiles, removeJob, clearAll, updateResult } = useRemover();
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingJob = jobs.find((job) => job.id === editingId);
  const doneCount = jobs.filter((j) => j.status === "done").length;

  const downloadAll = async () => {
    track("download_all_clicked", { count: doneCount });
    for (const job of jobs) {
      if (job.status !== "done" || !job.resultUrl) continue;
      const a = document.createElement("a");
      a.href = job.resultUrl;
      a.download = `${job.name.replace(/\.[^.]+$/, "") || "image"}-nobg.png`;
      a.click();
      await new Promise((r) => setTimeout(r, 150));
    }
  };

  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-6">
        <section className="flex flex-col items-center gap-6 pb-10 pt-10 text-center sm:pt-16">
          <h1 className="max-w-2xl text-balance text-4xl font-semibold tracking-tight sm:text-6xl">
            Remove backgrounds. Instantly.
          </h1>
          <p className="max-w-xl text-pretty text-base text-muted-foreground sm:text-lg">
            Free, private, and unlimited. Your images never leave your device.
          </p>
          <Dropzone onFiles={addFiles} engine={engine} />
        </section>

        {jobs.length > 0 && (
          <section className="pb-10">
            {jobs.length > 1 && (
              <div className="mb-4 flex items-center justify-between">
                <span className="text-sm tabular-nums text-muted-foreground">
                  {doneCount}/{jobs.length} done
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={downloadAll}
                    disabled={doneCount === 0}
                    className="flex h-8 items-center rounded-lg px-3 text-sm font-medium transition-[color,background-color,scale] duration-150 hover:bg-muted active:scale-[0.96] disabled:pointer-events-none disabled:opacity-40"
                  >
                    Download all
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      track("clear_all_clicked", { count: jobs.length });
                      clearAll();
                    }}
                    className="flex h-8 items-center rounded-lg px-3 text-sm text-muted-foreground transition-[color,background-color,scale] duration-150 hover:bg-muted hover:text-foreground active:scale-[0.96]"
                  >
                    Clear all
                  </button>
                </div>
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {jobs.map((job, i) => (
                <ImageCard key={job.id} job={job} index={i} onRemove={removeJob} onEdit={setEditingId} />
              ))}
            </div>
          </section>
        )}

        <section className="grid gap-6 border-t border-border/60 py-8 sm:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="flex items-start gap-3">
              <f.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">{f.title}</p>
                <p className="mt-0.5 text-sm text-muted-foreground">{f.body}</p>
              </div>
            </div>
          ))}
        </section>

        <section className="border-t border-border/60 py-6">
          <h2 className="mb-2 px-2 text-sm font-medium">Questions</h2>
          <div className="space-y-0.5">
            {FAQS.map((f) => (
              <details key={f.q} className="group rounded-lg">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-2 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
                  {f.q}
                  <ChevronDown className="size-4 shrink-0 transition-transform duration-200 group-open:rotate-180" />
                </summary>
                <p className="px-2 pb-3 text-sm text-muted-foreground">{f.a}</p>
              </details>
            ))}
          </div>
        </section>
      </main>
      {editingJob?.resultBlob && (
        <CleanupEditor key={editingJob.id} job={editingJob} onClose={() => setEditingId(null)} onApply={(blob) => {
          updateResult(editingJob.id, blob);
          setEditingId(null);
        }} />
      )}
      <footer className="mx-auto w-full max-w-5xl px-6 pb-6">
        <p className="text-xs text-muted-foreground">
          NOBG · Free and open source ·{" "}
          <a href={GITHUB_URL} target="_blank" rel="noreferrer" onClick={() => track("github_clicked", { location: "footer" })} className="underline-offset-4 transition-colors hover:text-foreground hover:underline">
            GitHub
          </a>
        </p>
      </footer>
      <JsonLd />
    </>
  );
}
