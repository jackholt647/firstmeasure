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
    description: t("gx_mps_description_2", "Tell us what kinds of roofs you install and the materials you use, and new materials lists start from them."),
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
      // Ready for an experiment: the same setup without the labor step. Weight 0 until someone turns it on.
      { id: "agentic_express", weight: 0, when: { field: "organization.flags.assistant", operator: "equals", value: true }, steps: ["roof_types", "brands", "defaults", "material", "suppliers"] },
      // Without the assistant the same steps play as a modal.
      { id: "modal", kind: "modal", weight: 1, when: { field: "organization.flags.assistant", operator: "not_equals", value: true } }
    ],
    // Two paths. Shingle: manufacturers, then the defaults generation uses. Anything else: the default material, whose
    // components (roof-type components, provisional) are the defaults. Both then go on to suppliers and labor.
    steps: [
      {
        id: "roof_types", widget: "roof-types", source: "pricebook.roofing_setup", selects: ["roof_types", "region", "state"],
        title: t("gx_mps_types_title", "What kinds of roofs do you install?"),
        subtitle: t("gx_mps_types_subtitle", "Pick every kind you install. You can change this any time."),
        say: [
          t("gx_mps_types_say_1", "Before I build your first materials list, let's set up your price book so it uses what you actually install. It takes about a minute."),
          t("gx_mps_types_say_2", "First: what kinds of roofs do you install? Pick as many as you like.")
        ],
        next: { branches: [{ when: { field: "selections.roof_types", operator: "contains", value: "shingle" }, to: "brands" }], otherwise: "material" }
      },
      {
        id: "brands", widget: "brand-cards", source: "pricebook.roofing_setup", selects: ["brands"],
        title: t("gx_mps_makers_title", "What roofing manufacturers do you use?"),
        subtitle: t("gx_mps_makers_subtitle", "Pick every brand you use. Everything they make goes in your price book so you can find it, and your defaults come from the first one you pick."),
        say: [t("gx_mps_makers_say_1", "Which roofing manufacturers do you use? Pick as many as you like. Your defaults come from the first one you pick.")],
        options: { allow_all: true }
      },
      {
        // What generation uses when there is no document. No waste or formulas: those stay in Settings.
        id: "defaults", widget: "material-defaults", source: "pricebook.roofing_setup", selects: ["defaults"], required: false, next: "suppliers",
        options: { skip_sets: { defaults: {} } },
        title: t("gx_mps_defaults_title", "Set your default materials"),
        subtitle: t("gx_mps_defaults_subtitle", "What a new materials list uses when there's no document yet. Change any of them, or skip this to use these."),
        say: [t("gx_mps_defaults_say_1", "Here's what I'll use by default, from the brands you picked. Change anything that isn't what you use, or skip this step.")]
      },
      {
        id: "material", widget: "default-material", source: "pricebook.roofing_setup", selects: ["default_material"],
        title: t("gx_mps_material_title", "What's your default roofing material?"),
        subtitle: t("gx_mps_material_subtitle", "A new materials list starts with this: the roof in squares, plus the parts that kind of roof needs."),
        say: [t("gx_mps_material_say_1", "Which of these do you install most? New materials lists will start with it.")]
      },
      {
        id: "suppliers", widget: "supplier-columns", source: "pricebook.roofing_setup", selects: ["suppliers"], required: false,
        title: t("gx_mps_suppliers_title", "Who provides your materials?"),
        subtitle: t("gx_mps_suppliers_subtitle_2", "Pick or type every supplier you buy from. Each column shows what that supplier carries, and a price sheet sets its costs."),
        say: [
          t("gx_mps_suppliers_say_2", "Who do you buy your materials from? Pick your suppliers, or type your own and press Enter."),
          t("gx_mps_price_sheet_say", "If you have a price sheet from your supplier, you can upload it here and I'll set it up for you.")
        ],
        // Costs are set here, per supplier; a cost typed in a column (or the price seen there) becomes the price book cost.
        upload: { line: "gx_mps_price_sheet_say", button: t("gx_mps_price_sheet_button", "Upload a price sheet"), message: t("gx_mps_price_sheet_message", "Here's my supplier price sheet. Please update my material prices from it."), accept: ".csv,.xlsx,.xls,.pdf,.txt" },
        agent_note: t("gx_mps_suppliers_agent_3", "Price sheets. A sheet for a named supplier (its id is in the message): read it and match each line to their price book items (pricebook.prices.list) and that supplier's items (suppliers.catalog). Lines that match nothing are new items (common for metal, tile, slate and flat roofs, which have no manufacturer catalog): list them with their unit and cost and, once the person agrees, add them with pricebook.items.add (category and type from the kind of roof). Show the matches and cost changes as a short list, ask before applying any uncertain match, then set that supplier's costs with suppliers.prices.update (cents) for the matched and added items, and offer to update the price book costs too (pricebook.prices.update). A sheet with no supplier named: the same against the price book only. Costs only, never a markup. The setup's columns refresh when they continue.")
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
      say: [t("gx_mps_done_say_2", "Your price book is ready. Start generating this project's materials, or have a look at your price book first.")],
      then: [{ handoff: "assistant_tray" }, { resume: true }, { play: MATERIALS_TUTORIAL }]
    }
  });

  registerExperience({
    id: MATERIALS_TUTORIAL, version: 1, kind: "overlay", scope: "person", salt: "2026-10", replayable: true,
    title: t("gx_operations_tour_title", "Operations tour"),
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
    // Operations is available before measurements, including on a new project's first visit.
    variants: [{ id: "tour", weight: 1 }],
    steps: [
      { id: "intro", targets: [], placement: "center", title: t("gx_operations_intro_title", "Welcome to Operations"), body: t("gx_operations_intro_body", "Plan your materials, labor and equipment here. Start a list now, or generate one from measurements when they're ready. Here's a quick look around.") },
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
