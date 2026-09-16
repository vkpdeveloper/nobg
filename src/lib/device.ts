export interface Capabilities {
  webgpu: boolean;
  cores: number;
  memoryGB: number;
  concurrency: number;
}

interface GPUAdapter {
  requestAdapter(): Promise<unknown>;
}

function gpuNavigator(): (Navigator & { gpu?: GPUAdapter }) | null {
  return typeof navigator === "undefined" ? null : navigator;
}

export async function detectCapabilities(): Promise<Capabilities> {
  const nav = gpuNavigator();
  const webgpu =
    !!nav?.gpu && !!(await nav.gpu.requestAdapter().catch(() => null));
  const cores = navigator.hardwareConcurrency ?? 4;
  const memoryGB =
    (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  const mobile = /Mobi|Android/i.test(navigator.userAgent);

  let concurrency = 1;
  if (webgpu && !mobile) {
    if (cores >= 8 && memoryGB >= 8) concurrency = 3;
    else if (cores >= 4 && memoryGB >= 4) concurrency = 2;
  }

  return { webgpu, cores, memoryGB, concurrency };
}
