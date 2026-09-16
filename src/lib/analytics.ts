import posthog from "posthog-js";

export function track(event: string, props?: Record<string, unknown>) {
  if (!posthog.__loaded) return;
  posthog.capture(event, props);
}
