import { appDefinition, appDefinitions, type AppDefinition } from "./registry.js";

/** Organization-wide offers for apps that have not yet been started.
 *
 * An offer is separate from the configured capability values: those values
 * describe what will become available when the offer is accepted. Until then
 * the operational capability and its dependent features must resolve off.
 *
 * Every app with an organization switch can be offered (FM-468): its offer holds back the app's own switches
 * (registry `capabilities`). APP_OFFERS only names offers whose switches differ from that (Docs also holds
 * Documents; Financials is Money's page, so it holds Money's switch).
 */
export const APP_OFFERS: Record<string, readonly string[]> = {
  "project.photos": ["platform.project_photos"],
  "project.docs": ["platform.project_docs", "platform.documents"],
  "project.customer_portal": ["platform.customer_portal"],
  "project.materials": ["platform.materials"],
  "portal.equipment": ["apps.equipment"],
  // Money's project tab and its Financials page are one app: offers with the same switches start together.
  "project.money": ["platform.money"],
  "portal.financials": ["platform.money"],
  "project.checklists": ["apps.checklists"],
  // Scheduling's project tab and its Scheduling page are one app, like Money.
  "project.schedule": ["platform.scheduling"],
  "portal.scheduling": ["platform.scheduling"]
};

/** An app id that can be offered: any app with at least one organization switch. */
export type OfferedAppId = string;

/** The switches an offer of this app holds back until it is started; empty when the app cannot be offered. */
export function offerSwitches(id: string): readonly string[] {
  const named = Object.prototype.hasOwnProperty.call(APP_OFFERS, id) ? APP_OFFERS[id] : undefined;
  return named ?? appDefinition(id)?.capabilities ?? [];
}

/** Whether an app can be offered: an app without an organization switch is always on, so there is nothing to hold back. */
export function isOfferableApp(id: unknown): id is OfferedAppId {
  return typeof id === "string" && offerSwitches(id).length > 0;
}

/** Every app that can be offered: the named offers first, then the rest in registry order. */
export function offerableAppIds(): OfferedAppId[] {
  return [...new Set([...Object.keys(APP_OFFERS), ...appDefinitions().map(app => app.id)])].filter(isOfferableApp);
}

/** What every new organization starts with. A signup sandbox configuration may name its own list (settings.app_offers). */
export const NEW_ORGANIZATION_APP_OFFERS: OfferedAppId[] = ["project.photos", "project.docs", "project.customer_portal", "project.materials", "portal.equipment"];

/** Offers that start together with this one: the same switches are the same app. */
export function offerSiblings(id: OfferedAppId): OfferedAppId[] {
  const key = (app: string) => [...offerSwitches(app)].sort().join(",");
  const switches = key(id);
  if (!switches) return [];
  return offerableAppIds().filter((other) => key(other) === switches);
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
 * An offered app with no entry yet shows this generic welcome instead, marked `placeholder`, until someone writes
 * its own.
 */
export function placeholderWelcome(app: Pick<AppDefinition, "id" | "title">) {
  const slug = app.id.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  return {
    placeholder: true as const,
    theme: "generic" as const,
    eyebrow: { key: "gx_offer_placeholder_eyebrow", text: "New in FirstMate" },
    headline: { key: `gx_offer_app_${slug}_title`, text: app.title },
    description: { key: "gx_offer_placeholder_description", text: "Add this app to your organization whenever you are ready. Get Started turns it on for everyone who uses it." },
    benefits: [
      { key: "gx_offer_placeholder_b1", text: "Works with the projects and people you already have" },
      { key: "gx_offer_placeholder_b2", text: "Nothing to install" },
      { key: "gx_offer_placeholder_b3", text: "Start it when your team is ready" }
    ],
    caption: { key: "gx_offer_placeholder_caption", text: "One more part of your FirstMate workspace." }
  };
}

/** Ignore unrecognized stored values, rather than allowing them to mask other features. */
export function offeredAppIds(value: unknown): OfferedAppId[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isOfferableApp))];
}

/** Mask offered features before resolving the shared capability dependency graph. */
export function maskOfferedCapabilities<T extends Record<string, unknown>>(values: T, offers: unknown): T {
  const result = { ...values };
  for (const id of offeredAppIds(offers)) {
    for (const key of offerSwitches(id)) (result as Record<string, unknown>)[key] = false;
  }
  return result;
}
