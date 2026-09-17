import { TIER_ORDER, type Tier } from "./model-config";

const QUALITY_KEY = "nobg:quality";
const CAP_KEY = "nobg:tier-cap";
const INFLIGHT_KEY = "nobg:inflight";

export type QualityPreference = Tier | "auto";
export interface InflightMarker {
  tier: Tier;
  at: number;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

const isTier = (value: unknown): value is Tier =>
  typeof value === "string" && (TIER_ORDER as string[]).includes(value);

export function getQuality(): QualityPreference {
  try {
    const value = storage()?.getItem(QUALITY_KEY);
    return isTier(value) ? value : "auto";
  } catch {
    return "auto";
  }
}

export function setQuality(value: QualityPreference) {
  try {
    storage()?.setItem(QUALITY_KEY, value);
  } catch { /* Storage may be unavailable. */ }
}

export function getTierCap(): Tier | null {
  try {
    const value = storage()?.getItem(CAP_KEY);
    return isTier(value) ? value : null;
  } catch {
    return null;
  }
}

export function setTierCap(tier: Tier) {
  try {
    storage()?.setItem(CAP_KEY, tier);
  } catch { /* Storage may be unavailable. */ }
}

export function getInflight(): InflightMarker | null {
  try {
    const raw = storage()?.getItem(INFLIGHT_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<InflightMarker> | null;
    return isTier(value?.tier) && typeof value?.at === "number"
      ? { tier: value.tier, at: value.at }
      : null;
  } catch {
    return null;
  }
}

export function setInflight(tier: Tier) {
  try {
    storage()?.setItem(INFLIGHT_KEY, JSON.stringify({ tier, at: Date.now() }));
  } catch { /* Storage may be unavailable. */ }
}

export function clearInflight() {
  try {
    storage()?.removeItem(INFLIGHT_KEY);
  } catch { /* Storage may be unavailable. */ }
}
