import { registerExperience } from "../registry.js";
import { checkSetupStepGraph, listSetupSteps, registerSetupStep } from "../setup-steps.js";

/**
 * Global setup steps (docs/architecture/setup-steps.md): questions any setup may require, declared once here. An app's
 * own steps are registered beside its definitions the same way. Each step is also an experience,
 * `setup_step.<id>`, that asks only what is still missing (FirstMateGuides.require in the browser): the main signup
 * or onboarding flow requires a step by playing it, or by naming it in its definition's `requires`.
 */
const t = (key: string, text: string) => ({ key: `gx_step_${key}`, text });
const COMPANY_MODULE = "/libraries/setup-steps/company-profile.js?v=20261027-1";

let registered = false;
export function registerGlobalSetupSteps() {
  if (registered) return;
  registered = true;
  registerSetupStep({
    id: "company.type", version: 1,
    title: t("company_type_title", "What kind of company are you?"),
    subtitle: t("company_type_subtitle", "We use this to suggest the work, materials and setup that fit your business. You can change it later in Settings."),
    description: t("company_type_description", "The kind of company the organization is, such as a roofing contractor. Sets its industry for setups and suggestions."),
    ui: { widget: "module", module: COMPANY_MODULE }, options: { part: "type" },
    eligibility: { permissions: ["manage_company_settings"] },
    satisfied: { provider: "company-profile", export: "profile", path: "/answered/type" },
    writes: { action: "company-profile.save" }
  });
  registerSetupStep({
    id: "company.services", version: 1,
    title: t("company_services_title", "What kind of work do you do?"),
    subtitle: t("company_services_subtitle", "Pick everything you offer. Search for anything that isn't listed."),
    description: t("company_services_description", "The kinds of work the organization does, each linked to its measurement schema where there is one."),
    ui: { widget: "module", module: COMPANY_MODULE }, options: { part: "services" },
    // The services offered first depend on the kind of company, so that is asked first when it is missing.
    requires: ["company.type"],
    eligibility: { permissions: ["manage_company_settings"] },
    satisfied: { provider: "company-profile", export: "profile", path: "/answered/services" },
    writes: { action: "company-profile.save" }
  });
  checkSetupStepGraph();
  for (const step of listSetupSteps()) registerExperience({
    id: `setup_step.${step.id}`, version: step.version, kind: "modal", scope: step.scope, salt: "v1", replayable: true,
    title: step.title, description: step.description,
    eligibility: { capabilities: step.eligibility.capabilities, permissions: step.eligibility.permissions },
    triggers: [{ kind: "manual" }], variants: [{ id: "default", weight: 1 }],
    requires: [step.id], steps: [], completion: { screen: "none" }
  });
}
