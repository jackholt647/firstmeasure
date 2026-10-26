import { roofingSetupOptions } from "../../pricebook/setups/roofing.js";
import { laborSetupOptions } from "../../labor/labor-setup.js";
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
  registerGuidedSource("labor.setup", (ctx) => laborSetupOptions(ctx.orgId));

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
    // The first time someone who can set it up opens Materials, report or not; Generate catches anyone who skipped.
    triggers: [
      { kind: "tab_opened", tab: "project.materials", delay_ms: 500 },
      { kind: "before_action", action: "materials.generate", selector: "[data-mt-generate-materials],[data-mt-generate-column]", once: true }
    ],
    variants: [
      // The agent beside the setup, where the assistant is on for the organization.
      { id: "agentic", weight: 1, when: { field: "organization.flags.assistant", operator: "equals", value: true } },
      // Ready for an experiment: the same setup without the walkthrough of rules. Weight 0 until someone turns it on.
      { id: "agentic_express", weight: 0, when: { field: "organization.flags.assistant", operator: "equals", value: true }, steps: ["brands", "lines", "suppliers"] },
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
          t("gx_mps_rules_say_3", "Hover over a material to see how it's worked out, or click it to change that. Most people only change two things: how much waste they allow, and how far up from the eaves the ice and water barrier goes.")
        ]
      },
      {
        id: "suppliers", widget: "supplier-columns", source: "pricebook.roofing_setup", selects: ["suppliers"], required: false,
        title: t("gx_mps_suppliers_title", "Who provides your materials?"),
        subtitle: t("gx_mps_suppliers_subtitle", "Pick every supplier you buy from, or type your own. Each one starts with the brands it stocks; change what it carries any time."),
        say: [
          t("gx_mps_suppliers_say_1", "Who do you buy from? Pick your suppliers. I'll load each one with the products it usually stocks, and you can change that."),
          t("gx_mps_price_sheet_say", "If you have a price sheet from your supplier, you can upload it here and I'll set it up for you.")
        ],
        // Costs are set here, per supplier; a cost typed in a column (or the price seen there) becomes the price book cost.
        upload: { line: "gx_mps_price_sheet_say", button: t("gx_mps_price_sheet_button", "Upload a price sheet"), message: t("gx_mps_price_sheet_message", "Here's my supplier price sheet. Please update my material prices from it."), accept: ".csv,.xlsx,.xls,.pdf,.txt" },
        agent_note: t("gx_mps_suppliers_agent_2", "Price sheets. A sheet for a named supplier (its id is in the message): read it, match each line to their price book items (pricebook.prices.list) and that supplier's items (suppliers.catalog), show the matches and cost changes as a short list, ask before applying any uncertain match, then set that supplier's costs with suppliers.prices.update (cents), and offer to update the price book costs too (pricebook.prices.update). A sheet with no supplier named: match it to price book items and apply the confirmed costs with pricebook.prices.update; if it is clearly from one of their suppliers, offer to set that supplier's costs too. Costs only, never a markup. The setup's columns refresh when they continue.")
      },
      {
        // Who does the labor: groups of users (employees) and outside companies (subcontractors), and how each is paid,
        // saved as pay sheets. Only where groups and outside companies are on; elsewhere labor stays plain lines.
        // Skipping leaves nobody to do labor, so the Materials tab's Labor column stays off until someone is added.
        id: "labor", widget: "labor-assignees", source: "labor.setup", selects: ["labor", "include_labor"], required: false,
        eligibility: { capabilities: ["apps.crew", "platform.people_access", "platform.expanded_access", "platform.materials"], permissions: ["manage_company_settings"] },
        options: { optional: true, skip_sets: { include_labor: false, labor: { assignees: [], skipped: true } } },
        title: t("gx_mps_labor_title", "Who does your labor?"),
        subtitle: t("gx_mps_labor_subtitle", "Add the groups of employees and the subcontractors who install your roofs, and how each is paid. Skip this if you don't track labor here."),
        say: [
          t("gx_mps_labor_say_1", "Last one: who installs your roofs? Add your own groups and any subcontractors, and how you pay each one."),
          t("gx_mps_labor_say_2", "If you have someone's pay sheet or rate card, upload it on their card and I'll set up their pay from it.")
        ],
        agent_note: t("gx_mps_labor_agent", "Pay sheets. When the person uploads a pay sheet or rate card for a named group or subcontractor (its assignee key, such as resource_group:abc, is in the message), read it and write that assignee's roofing pay sheet: inputs from the roofing measurements (roof.squares and its pitch bands, roof line lengths), hours or a number typed per job, and one entry per thing they charge. Check it with pay-sheets.try, show the person the lines in plain words, ask about anything unclear, then save it with pay-sheets.sheet.save (rates in cents). Never work out what anyone is paid; a pay sheet is evaluated by the platform.")
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
      // The first time they open the tab once the price book is set up, or straight away for someone who is not asked to set it up.
      { kind: "tab_opened", tab: "project.materials", delay_ms: 900, when: { match: "any", rules: [
        { field: "organization.finished", operator: "contains", value: MATERIALS_SETUP },
        { field: "person.eligible", operator: "not_contains", value: MATERIALS_SETUP }
      ] } }
    ],
    // Onboarding sequencing: until this person has been through the tour (or closed it), Materials shows only on
    // projects with a delivered report, where it has something to show. Afterwards it shows on every project.
    reveal: [{ tab: "project.materials", until: "finished", when: { "project.has_report": true } }],
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
