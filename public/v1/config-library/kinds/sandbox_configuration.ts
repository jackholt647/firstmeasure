import { z } from "zod";
import type { LibraryKind } from "../contracts.js";
import { describeAction } from "../../platform/publication/actions.js";
import { validateJson } from "../../platform/publication/validation.js";
import { appDefinition } from "../../platform/app-experience/registry.js";
import { APP_OFFERS } from "../../platform/app-experience/offers.js";
import { capabilityValuesErrors, capabilityValueSchema, CAPABILITY_KEY } from "./capability_values.js";

/**
 * A signup sandbox configuration (docs/architecture/config-library.md, docs/signup-sandbox-spec.md): one workflow a
 * test organization is created from, as data. It holds the workflow itself (stages naming signup pages, entry mode,
 * sample data, the test-run bar), the organization's starting state (app flags over a computed base, settings by
 * dot path, scope flags), terminology labels and role app options it writes without overwriting what is set, and an
 * ordered list of setup steps, each a published action (signup-sandbox/setup-actions.ts and any other) with its
 * input, run as the new organization's owner. The sandbox copies an entry into its saved workflow; a newer library
 * revision replaces a saved workflow nobody edited, and one edited in the sandbox stays as it is.
 *
 * Nothing in the platform checks which configuration an organization came from.
 */
export const SANDBOX_CONFIGURATION_KIND = "sandbox_configuration";
export const SAMPLE_DATA_KINDS = ["equipment", "channels", "projects", "customers"] as const;
/**
 * Where a configuration's app flags start before its own are laid over (the rest of the registry, computed when the
 * organization is made): `new_organization` (what public signup gives), `all_off` (every on/off capability off),
 * `all_on` (every on/off capability on) or `expanded_access_off` (signup, with every on/off capability that needs
 * expanded platform access off).
 */
export const APP_FLAG_BASES = ["new_organization", "all_off", "all_on", "expanded_access_off"] as const;
export const USER_CHOICE = "$user";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const json: z.ZodType<Json> = z.lazy(() => z.union([z.null(), z.boolean(), z.number().finite(), z.string().max(20000), z.array(json).max(500), z.record(json)]));
const sandboxId = z.string().regex(/^[A-Za-z0-9_-]{3,80}$/, "Ids are 3 to 80 letters, digits, _ or -.");
const name = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,119}$/);

const stage = z.object({ id: sandboxId, page_id: sandboxId, notes: z.string().max(4000).default("") }).strict();
const setupStep = z.object({
  action: z.string().regex(/^[a-z][A-Za-z0-9_.-]{2,159}$/),
  version: z.string().max(40).optional(),
  input: z.record(json).default({}),
  /** Only in these data environments (the instant org's sample seeds are development data). Omitted: everywhere. */
  data_environments: z.array(z.enum(["development", "production", "test"])).min(1).optional(),
  /** `continue`: a failure is logged and the next step runs. */
  on_error: z.enum(["stop", "continue"]).default("stop"),
  note: z.string().max(2000).optional()
}).strict();

export const sandboxConfigurationSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000).default(""),
  entry_mode: z.enum(["landing_first", "signup_first"]),
  /** The onboarding wizard's product mode for builtin wizard stages (`onboardingMode=`); empty for the standard one. */
  onboarding_mode: z.string().regex(/^[a-z_]{0,40}$/).default(""),
  stages: z.array(stage).min(1).max(40),
  tags: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  sample_data: z.boolean().default(false),
  launch_sample_data: z.array(z.enum(SAMPLE_DATA_KINDS)).default([]),
  dev_bar: z.boolean().default(true),
  app_flags_base: z.enum(APP_FLAG_BASES).default("new_organization"),
  defaults: z.object({
    app_flags: z.record(z.string().regex(CAPABILITY_KEY), capabilityValueSchema).default({}),
    settings: z.record(z.string().regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/), json).default({}),
    scope_flags: z.record(name, z.union([z.boolean(), z.literal(USER_CHOICE)])).default({})
  }).strict().default({}),
  /** Terminology labels, `{namespace: {key: label}}`, written where the organization has none. */
  terminology: z.record(name, z.record(name, z.string().trim().min(1).max(120))).default({}),
  /** App options every active role gets, `{app id: {option: value}}`, where the role sets none. */
  role_app_options: z.record(name, z.record(name, z.boolean())).default({}),
  setup: z.array(setupStep).max(40).default([])
}).strict();

export type SandboxConfigurationData = z.infer<typeof sandboxConfigurationSchema>;

const MONEY_SETTINGS = new Set(["credits_balance", "credits_ledger", "billing"]);
function settingErrors(settings: Record<string, unknown>) {
  const errors: string[] = [];
  const offers = settings.app_offers;
  if (offers !== undefined && offers !== USER_CHOICE) {
    if (!Array.isArray(offers)) errors.push("defaults.settings.app_offers: a list of offered app ids.");
    else for (const id of offers) if (!Object.prototype.hasOwnProperty.call(APP_OFFERS, String(id))) errors.push(`defaults.settings.app_offers: ${String(id)} is not an app that can be offered.`);
  }
  // A page may let the person choose them ("$user"); a configuration never sets an organization's money.
  for (const [path, value] of Object.entries(settings)) {
    if (MONEY_SETTINGS.has(path.split(".")[0]!) && value !== USER_CHOICE) errors.push(`defaults.settings.${path}: a configuration never sets an organization's money.`);
  }
  return errors;
}

export const sandboxConfigurationKind: LibraryKind<SandboxConfigurationData> = {
  kind: SANDBOX_CONFIGURATION_KIND,
  title: "Sandbox configurations",
  description: "Signup sandbox workflows test organizations are created from: stages, starting flags and settings, terminology, role app options and setup steps.",
  idPattern: /^[a-z0-9][a-z0-9_-]{2,79}$/,
  // Parsing fills defaults, so what is read is the parsed type.
  schema: sandboxConfigurationSchema as unknown as z.ZodType<SandboxConfigurationData>,
  validate: (data, ctx) => {
    const errors = [
      ...capabilityValuesErrors(data.defaults.app_flags, "defaults.app_flags", { allowUserChoice: true }),
      ...settingErrors(data.defaults.settings),
      ...(data.launch_sample_data.length && !data.sample_data ? ["launch_sample_data: only a configuration that offers sample data launches with it."] : [])
    ];
    const stageIds = data.stages.map((entry) => entry.id);
    if (new Set(stageIds).size !== stageIds.length) errors.push("stages: every stage id is different.");
    for (const [appId, options] of Object.entries(data.role_app_options)) {
      const app = appDefinition(appId);
      if (!app) { errors.push(`role_app_options.${appId}: there is no app ${appId}.`); continue; }
      const declared = new Set(app.options.map((option) => option.key));
      for (const option of Object.keys(options)) if (!declared.has(option)) errors.push(`role_app_options.${appId}.${option}: ${appId} has no option ${option}.`);
    }
    data.setup.forEach((step, index) => {
      const at = `setup.${index}`;
      if (!ctx.registries.action(step.action, step.version)) { errors.push(`${at}.action: there is no published action ${step.action}${step.version ? `@${step.version}` : ""}.`); return; }
      const description = describeAction(step.action, step.version);
      if (description && description.effect === "external") errors.push(`${at}.action: ${step.action} reaches outside the platform; a sandbox setup step never does.`);
    });
    return errors;
  },
  titleOf: (data) => data.title
};

/**
 * The deeper, on-demand check (not run on save, which stays millisecond-cheap): every setup step's input against
 * its action's declared input schema. Each schema is compiled, so it costs more than a save may.
 */
export function deepCheckSandboxConfiguration(data: SandboxConfigurationData): string[] {
  const errors: string[] = [];
  data.setup.forEach((step, index) => {
    const at = `setup.${index}`;
    const description = describeAction(step.action, step.version);
    if (!description) { errors.push(`${at}.action: there is no published action ${step.action}.`); return; }
    try { validateJson(description.inputSchema, step.input, `${at}.input`); }
    catch (error) {
      const details = (error as { details?: unknown }).details;
      const listed = Array.isArray(details) ? details.map((detail: { path?: string; message?: string }) => `${detail.path || "/"} ${detail.message || ""}`.trim()).join("; ") : "";
      errors.push(`${at}.input: ${listed || (error as Error).message}`);
    }
  });
  return errors;
}
