import { addTabFaqs, registerExperience } from "../registry.js";

/**
 * The Reports tab's tour (app id project.measurements): the first time someone opens Reports on a project, and again
 * from the agent's "Show me the tutorial again". Data only; the runtime plays it. Targets are the report views strip
 * (#rMeasureTabs, drawn by apps/measurements/project.js, sometimes moved into the window header) and its view buttons
 * by `data-tab`. A view the organization can switch off names its capability on its step (the summary,
 * `firstmeasure.measurement_report_summary`; support, `firstmeasure.report_followup`), so where it is off the step is
 * never sent. A view a report does not have yet (the model before it is ready) is not on the page, so its step is
 * skipped.
 */
const t = (key: string, text: string) => ({ key, text });
export const REPORTS_TUTORIAL = "reports.tab_tutorial";
const view = (id: string) => `#rMeasureTabs [data-tab="${id}"]`;

let registered = false;
export function registerReportsGuidedExperiences() {
  if (registered) return;
  registered = true;

  registerExperience({
    id: REPORTS_TUTORIAL, version: 1, kind: "overlay", scope: "person", salt: "2026-10", replayable: true,
    title: t("gx_rt_title", "Reports tour"),
    tab: "project.measurements",
    eligibility: { capabilities: ["apps.firstmeasure"] },
    triggers: [{ kind: "tab_opened", tab: "project.measurements", delay_ms: 900 }],
    variants: [{ id: "tour", weight: 1 }],
    steps: [
      { id: "intro", targets: [], placement: "center", title: t("gx_rt_intro_title", "Welcome to Reports"), body: t("gx_rt_intro_body", "This project's measurement report lives here. Here's a quick look around.") },
      { id: "standard", targets: [view("standard")], title: t("gx_rt_standard_title", "The full report"), body: t("gx_rt_standard_body", "The complete report: every measurement, diagram and page. It shows here as soon as it's ready.") },
      { id: "customer", targets: [view("customer")], title: t("gx_rt_customer_title", "Customer version"), body: t("gx_rt_customer_body", "A shorter version of the report, made to share with the homeowner.") },
      { id: "model", targets: [view("model")], title: t("gx_rt_model_title", "3D model"), body: t("gx_rt_model_body", "Turn the roof around and look at it from any side.") },
      { id: "summary", targets: [view("summary")], eligibility: { capabilities: ["firstmeasure.measurement_report_summary"] }, title: t("gx_rt_summary_title", "Summary"), body: t("gx_rt_summary_body", "The main measurements at a glance. Download them as a spreadsheet with CSV.") },
      { id: "support", targets: [view("changes"), ".r-report-followup-open.visible"], eligibility: { capabilities: ["firstmeasure.report_followup"] }, title: t("gx_rt_support_title", "Support"), body: t("gx_rt_support_body", "Something on the report looks wrong? Ask for a correction here, with notes and photos.") },
      { id: "outro", targets: [], placement: "center", title: t("gx_rt_outro_title", "You're all set"), body: t("gx_rt_outro_body", "Want this tour again? Ask the agent \"Show me the tutorial again\".") }
    ]
  });

  // The tab's other questions live in materials.ts; this adds the replay beside them.
  addTabFaqs({ tab: "project.measurements", questions: [
    { id: "reports.tour", text: t("gx_faq_reports_tour", "Show me the tutorial again"), action: "play", experience: REPORTS_TUTORIAL }
  ] });
}
