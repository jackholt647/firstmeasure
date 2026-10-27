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

const copy = (key: string, text: string) => ({ key: `gx_offer_${key}`, text });
/**
 * Static advertisements, not guide progress. The existing guide starts after activation. `layout`: `page` draws the
 * advertisement as one full-width page (copy, then the illustration below it) instead of the default two sides.
 */
export const APP_WELCOMES = {
  "portal.equipment": { theme: "equipment", eyebrow: copy("equipment_name", "Equipment"),
    headline: copy("equipment_headline", "The right equipment for every job."),
    description: copy("equipment_description", "Connect the equipment you own or rent to the work your projects need."),
    benefits: [copy("equipment_b1", "Keep your equipment and its capabilities together"), copy("equipment_b2", "Match equipment to requirements from your scope of work"), copy("equipment_b3", "Plan project equipment alongside materials and work orders")],
    caption: copy("equipment_caption", "Your equipment. Connected to the work.") },
  "project.photos": { theme: "photos", eyebrow: copy("photos_name", "Project Photos"),
    headline: copy("photos_headline", "Every job. Every detail. All together."),
    description: copy("photos_description", "Keep the whole story of a project in one place - from the first visit to the final walkthrough."),
    benefits: [copy("photos_b1", "Capture and upload right from the jobsite"), copy("photos_b2", "Keep project photos organized and easy to find"), copy("photos_b3", "Share the details with your team")],
    caption: copy("photos_caption", "A clearer picture of every project.") },
  "project.docs": { theme: "documents", eyebrow: copy("docs_name", "Project Documents"),
    headline: copy("docs_headline", "Less paperwork. More progress."),
    description: copy("docs_description", "Give every proposal, contract, and project file a home. Keep the information you need right beside the work."),
    benefits: [copy("docs_b1", "Keep project documents together"), copy("docs_b2", "Create documents from reusable templates"), copy("docs_b3", "Find the right file without the back-and-forth")],
    caption: copy("docs_caption", "From the first proposal to the final detail.") },
  "project.customer_portal": { theme: "portal", eyebrow: copy("portal_name", "Customer Portal"),
    headline: copy("portal_headline", "Keep customers in the loop."),
    description: copy("portal_description", "Give each customer a simple place to follow their project. A professional experience, with fewer things to chase."),
    benefits: [copy("portal_b1", "Give every project its own customer link"), copy("portal_b2", "Choose what you share with the customer"), copy("portal_b3", "Bring project information into one place")],
    caption: copy("portal_caption", "Their project. One simple link.") },
  "project.materials": { theme: "materials", layout: "page", eyebrow: copy("operations_name", "Operations"),
    headline: copy("operations_headline", "Turn your scope into a plan."),
    description: copy("operations_description", "Bring measurements, materials, work orders and equipment together. Start with what the job needs, then get everything ready to do the work."),
    benefits: [copy("operations_b1", "Build material lists from your project scope"), copy("operations_b2", "Plan work orders and who will do the work"), copy("operations_b3", "Match equipment to the project's requirements")],
    caption: copy("operations_caption", "One scope. Everything you need to get it done.") },
  // `setup`: the switch whose required setup workflow Get Started continues into (app-setup-workflows.js).
  "project.money": { theme: "money", setup: "platform.money", setup_note: copy("money_setup_note", "Get Started begins with payments onboarding."),
    eyebrow: copy("money_name", "Money"),
    headline: copy("money_headline", "Get paid for every job."),
    description: copy("money_description", "See what each project has billed, collected and spent, and take payments from customers right from the project."),
    benefits: [copy("money_b1", "Take card and bank payments from customers"), copy("money_b2", "Follow payments, expenses and profit on every project"), copy("money_b3", "Set payment schedules that match the work")],
    caption: copy("money_caption", "Every project's money, in one place.") },
  "portal.financials": { theme: "money", setup: "platform.money", setup_note: copy("money_setup_note", "Get Started begins with payments onboarding."),
    eyebrow: copy("financials_name", "Financials"),
    headline: copy("financials_headline", "Know where your business stands."),
    description: copy("financials_description", "Profit, revenue and cash flow across all of your projects, built from the payments and expenses you already record."),
    benefits: [copy("financials_b1", "See profit on every project"), copy("financials_b2", "Follow revenue and what is still owed"), copy("financials_b3", "Look ahead with cash flow forecasts")],
    caption: copy("financials_caption", "Your numbers, without the spreadsheet.") },
  "project.checklists": { theme: "checklists", eyebrow: copy("checklists_name", "Checklists"),
    headline: copy("checklists_headline", "Every step. Done right."),
    description: copy("checklists_description", "Give each job the checklists it needs and see who completed each item, and when."),
    benefits: [copy("checklists_b1", "Build checklists for the work you repeat"), copy("checklists_b2", "See who completed each item"), copy("checklists_b3", "Review finished work before you sign off")],
    caption: copy("checklists_caption", "Nothing missed on the job.") }
} as const;

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
