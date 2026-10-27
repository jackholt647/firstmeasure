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
  "project.materials": ["platform.materials"]
} as const;

export type OfferedAppId = keyof typeof APP_OFFERS;
export const NEW_ORGANIZATION_APP_OFFERS = Object.keys(APP_OFFERS) as OfferedAppId[];

const copy = (key: string, text: string) => ({ key: `gx_offer_${key}`, text });
/** Static advertisements, not guide progress. The existing guide starts after activation. */
export const APP_WELCOMES = {
  "project.photos": { theme: "photos", eyebrow: copy("photos_name", "Project Photos"),
    headline: copy("photos_headline", "Every job. Every detail. All together."),
    description: copy("photos_description", "Keep the whole story of a project in one place—from the first visit to the final walkthrough."),
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
  "project.materials": { theme: "materials", eyebrow: copy("operations_name", "Operations"),
    headline: copy("materials_headline", "From measurements to materials."),
    description: copy("materials_description", "Build the list that moves the job forward. Bring your products, quantities, and material planning into the project."),
    benefits: [copy("materials_b1", "Build and adjust project material lists"), copy("materials_b2", "Use your own products and calculation rules"), copy("materials_b3", "Keep quantities and job details together")],
    caption: copy("materials_caption", "Your products. Your rules. Your material lists.") }
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
