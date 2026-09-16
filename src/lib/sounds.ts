const KEY = "nobg:sound";

let ctx: AudioContext | null = null;
let enabled =
  typeof window === "undefined" || localStorage.getItem(KEY) !== "0";

const listeners = new Set<() => void>();

function ac(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function tone(
  freq: number,
  at: number,
  dur: number,
  peak: number,
  sweepTo?: number,
) {
  const c = ac();
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, at);
  if (sweepTo) osc.frequency.exponentialRampToValueAtTime(sweepTo, at + dur);
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(peak, at + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(gain).connect(c.destination);
  osc.start(at);
  osc.stop(at + dur + 0.05);
}

export const sounds = {
  get enabled() {
    return enabled;
  },
  setEnabled(v: boolean) {
    enabled = v;
    localStorage.setItem(KEY, v ? "1" : "0");
    for (const fn of listeners) fn();
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  unlock() {
    if (enabled) ac();
  },
  tick() {
    if (!enabled) return;
    const t = ac().currentTime;
    tone(880, t, 0.09, 0.15, 1320);
  },
  chime() {
    if (!enabled) return;
    const t = ac().currentTime;
    tone(1046.5, t, 0.12, 0.12);
    tone(1318.5, t + 0.09, 0.12, 0.12);
  },
};
