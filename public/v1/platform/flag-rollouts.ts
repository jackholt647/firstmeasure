import { createHash } from "node:crypto";

import { mutatePlatformConfiguration, readPlatformConfiguration, type JsonObject } from "./storage.js";

/**
 * The read-time layers over an organization's stored flag values (docs/architecture/feature-flags.md):
 *
 *   stored value -> percentage rollout -> country rules -> explicit per-organization value -> flag-wide off
 *
 * A percentage is one small document, never a row per organization: whether it covers an organization is computed
 * from a stable hash of the flag key and organization id, so raising it keeps everyone it already covered.
 *
 * A stored value alone cannot say "someone chose this": saveCapabilityValues and signup stamp every flag into the
 * organization's app_flags, so most stored `false`s are old defaults. Only `data.app_flag_overrides`, written by the
 * flag console, is an explicit choice. A stored `true` stays on, as it always has; a stored `false` yields to a
 * percentage unless it is an explicit one.
 */
export const FLAG_OVERRIDES_KEY = "app_flag_overrides";
/** Organizations a flag was turned on for that are still to be told (flag-introductions.ts). Operators only, like the overrides. */
export const FLAG_INTRODUCTIONS_KEY = "flag_introductions";
const CONFIGURATION = "capability_flag_rollouts";
const TTL_MS = 15_000;
/** Whole basis points, so 0.01% steps work and a bucket is an integer. */
const BUCKETS = 10_000;

/** One raise of a percentage on a flag with an introduction: when, and whether the organizations it added are to be told. */
export type FlagRolloutStep = { percent: number; at: string; introduce: boolean };
export type FlagRollout = { percent: number; killed: boolean; updated_at?: string; updated_by?: string; note?: string; steps?: FlagRolloutStep[] };
export type FlagRollouts = Record<string, FlagRollout>;
type Values = Record<string, boolean | number | string>;

let cache: { at: number; rollouts: FlagRollouts } | null = null;

function normalize(raw: JsonObject | null | undefined): FlagRollouts {
  const source = raw?.flags && typeof raw.flags === "object" ? raw.flags as Record<string, JsonObject> : {};
  const rollouts: FlagRollouts = {};
  for (const [key, value] of Object.entries(source)) {
    const percent = Number(value?.percent);
    const killed = value?.killed === true;
    if (!killed && !(percent > 0)) continue;
    rollouts[key] = {
      percent: Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0)), killed,
      ...(value.updated_at ? { updated_at: String(value.updated_at) } : {}),
      ...(value.updated_by ? { updated_by: String(value.updated_by) } : {}),
      ...(value.note ? { note: String(value.note) } : {}),
      ...(Array.isArray(value.steps) ? { steps: value.steps as unknown as FlagRolloutStep[] } : {})
    };
  }
  return rollouts;
}

/** Cached for 15 seconds, so a change reaches every process within that. A failed read keeps the last known state. */
export async function readFlagRollouts(fresh = false): Promise<FlagRollouts> {
  if (!fresh && cache && Date.now() - cache.at < TTL_MS) return cache.rollouts;
  try {
    const rollouts = normalize(await readPlatformConfiguration(CONFIGURATION));
    cache = { at: Date.now(), rollouts };
    return rollouts;
  } catch (error) {
    if (!cache) throw error;
    return cache.rollouts;
  }
}

/** Saves one flag's rollout; `next` receives what is stored now. Returns the state before and after. */
export async function saveFlagRollout(key: string, next: (current: FlagRollout | null) => FlagRollout) {
  let before: FlagRollout | null = null;
  const saved = await mutatePlatformConfiguration(CONFIGURATION, (current) => {
    const rollouts = normalize(current);
    before = rollouts[key] ?? null;
    const flags: FlagRollouts = { ...rollouts, [key]: next(before) };
    if (!flags[key]!.killed && !(flags[key]!.percent > 0)) delete flags[key];
    return { ...(current ?? {}), flags };
  });
  const rollouts = normalize(saved);
  cache = { at: Date.now(), rollouts };
  return { before: before as FlagRollout | null, after: rollouts[key] ?? null };
}

/** This flag's stable place for this organization, 0 to 9999. */
export function flagBucket(key: string, orgId: string) {
  return parseInt(createHash("sha256").update(`${key}:${orgId}`).digest("hex").slice(0, 8), 16) % BUCKETS;
}

export function percentCovers(percent: number, key: string, orgId: string) {
  return percent > 0 && flagBucket(key, orgId) < Math.round(percent * (BUCKETS / 100));
}

export function flagOverrides(globalData: unknown): Record<string, boolean> {
  const source = globalData && typeof globalData === "object" ? (globalData as JsonObject)[FLAG_OVERRIDES_KEY] : null;
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  return Object.fromEntries(Object.entries(source).filter(([, value]) => typeof value === "boolean")) as Record<string, boolean>;
}

export function flagIntroductions(globalData: unknown): Record<string, JsonObject> {
  const source = globalData && typeof globalData === "object" ? (globalData as JsonObject)[FLAG_INTRODUCTIONS_KEY] : null;
  return source && typeof source === "object" && !Array.isArray(source) ? source as Record<string, JsonObject> : {};
}

/** The raises of a percentage, with this one added if it goes above them all. What was covered before they were kept counts as told. */
export function nextRolloutSteps(current: FlagRollout | null, percent: number, introduce: boolean, at: string) {
  const steps = [...(current?.steps ?? [])];
  if (!steps.length && current && current.percent > 0) steps.push({ percent: current.percent, at: current.updated_at || at, introduce: false });
  if (percent > Math.max(0, ...steps.map((step) => step.percent))) steps.push({ percent, at, introduce });
  return steps;
}

/** The raise that first covered this organization, which stays the same however far the percentage goes after it. */
export function firstRolloutStepCovering(rollout: FlagRollout, key: string, orgId: string) {
  return (rollout.steps ?? []).find((step) => percentCovers(step.percent, key, orgId)) ?? null;
}

/** Turns on flags a percentage covers. A stored `true` is untouched; nothing here ever turns a flag off. */
export function applyRolloutPercents<T extends Values>(orgId: string, values: T, rollouts: FlagRollouts): T {
  let result = values;
  for (const [key, rollout] of Object.entries(rollouts)) {
    if (values[key] === false && percentCovers(rollout.percent, key, orgId)) {
      if (result === values) result = { ...values };
      (result as Values)[key] = true;
    }
  }
  return result;
}

/** The last word: an explicit per-organization value, then a flag switched off for everyone. */
export function applyExplicitLayers<T extends Values>(values: T, overrides: Record<string, boolean>, rollouts: FlagRollouts): T {
  const killed = Object.keys(rollouts).filter((key) => rollouts[key]!.killed);
  if (!killed.length && !Object.keys(overrides).length) return values;
  const result: Values = { ...values, ...overrides };
  for (const key of killed) result[key] = false;
  return result as T;
}

/** The source of a flag's value before dependencies, for the console and its counts. */
export type FlagSource = "off_everywhere" | "explicit" | "stored_on" | "percentage" | "stored_off" | "default";
export function flagValueSource(input: { key: string; orgId: string; stored: boolean | undefined; override: boolean | undefined; rollout: FlagRollout | undefined; defaultValue: boolean }): { value: boolean; source: FlagSource } {
  if (input.rollout?.killed) return { value: false, source: "off_everywhere" };
  if (input.override !== undefined) return { value: input.override, source: "explicit" };
  if (input.stored === true) return { value: true, source: "stored_on" };
  const base = input.stored === undefined ? input.defaultValue : input.stored;
  if (base === true) return { value: true, source: "default" };
  if (input.rollout && percentCovers(input.rollout.percent, input.key, input.orgId)) return { value: true, source: "percentage" };
  return { value: false, source: input.stored === undefined ? "default" : "stored_off" };
}
