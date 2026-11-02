import { capabilityDefinition } from "./capabilities.js";
import { firstRolloutStepCovering, flagIntroductions, flagOverrides, flagValueSource, readFlagRollouts } from "./flag-rollouts.js";
import type { JsonObject } from "./storage.js";

const asObject = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};

/**
 * Whether an organization has a flag on but has yet to be told (docs/architecture/feature-flags.md, "Introducing a
 * flag"). Set per organization by the console, or by a percentage saved with `introduce` for the organizations that
 * step added and that existed when it was saved: an organization created later started with the flag, so to it nothing
 * is new. Being told is the announcement's own server progress, not this.
 */
export async function introductionRequested(orgId: string, key: string, globalData: unknown, createdAt: unknown) {
  const data = asObject(globalData);
  const explicit = flagOverrides(data)[key];
  if (explicit !== undefined) return explicit === true && !!flagIntroductions(data)[key];
  const node = capabilityDefinition(key);
  if (!node) return false;
  const rollout = (await readFlagRollouts())[key];
  const stored = asObject(asObject(data.app_flags || data.feature_flags)[node.group])[node.flag];
  const { source } = flagValueSource({ key, orgId, stored: stored === undefined ? undefined : stored !== false, override: undefined, rollout, defaultValue: node.default === true });
  if (source !== "percentage" || !rollout) return false;
  const step = firstRolloutStepCovering(rollout, key, orgId);
  const created = Date.parse(String(createdAt ?? ""));
  return !!step?.introduce && Number.isFinite(created) && created < Date.parse(step.at);
}
