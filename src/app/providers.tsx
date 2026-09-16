"use client";

import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "@posthog/react";
import { useEffect } from "react";

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
    if (!token) return;
    posthog.init(token, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
      defaults: "2026-05-30",
      person_profiles: "identified_only",
    });
  }, []);
  return <PHProvider client={posthog}>{children}</PHProvider>;
}
