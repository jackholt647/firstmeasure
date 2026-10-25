import { roofingSetupOptions } from "../../pricebook/setups/roofing.js";
import { registerExperience, registerGuidedSource, registerTabFaqs } from "../registry.js";

/**
 * The Materials tab's guided experiences: the roofing price book setup the first time an organization generates
 * materials, the tab tutorial that follows it, and the assistant's suggested questions on the tab. Data only; the
 * runtime plays it (guided-experiences/service.ts, libraries/guided-experiences/).
 */
const t = (key: string, text: string) => ({ key, text });
export const MATERIALS_SETUP = "materials.pricebook_setup.roofing";
export const MATERIALS_TUTORIAL = "materials.tab_tutorial";

let registered = false;
export function registerMaterialsGuidedExperiences() {
  if (registered) return;
  registered = true;

  // Products, rules and prices for the organization's price region. The chooser context supplies the region.
  registerGuidedSource("pricebook.roofing_setup", (_ctx, chooser) => roofingSetupOptions(chooser.organization.state, chooser.organization.region));

  registerExperience({
    id: MATERIALS_SETUP, version: 1, kind: "agentic", scope: "organization", salt: "2026-10",
    title: t("gx_mps_title", "Set up your price book"),
    description: t("gx_mps_description", "Pick the shingles you install and see how a roof's measurements become a materials list."),
    tab: "project.materials",
    eligibility: {
      capabilities: ["platform.materials"],
      permissions: ["manage_company_settings", "manage_projects"],
      // Roofing first. An organization that has not said what it does is treated as roofing, as FirstMeasure customers are.
      when: { match: "any", rules: [{ field: "organization.industry", operator: "is_missing" }, { field: "organization.industry", operator: "in", value: ["roofing", "exteriors", "roofing_and_exteriors"] }] }
    },
    triggers: [{ kind: "before_action", action: "materials.generate", selector: "[data-mt-generate-materials],[data-mt-generate-column]", once: true }],
    variants: [
      // The agent beside the setup, where the assistant is on for the organization.
      { id: "agentic", weight: 1, when: { field: "organization.flags.assistant", operator: "equals", value: true } },
      // Ready for an experiment: the same setup without the walkthrough of rules. Weight 0 until someone turns it on.
      { id: "agentic_express", weight: 0, when: { field: "organization.flags.assistant", operator: "equals", value: true }, steps: ["brands", "lines", "prices"] },
      // Without the assistant the same steps play as a modal.
      { id: "modal", kind: "modal", weight: 1, when: { field: "organization.flags.assistant", operator: "not_equals", value: true } }
    ],
    steps: [
      {
        id: "brands", widget: "brand-cards", source: "pricebook.roofing_setup", selects: ["brands", "region", "state"],
        title: t("gx_mps_brands_title", "Which shingle manufacturers do you use?"),
        subtitle: t("gx_mps_brands_subtitle", "Pick every brand you install. You can change this any time."),
        say: [
          t("gx_mps_brands_say_1", "Before I build your first materials list, let's set up your price book so it uses the products you actually install. It takes about a minute."),
          t("gx_mps_brands_say_2", "First: which shingle manufacturers do you use? Pick as many as you like, or use them all.")
        ],
        options: { allow_all: true }
      },
      {
        id: "lines", widget: "product-lines", source: "pricebook.roofing_setup", selects: ["lines", "default_line"],
        title: t("gx_mps_lines_title", "What shingles do you usually use?"),
        subtitle: t("gx_mps_lines_subtitle", "Tick the lines you install. The starred one is what a new materials list starts with."),
        say: [t("gx_mps_lines_say_1", "Here are the shingle lines for the brands you picked. Tick the ones you install, and star the one you use most.")],
        options: { allow_all: true }
      },
      {
        id: "rules", widget: "measurement-rules", source: "pricebook.roofing_setup", selects: ["waste", "ice_eave_width"], required: false,
        title: t("gx_mps_rules_title", "How a roof becomes a materials list"),
        subtitle: t("gx_mps_rules_subtitle", "Every roof report comes with measurements. Each material is worked out from them, plus a little extra for waste."),
        say: [
          t("gx_mps_rules_say_1", "This is the part that saves you time. Shingles come from the roof's squares, starter from the eaves and rakes, ridge cap from the hips and ridges."),
          t("gx_mps_rules_say_2", "Tap any card to see the maths on a sample roof. Only two things are up to you: how much waste you allow, and how far up from the eaves your ice and water barrier goes.")
        ]
      },
      {
        id: "prices", widget: "price-review", source: "pricebook.roofing_setup", selects: ["prices", "markup", "include_labor"], required: false,
        title: t("gx_mps_prices_title", "Check your prices"),
        subtitle: t("gx_mps_prices_subtitle", "Typical prices for your area. Change any that don't look right."),
        say: [t("gx_mps_prices_say_1", "Last step. These are typical prices for your area. Change any that look off; you can edit them in your price book later too.")]
      }
    ],
    completion: {
      action: { id: "pricebook.setup.apply", target: "organization", input: { trade: "roofing" } },
      say: [t("gx_mps_done_say_1", "Your price book is ready. I'm building this project's materials list from it now, then I'll show you around the tab.")],
      then: [{ handoff: "assistant_tray" }, { resume: true }, { play: MATERIALS_TUTORIAL }]
    }
  });

  registerExperience({
    id: MATERIALS_TUTORIAL, version: 1, kind: "overlay", scope: "person", salt: "2026-10", replayable: true,
    title: t("gx_mt_title", "Materials tour"),
    tab: "project.materials",
    eligibility: { capabilities: ["platform.materials"] },
    triggers: [
      { kind: "after_experience", experience: MATERIALS_SETUP },
      // Someone joining an organization that already set up its price book gets the tour the first time they open the tab.
      { kind: "tab_opened", tab: "project.materials", delay_ms: 900, when: { field: "organization.finished", operator: "contains", value: MATERIALS_SETUP } }
    ],
    variants: [{ id: "tour", weight: 1 }],
    steps: [
      { id: "intro", targets: [], placement: "center", title: t("gx_mt_intro_title", "Welcome to Materials"), body: t("gx_mt_intro_body", "Every list here is built from the roof's measurements and your price book. Here's a quick look around.") },
      { id: "generate", targets: ["[data-mt-generate-materials]"], title: t("gx_mt_generate_title", "Generate"), body: t("gx_mt_generate_body", "Builds the lists again from the measurements and your price book. Lists you've ordered are never touched.") },
      { id: "lists", targets: [".mt-resource-column"], title: t("gx_mt_lists_title", "Your lists"), body: t("gx_mt_lists_body", "Materials, labor and equipment each get a column. Click any quantity or price to change it.") },
      { id: "pricebook", targets: ["[data-mt-open-pricebook]"], title: t("gx_mt_pricebook_title", "Price book"), body: t("gx_mt_pricebook_body", "Add anything from your price book to a list.") },
      { id: "add", targets: ["[data-mt-add-custom]"], title: t("gx_mt_add_title", "Add a line"), body: t("gx_mt_add_body", "Add a one-off item that isn't in your price book.") },
      { id: "units", targets: ["[data-mt-units-toggle]"], title: t("gx_mt_units_title", "Squares or bundles"), body: t("gx_mt_units_body", "Switch between the measured amounts and what you actually order: bundles, rolls and boxes.") },
      { id: "total", targets: ["[data-mt-projected-total]"], title: t("gx_mt_total_title", "Projected total"), body: t("gx_mt_total_body", "What every list on this project should cost, delivery included.") },
      { id: "order", targets: ["[data-mt-order-all]"], title: t("gx_mt_order_title", "Order"), body: t("gx_mt_order_body", "Email each list to its supplier, make a purchase order or a shopping list.") },
      { id: "agent", targets: [".fm-project-tray-tabs [data-tray=\"agent\"]"], placement: "left", title: t("gx_mt_agent_title", "Ask me"), body: t("gx_mt_agent_body", "I can press these buttons for you. Try \"Generate the materials list for me\", or ask how anything here works.") },
      { id: "outro", targets: [], placement: "center", title: t("gx_mt_outro_title", "You're all set"), body: t("gx_mt_outro_body", "Want this tour again? Ask the agent \"Show me the tutorial again\".") }
    ]
  });

  registerTabFaqs({ tab: "project.materials", questions: [
    { id: "materials.how_generate", text: t("gx_faq_mat_how_generate", "How do I generate the materials list?") },
    { id: "materials.generate_for_me", text: t("gx_faq_mat_generate_for_me", "Generate the materials list for me") },
    { id: "materials.quantities", text: t("gx_faq_mat_quantities", "How are the quantities worked out?") },
    { id: "materials.order", text: t("gx_faq_mat_order", "How do I order from my supplier?") },
    { id: "materials.tour", text: t("gx_faq_mat_tour", "Show me the tutorial again"), action: "play", experience: MATERIALS_TUTORIAL }
  ] });
  registerTabFaqs({ tab: "project.photos", questions: [
    { id: "photos.add", text: t("gx_faq_photos_add", "How do I add photos to this project?") },
    { id: "photos.share", text: t("gx_faq_photos_share", "Can the customer see these photos?") },
    { id: "photos.markup", text: t("gx_faq_photos_markup", "How do I mark up a photo?") }
  ] });
  registerTabFaqs({ tab: "project.docs", questions: [
    { id: "docs.proposal", text: t("gx_faq_docs_proposal", "How do I make a proposal for this project?") },
    { id: "docs.sign", text: t("gx_faq_docs_sign", "How does the customer sign?") }
  ] });
  registerTabFaqs({ tab: "project.measurements", questions: [
    { id: "reports.read", text: t("gx_faq_reports_read", "Walk me through this roof report") },
    { id: "reports.order", text: t("gx_faq_reports_order", "How do I order another report?") }
  ] });
  registerTabFaqs({ tab: "project.customer_portal", questions: [
    { id: "portal.what", text: t("gx_faq_portal_what", "What does the customer see in their portal?") },
    { id: "portal.share", text: t("gx_faq_portal_share", "How do I send the customer their portal link?") }
  ] });
  registerTabFaqs({ tab: "project.map", questions: [
    { id: "overview.next", text: t("gx_faq_overview_next", "What should I do next on this project?") },
    { id: "overview.summary", text: t("gx_faq_overview_summary", "Summarize this project for me") }
  ] });
}
