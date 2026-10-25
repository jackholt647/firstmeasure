import { addTabFaqs, registerExperience } from "../registry.js";

/**
 * The Customer Portal tab's tour (app id project.customer_portal): the first time someone opens the tab on a project,
 * and again from the agent's "Show me the tutorial again". Data only; the runtime plays it. Targets are the tab's own
 * `data-cpo-*` hooks (apps/customer-portal/project.js). The customer options appear only where the organization has
 * rescheduling or guest links on, so that step is skipped elsewhere.
 */
const t = (key: string, text: string) => ({ key, text });
export const PORTAL_TUTORIAL = "customer_portal.tab_tutorial";

let registered = false;
export function registerCustomerPortalGuidedExperiences() {
  if (registered) return;
  registered = true;

  registerExperience({
    id: PORTAL_TUTORIAL, version: 1, kind: "overlay", scope: "person", salt: "2026-10", replayable: true,
    title: t("gx_cpt_title", "Customer Portal tour"),
    tab: "project.customer_portal",
    eligibility: { capabilities: ["platform.customer_portal"] },
    triggers: [{ kind: "tab_opened", tab: "project.customer_portal", delay_ms: 900 }],
    variants: [{ id: "tour", weight: 1 }],
    steps: [
      { id: "intro", targets: [], placement: "center", title: t("gx_cpt_intro_title", "Welcome to the Customer Portal"), body: t("gx_cpt_intro_body", "Your customer gets their own private page for this project. This tab is where you set it up. Here's a quick look around.") },
      { id: "link", targets: ["[data-cpo-link-card]"], title: t("gx_cpt_link_title", "The customer's link"), body: t("gx_cpt_link_body", "Make their private link here, then copy it, email it or download a QR code. Nothing is sent until you send it.") },
      { id: "preview", targets: ["[data-cpo-preview]"], title: t("gx_cpt_preview_title", "Preview"), body: t("gx_cpt_preview_body", "See exactly what the customer sees, in a new tab.") },
      { id: "options", targets: ["[data-cpo-resched-switch]", "[data-cpo-guest-switch]"], title: t("gx_cpt_options_title", "What the customer can do"), body: t("gx_cpt_options_body", "Choose whether the customer can pick a new appointment time or share a read-only link with someone else.") },
      { id: "media", targets: ["[data-cpo-media]"], title: t("gx_cpt_media_title", "Photos they see"), body: t("gx_cpt_media_body", "Choose which photos and videos from the Photos tab show in their portal.") },
      { id: "history", targets: ["[data-cpo-history]"], title: t("gx_cpt_history_title", "History"), body: t("gx_cpt_history_body", "When the customer visited and what they opened. Your own previews don't count.") },
      { id: "outro", targets: [], placement: "center", title: t("gx_cpt_outro_title", "You're all set"), body: t("gx_cpt_outro_body", "Want this tour again? Ask the agent \"Show me the tutorial again\".") }
    ]
  });

  // The tab's other questions live in materials.ts; this adds the replay beside them.
  addTabFaqs({ tab: "project.customer_portal", questions: [
    { id: "portal.tour", text: t("gx_faq_portal_tour", "Show me the tutorial again"), action: "play", experience: PORTAL_TUTORIAL }
  ] });
}
