import { TIER_ORDER, type Tier } from "./model-config";

export interface DeviceSignals {
  mobile: boolean;
  ios: boolean;
  webgpu: boolean;
  gpuVendor?: string;
  gpuMaxBufferSize?: number;
  cores?: number;
  memoryGB?: number;
  simd: boolean;
}

export interface Capabilities {
  signals: DeviceSignals;
  tier: Tier;
  concurrency: number;
}

interface GPUAdapterInfo {
  vendor?: string;
}

interface GPUAdapter {
  info?: GPUAdapterInfo;
  limits?: { maxBufferSize?: number };
}

interface GPU {
  requestAdapter(): Promise<GPUAdapter | null>;
}

export function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mobi|Android/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function gpuNavigator(): (Navigator & { gpu?: GPU; deviceMemory?: number }) | null {
  return typeof navigator === "undefined" ? null : navigator;
}

// Standard WebAssembly SIMD probe: a module with a single i8x16.splat/abs body.
const SIMD_MODULE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0,
  10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

export async function collectSignals(): Promise<DeviceSignals> {
  const nav = gpuNavigator();
  const mobile = isMobileDevice();
  const ios = !!nav && (/iPhone|iPad|iPod/.test(nav.userAgent) ||
    (nav.platform === "MacIntel" && nav.maxTouchPoints > 1));
  let webgpu = false;
  let gpuVendor: string | undefined;
  let gpuMaxBufferSize: number | undefined;
  if (nav?.gpu) {
    const adapter = await nav.gpu.requestAdapter().catch(() => null);
    if (adapter) {
      webgpu = true;
      gpuVendor = adapter.info?.vendor;
      gpuMaxBufferSize = adapter.limits?.maxBufferSize;
    }
  }
  let simd = false;
  try {
    simd = WebAssembly.validate(SIMD_MODULE);
  } catch {
    simd = false;
  }
  return {
    mobile,
    ios,
    webgpu,
    gpuVendor,
    gpuMaxBufferSize,
    cores: nav?.hardwareConcurrency,
    memoryGB: nav?.deviceMemory,
    simd,
  };
}

export function pickTier(s: DeviceSignals): Tier {
  if (!s.simd) return "basic";
  if (s.mobile) {
    if (s.ios) return "light";
    if (s.memoryGB !== undefined && s.memoryGB <= 2) return "basic";
    if (s.webgpu && s.memoryGB !== undefined && s.memoryGB >= 8) return "balanced";
    if (s.memoryGB === undefined || s.memoryGB >= 4) return "light";
    return "basic";
  }
  if (s.webgpu) {
    if (s.memoryGB !== undefined && s.memoryGB < 4) return "light";
    if (s.memoryGB !== undefined && s.memoryGB < 8) return "balanced";
    if (s.gpuVendor === "intel") return "balanced";
    return "best";
  }
  // CPU-only desktop: treat unknown memory as sufficient, unknown cores as low.
  const cores = s.cores ?? 4;
  const memoryGB = s.memoryGB ?? 8;
  if (cores >= 8 && memoryGB >= 8) return "balanced";
  if (cores >= 4 && memoryGB >= 4) return "light";
  return "basic";
}

export function resolveTier(auto: Tier, override: Tier | "auto", crashCap: Tier | null): Tier {
  if (override !== "auto") return override;
  if (crashCap && TIER_ORDER.indexOf(crashCap) > TIER_ORDER.indexOf(auto)) return crashCap;
  return auto;
}

export async function detectCapabilities(): Promise<Capabilities> {
  const signals = await collectSignals();
  const tier = pickTier(signals);
  let concurrency = 1;
  if (signals.webgpu && !signals.mobile && (tier === "best" || tier === "balanced")) {
    const cores = signals.cores ?? 4;
    const memoryGB = signals.memoryGB ?? 4;
    if (cores >= 8 && memoryGB >= 8) concurrency = 3;
    else if (cores >= 4 && memoryGB >= 4) concurrency = 2;
  }
  return { signals, tier, concurrency };
}
