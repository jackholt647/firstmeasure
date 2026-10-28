/** Organization-wide offers for apps that have not yet been started.
 *
 * An offer is separate from the configured capability values: those values
 * describe what will become available when the offer is accepted. Until then
 * the operational capability and its dependent features must resolve off.
 */
export const APP_OFFERS = {
  "project.photos": ["platform.project_photos"],
  "project.docs": ["platform.project_docs", "platform.documents"],
  "project.customer_portal": ["platform.customer_portal"],
  "project.materials": ["platform.materials"],
  "portal.equipment": ["apps.equipment"],
  // Money's project tab and its Financials page are one app: offers with the same switches start together.
  "project.money": ["platform.money"],
  "portal.financials": ["platform.money"],
  "project.checklists": ["apps.checklists"]
} as const;

export type OfferedAppId = keyof typeof APP_OFFERS;
/** What every new organization starts with. A signup sandbox configuration may name its own list (settings.app_offers). */
export const NEW_ORGANIZATION_APP_OFFERS: OfferedAppId[] = ["project.photos", "project.docs", "project.customer_portal", "project.materials", "portal.equipment"];

/** Offers that start together with this one: the same switches are the same app. */
export function offerSiblings(id: OfferedAppId): OfferedAppId[] {
  const switches = [...APP_OFFERS[id]].sort().join(",");
  return (Object.keys(APP_OFFERS) as OfferedAppId[]).filter((other) => [...APP_OFFERS[other]].sort().join(",") === switches);
}

/**
 * An offer that only makes sense after another app is set up. It is advertised
 * once the organization's setup guide has reached `step` or completed, read from
 * the guide's own recorded events (so a later replay does not withdraw it).
 * This gates only the offer: an app already started, or switched on without an
 * offer, is unaffected.
 */
export const APP_OFFER_PREREQUISITES: Partial<Record<OfferedAppId, { experience: string; step: string }>> = {
  // Equipment is matched to the requirements an Operations scope of work publishes.
  "portal.equipment": { experience: "operations.setup", step: "ready" }
};

/** The pending offers whose prerequisite setup has been reached. */
export async function offersWithPrerequisitesMet(orgId: string, ids: readonly OfferedAppId[]) {
  const gated = ids.filter(id => APP_OFFER_PREREQUISITES[id]);
  if (!gated.length) return [...ids];
  const { setupReached } = await import("../../guided-experiences/store.js");
  const met = new Set<OfferedAppId>();
  for (const id of gated) {
    const { experience, step } = APP_OFFER_PREREQUISITES[id]!;
    if (await setupReached(orgId, experience, step)) met.add(id);
  }
  return ids.filter(id => !APP_OFFER_PREREQUISITES[id] || met.has(id));
}

/**
 * The advertisement an offered app shows until it is started (its welcome) is a config library entry of kind
 * app_welcome, keyed by the offered app id (config-library/kinds/app_welcome.ts), read into the entitlements.
 */

/** Ignore unrecognized stored values, rather than allowing them to mask other features. */
export function offeredAppIds(value: unknown): OfferedAppId[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is OfferedAppId =>
    typeof id === "string" && Object.prototype.hasOwnProperty.call(APP_OFFERS, id)))];
}

/** Mask offered features before resolving the shared capability dependency graph. */
export function maskOfferedCapabilities<T extends Record<string, unknown>>(values: T, offers: unknown): T {
  const result = { ...values };
  for (const id of offeredAppIds(offers)) {
    for (const key of APP_OFFERS[id]) (result as Record<string, unknown>)[key] = false;
  }
  return result;
}
