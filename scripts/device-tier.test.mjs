// Run with: bun scripts/device-tier.test.mjs
import assert from "node:assert/strict";

const { pickTier, resolveTier } = await import("../src/lib/device.ts");

const signals = (overrides) => ({
  mobile: false,
  ios: false,
  webgpu: false,
  simd: true,
  ...overrides,
});

const cases = [
  ["iPhone is always light, even with WebGPU",
    signals({ mobile: true, ios: true, webgpu: true }), "light"],
  ["Android with WebGPU and 8 GB is balanced",
    signals({ mobile: true, webgpu: true, memoryGB: 8, cores: 8 }), "balanced"],
  ["Android with 4 GB and no WebGPU is light",
    signals({ mobile: true, memoryGB: 4, cores: 8 }), "light"],
  ["Android with unknown memory is light",
    signals({ mobile: true, cores: 8 }), "light"],
  ["Android with 2 GB is basic",
    signals({ mobile: true, memoryGB: 2 }), "basic"],
  ["Android with 3 GB is basic",
    signals({ mobile: true, memoryGB: 3 }), "basic"],
  ["no SIMD means basic everywhere",
    signals({ mobile: false, webgpu: true, memoryGB: 16, cores: 16, simd: false }), "basic"],
  ["no SIMD means basic on phones too",
    signals({ mobile: true, memoryGB: 8, simd: false }), "basic"],
  ["Mac Safari desktop with unknown memory is best",
    signals({ webgpu: true }), "best"],
  ["Windows Chrome on Intel iGPU with 8 GB is balanced",
    signals({ webgpu: true, gpuVendor: "intel", memoryGB: 8, cores: 8 }), "balanced"],
  ["Windows Chrome on NVIDIA with 16 GB is best",
    signals({ webgpu: true, gpuVendor: "nvidia", memoryGB: 16, cores: 16 }), "best"],
  ["Apple Silicon WebGPU with unknown vendor is best",
    signals({ webgpu: true, gpuVendor: "apple", cores: 10 }), "best"],
  ["desktop WebGPU under 4 GB is light",
    signals({ webgpu: true, memoryGB: 2, cores: 8 }), "light"],
  ["desktop WebGPU under 8 GB is balanced",
    signals({ webgpu: true, memoryGB: 4, cores: 8 }), "balanced"],
  ["CPU-only desktop with 8 cores and 16 GB is balanced",
    signals({ cores: 8, memoryGB: 16 }), "balanced"],
  ["CPU-only desktop with 8 cores and unknown memory is balanced",
    signals({ cores: 8 }), "balanced"],
  ["CPU-only desktop with 4 cores and 4 GB is light",
    signals({ cores: 4, memoryGB: 4 }), "light"],
  ["CPU-only desktop with 2 cores and 2 GB is basic",
    signals({ cores: 2, memoryGB: 2 }), "basic"],
  ["CPU-only desktop with 8 cores and 4 GB is light",
    signals({ cores: 8, memoryGB: 4 }), "light"],
];

for (const [name, input, expected] of cases) {
  assert.equal(pickTier(input), expected, name);
}
console.log(`PASS ${cases.length} pickTier cases`);

assert.equal(resolveTier("best", "auto", null), "best");
assert.equal(resolveTier("light", "auto", null), "light");
assert.equal(resolveTier("best", "auto", "light"), "light", "a crash cap lowers the auto tier");
assert.equal(resolveTier("light", "auto", "balanced"), "light", "a higher cap does not raise the tier");
assert.equal(resolveTier("best", "basic", "balanced"), "basic", "an explicit override beats the cap");
assert.equal(resolveTier("best", "auto", "best"), "best");
console.log("PASS resolveTier override and crash-cap cases");
