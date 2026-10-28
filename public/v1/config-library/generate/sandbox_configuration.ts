import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Generator } from "./index.js";
import "../kinds/capability_values.js";
import { valueCapabilities } from "../../platform/capabilities.js";
import { SANDBOX_CONFIGURATION_KIND } from "../kinds/sandbox_configuration.js";

type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};

/**
 * Every signup sandbox configuration as today's code seeds it: `ensureSeedData` (signup-sandbox/service.ts) runs
 * against an empty sandbox store and each saved workflow becomes an entry. What the code did for one workflow by its
 * id is carried over as that entry's data:
 * - flags that were computed from the registry ("every capability off but these") get the matching
 *   `app_flags_base` and keep only what differs from it;
 * - `swf_channels_only` and `swf_home_improvement` name their onboarding wizard mode;
 * - `swf_mvp_platform` (configurations/mvp-platform.ts) names its terminology, role app options and setup script as
 *   steps: install Generic Roofing from Roof Replacement, make it every new project's scope, turn the other scopes off;
 * - `swf_instant_full_org` names the settings, labels and development seeds createTestInstance added for it.
 */
const BASES: Record<string, "all_off" | "all_on" | "expanded_access_off"> = {
  swf_channels_only: "all_off",
  swf_instant_full_org: "all_on",
  swf_mvp_platform: "expanded_access_off"
};
const ONBOARDING_MODES: Record<string, string> = { swf_channels_only: "channels", swf_home_improvement: "home_improvement" };

function baseFlags(base: string) {
  const values: Json = {};
  for (const node of valueCapabilities()) {
    if (node.type !== "boolean") continue;
    if (base === "all_off") values[node.key] = false;
    if (base === "all_on") values[node.key] = true;
    if (base === "expanded_access_off" && node.requires.includes("platform.expanded_access")) values[node.key] = false;
  }
  return values;
}

async function extras(id: string): Promise<Json> {
  if (id === "swf_mvp_platform") {
    const mvp = await import("../../signup-sandbox/configurations/mvp-platform.js");
    const { DEFAULT_SCOPE_TEMPLATES } = await import("../../scopes/presets/index.js");
    const from = "roof_replacement";
    const base = object(JSON.parse(JSON.stringify(DEFAULT_SCOPE_TEMPLATES.find((definition) => definition.id === from))));
    const template = mvp.genericRoofingTemplate();
    const changed = Object.fromEntries(Object.entries(template).filter(([key, value]) => key !== "id" && JSON.stringify(value) !== JSON.stringify(base[key])));
    return {
      terminology: mvp.TERMINOLOGY,
      role_app_options: mvp.ROLE_APP_OPTIONS,
      setup: [
        { action: "sandbox.scopeTemplate.install", input: { template_id: mvp.GENERIC_ROOFING_TEMPLATE_ID, from, template: changed }, note: "Generic Roofing: a roof job whose board follows the report and the documents." },
        { action: "sandbox.intakeRouting.setDefault", input: { template_id: mvp.GENERIC_ROOFING_TEMPLATE_ID } },
        { action: "sandbox.scopeFlags.only", input: { template_ids: [mvp.GENERIC_ROOFING_TEMPLATE_ID] } }
      ]
    };
  }
  if (id === "swf_instant_full_org") {
    const development = ["development"];
    return {
      settings: { roofing_setup: { template: "roofing", completed: true, services: ["roofing", "gutters", "siding"], job_types: ["roof_replacement", "roof_repair", "gutter_replacement", "siding"], test_document_pack: 1 } },
      terminology: { partners: { partner: "Subcontractor", partners: "Subcontractors" } },
      setup: [
        { action: "sandbox.appointments.seedCatalog", input: {}, data_environments: development },
        { action: "sandbox.roofing.seedDocuments", input: {}, data_environments: development },
        { action: "sandbox.roofing.seedMaterialsLibrary", input: {}, data_environments: development },
        { action: "sandbox.labor.seedPaySheets", input: {}, data_environments: development },
        { action: "sandbox.payroll.seedPayRules", input: {}, data_environments: development },
        { action: "sandbox.people.seedRoofing", input: {}, data_environments: development, on_error: "continue", note: "A roofing company's people: roles, departments, groups, outside companies and pay. Nobody is invited or messaged." },
        { action: "sandbox.communications.completeOnboarding", input: {}, data_environments: development }
      ]
    };
  }
  return {};
}

export const sandboxConfigurationGenerator: Generator = {
  kind: SANDBOX_CONFIGURATION_KIND,
  run: async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "config-library-sandbox-"));
    const previous = process.env.SIGNUP_SANDBOX_STORAGE_ROOT;
    process.env.SIGNUP_SANDBOX_STORAGE_ROOT = root;
    try {
      const { ensureSeedData } = await import("../../signup-sandbox/service.js");
      const { sandboxStore } = await import("../../signup-sandbox/storage.js");
      await ensureSeedData();
      const entries = [];
      for (const workflow of await sandboxStore.listWorkflows()) {
        const id = String(workflow.id);
        const defaults = object(workflow.defaults);
        const base = BASES[id] || "new_organization";
        const start = base === "new_organization" ? {} : baseFlags(base);
        const flags = Object.fromEntries(Object.entries(object(defaults.app_flags)).filter(([key, value]) => !(key in start && start[key] === value)));
        const more = await extras(id);
        entries.push({
          id,
          data: {
            title: workflow.title,
            description: workflow.description,
            entry_mode: workflow.entry_mode,
            onboarding_mode: ONBOARDING_MODES[id] || "",
            stages: (workflow.stages as Json[]).map((stage) => ({ id: stage.id, page_id: stage.page_id, notes: stage.notes })),
            tags: workflow.tags,
            sample_data: workflow.sample_data === true,
            launch_sample_data: workflow.launch_sample_data,
            dev_bar: workflow.dev_bar !== false,
            app_flags_base: base,
            defaults: { app_flags: flags, settings: { ...object(defaults.settings), ...object(more.settings) }, scope_flags: object(defaults.scope_flags) },
            terminology: more.terminology || {},
            role_app_options: more.role_app_options || {},
            setup: more.setup || []
          }
        });
      }
      return entries;
    } finally {
      if (previous === undefined) delete process.env.SIGNUP_SANDBOX_STORAGE_ROOT;
      else process.env.SIGNUP_SANDBOX_STORAGE_ROOT = previous;
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }
};
