import type { HowToEntry } from "../types.js";

// The company setup steps (docs/architecture/setup-steps.md), exercised in tests/setup-steps.test.ts.
export const setCompanyProfile: HowToEntry = {
  id: "set_company_profile",
  title: "Record what kind of company this is and the work it does",
  use_when: "The user says what kind of company they are or what work they do (\"we're a roofer\", \"we also do gutters and siding\"), or asks why a setup asks about their company.",
  keywords: ["company type", "kind of company", "industry", "trade", "services", "kinds of work", "roofer", "contractor", "onboarding", "setup step"],
  steps: [
    {
      title: "Read the lists and what is already saved",
      detail: "platform_read company-profile.catalog on an organization target: company_types (id, label, terms people use, the services offered first) and services (id, label, terms, work_kind, the measurement schema it is measured as). platform_read company-profile.profile for what is saved now: company_type, services, services_other, and answered.type / answered.services.",
      refs: { data: ["company-profile.catalog", "company-profile.profile"] }
    },
    {
      title: "Match the user's words to the lists",
      detail: "Pick the company type whose label or terms match what they said (\"roofer\" is roofing_contractor). If none fits, use company_type \"other\" with company_type_other in their words. Match each kind of work the same way; anything that matches nothing goes in services_other in their words. Ask when two entries could both be meant."
    },
    {
      title: "Save it",
      detail: "platform_invoke company-profile.save on an organization target with only the parts the user gave: { company_type, company_type_other } and/or { services: [ids], services_other: [words] }. Parts not given are kept. services replaces the saved list, so include the services already saved that the user still offers. Needs manage_company_settings.",
      refs: { actions: ["company-profile.save"] }
    },
    {
      title: "Confirm",
      detail: "platform_read setup-steps.status: company.type and company.services read answered: true, so no setup asks them again. Tell the user what was saved in plain words.",
      refs: { data: ["setup-steps.status"] }
    }
  ],
  notes: [
    "The company type sets the organization's industry for setups and suggestions (the roofing price book setup reads it).",
    "The lists only grow: never invent an id. Words that match nothing are kept as the user's own words."
  ]
};
