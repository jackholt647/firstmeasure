/**
 * Org-level punch-list defaults and terminology.
 *
 * House rules live here so an org sets them once ("we always want an
 * acceptance signature", "we call these snag lists") instead of repeating them
 * in every scope template. A scope template that specifies a value still wins —
 * see normalizePunchConfig's layering.
 *
 * Stored on the customer_portal site record under
 * `settings.portal_defaults.punch_list`, alongside the other portal defaults,
 * so there is one place an admin configures portal behavior.
 *
 * Contract: docs/customer-portal-v2-spec.md §8.2.
 */

import type { JsonObject } from "./storage.js";

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

/**
 * The org's punch-list defaults, or {} when the websites module is unavailable
 * or the org has never configured any. Never throws — a missing default block
 * must degrade to built-in copy, not fail the automation that asked for it.
 */
export async function readPortalPunchDefaults(orgId: string): Promise<JsonObject> {
  try {
    const websites: { portalSiteConfig?: (orgId: string) => Promise<unknown> } = await import(("../websites/service.js") as string);
    const config = asObject(await websites?.portalSiteConfig?.(orgId));
    return asObject(asObject(config.portal_defaults).punch_list);
  } catch {
    return {};
  }
}
