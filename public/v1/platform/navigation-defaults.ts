import type { JsonObject } from './storage.js';

export const INSTANT_ORG_NAVIGATION: JsonObject = {
  left_column_apps: true,
  left_column_behavior: 'tooltip',
  left_column_default_mode: 'apps',
  always_collapsible_left_column: true,
  left_column_auto_collapse: { apps: true }
};

/** Org defaults apply to every member, without changing another org's identity preferences. */
export function effectiveNavigationPreferences(organization: JsonObject, preferences: unknown): JsonObject {
  const metadata = organization.metadata as JsonObject | undefined;
  const defaults = metadata?.sandbox_workflow_id === 'swf_instant_full_org' ? INSTANT_ORG_NAVIGATION : {};
  return { ...defaults, ...(preferences && typeof preferences === 'object' && !Array.isArray(preferences) ? preferences : {}) };
}
