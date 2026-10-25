import { createHash } from "node:crypto";
import { evaluateConditions } from "../work/conditions.js";
import type { ExperienceDefinition } from "./contracts.js";

/**
 * The chooser: which variant of an experience a person gets. Deterministic, so the same organization (or person)
 * always lands in the same bucket for the same experience and salt, on every server and in tests; changing the salt
 * starts a new experiment. Variants are filtered by their conditions over the chooser context first, then picked by
 * weight with the bucket. The first variant someone is exposed to is remembered in their progress, so changing
 * weights later never moves a person who has already seen one.
 */

export type ChooserContext = {
  organization: { id: string; region: string; state: string; timezone: string; size: { users: number; tier: string }; industry: string; capabilities: Record<string, boolean> };
  /** `eligible`: the experiences this person could play, filled when listing what they may see. */
  person: { id: string; role: string; permissions: Record<string, boolean>; eligible?: string[] };
  surface: { tab: string; project_id: string };
};

/** A number in [0, 1) from the unit, the experience and its salt. */
export function bucketOf(unitId: string, experienceId: string, salt = "v1"): number {
  const hex = createHash("sha256").update(`${experienceId}\u0000${salt}\u0000${unitId}`).digest("hex").slice(0, 12);
  return parseInt(hex, 16) / 2 ** 48;
}

export function unitIdFor(definition: Pick<ExperienceDefinition, "scope" | "unit">, context: Pick<ChooserContext, "organization" | "person">) {
  const unit = definition.unit || definition.scope;
  return unit === "person" ? `person:${context.organization.id}:${context.person.id}` : `organization:${context.organization.id}`;
}

export function chooseVariant(definition: ExperienceDefinition, context: ChooserContext, remembered?: string) {
  const unit = unitIdFor(definition, context);
  const bucket = bucketOf(unit, definition.id, definition.salt);
  const kept = remembered ? definition.variants.find((variant) => variant.id === remembered) : undefined;
  // A remembered variant stays as long as it still exists and still suits this person (the assistant may since be off).
  if (kept && (!kept.when || evaluateConditions(kept.when, context as unknown as Record<string, unknown>))) return { variant: kept, bucket, unit, sticky: true };
  const eligible = definition.variants.filter((variant) => variant.weight > 0 && (!variant.when || evaluateConditions(variant.when, context as unknown as Record<string, unknown>)));
  if (!eligible.length) return null;
  const total = eligible.reduce((sum, variant) => sum + variant.weight, 0);
  let point = bucket * total;
  for (const variant of eligible) {
    if (point < variant.weight) return { variant, bucket, unit, sticky: false };
    point -= variant.weight;
  }
  return { variant: eligible[eligible.length - 1]!, bucket, unit, sticky: false };
}

const CENSUS_REGIONS: Record<string, string[]> = {
  northeast: ["CT", "ME", "MA", "NH", "RI", "VT", "NJ", "NY", "PA"],
  midwest: ["IL", "IN", "MI", "OH", "WI", "IA", "KS", "MN", "MO", "NE", "ND", "SD"],
  south: ["DE", "FL", "GA", "MD", "NC", "SC", "VA", "DC", "WV", "AL", "KY", "MS", "TN", "AR", "LA", "OK", "TX"],
  west: ["AZ", "CO", "ID", "MT", "NV", "NM", "UT", "WY", "AK", "CA", "HI", "OR", "WA"]
};
/** The US census region of a two-letter state, or `national` when it is unknown. */
export function regionForState(state: string) {
  const code = String(state || "").trim().toUpperCase();
  for (const [region, states] of Object.entries(CENSUS_REGIONS)) if (states.includes(code)) return region;
  return "national";
}

export function sizeTierFor(users: number) {
  const n = Number.isFinite(users) && users > 0 ? Math.floor(users) : 1;
  return n <= 2 ? "solo" : n <= 10 ? "small" : n <= 50 ? "mid" : n <= 250 ? "large" : "enterprise";
}
