import { z } from "zod";
import { env } from "../src/config/env.js";
import { libraryEntry, libraryWritable, refreshLibrary } from "../config-library/library.js";
import { saveEntry } from "../config-library/writes.js";
import type { Author, LibraryEntry } from "../config-library/contracts.js";
import { APP_FLAG_BASES, SANDBOX_CONFIGURATION_KIND, sandboxConfigurationSchema, type SandboxConfigurationData } from "../config-library/kinds/sandbox_configuration.js";
import { badRequest, conflict, notFound } from "../platform/errors.js";
import { APP_STATES, applyAppChange, configurationApps } from "./apps.js";
import { ensureSeedData, workflowLibraryState } from "./service.js";
import { sandboxStore } from "./storage.js";

/**
 * The sandbox Apps tab's two calls. A configuration that is a config library entry is read from the entry and saved
 * as a new revision of it (with `expected_revision`, so two editors never overwrite each other); a workflow made in
 * the sandbox and not in the library is shown read-only.
 */

const flagValue = z.union([z.boolean(), z.number().finite(), z.string().max(400)]);
const changeBody = z.object({
  expected_revision: z.number().int().min(1),
  state: z.enum(APP_STATES).optional(),
  features: z.record(z.string().max(160), flagValue.nullable()).optional(),
  options: z.record(z.string().max(80), z.boolean().nullable()).optional(),
  pill: z.string().max(40).optional(),
  placement: z.string().max(40).optional()
}).strict();

async function view(id: string, entry: LibraryEntry<SandboxConfigurationData> | null, data: SandboxConfigurationData) {
  const saved = await sandboxStore.readWorkflow(id);
  return {
    ok: true,
    configuration: {
      id,
      title: data.title,
      source: entry ? "library" : "workflow",
      revision: entry?.revision ?? null,
      updated_at: entry?.updated_at ?? null,
      updated_by: entry?.updated_by ?? null,
      editable: !!entry && libraryWritable(),
      // "changed": the sandbox copy was edited, so launches use that copy until it is reset to the library.
      copy_state: entry ? workflowLibraryState(saved, entry) : null
    },
    // The browser reads the platform session's CSRF cookie by this name; the token itself never passes through here.
    csrf_cookie: `${env.platformSessionCookieName}_csrf`,
    ...(await configurationApps(data))
  };
}

export async function readConfigurationApps(id: string) {
  await refreshLibrary().catch(() => undefined);
  const entry = libraryEntry<SandboxConfigurationData>(SANDBOX_CONFIGURATION_KIND, id);
  if (entry) return view(id, entry, entry.data);
  const workflow = await sandboxStore.readWorkflow(id);
  if (!workflow) throw notFound("workflow_not_found", `Workflow '${id}' not found.`);
  // A sandbox workflow need not be a valid entry (it may have no stages yet): its apps are read from what it sets.
  const parsed = sandboxConfigurationSchema.safeParse(Object.fromEntries(Object.keys(sandboxConfigurationSchema.shape).map((key) => [key, workflow[key] ?? undefined])));
  if (parsed.success) return view(id, null, parsed.data);
  const object = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, never> : {};
  const defaults = object(workflow.defaults);
  return view(id, null, {
    ...(workflow as unknown as SandboxConfigurationData),
    title: String(workflow.title || id),
    app_flags_base: (APP_FLAG_BASES as readonly string[]).includes(String(workflow.app_flags_base)) ? workflow.app_flags_base as SandboxConfigurationData["app_flags_base"] : "new_organization",
    defaults: { app_flags: object(defaults.app_flags), settings: object(defaults.settings), scope_flags: object(defaults.scope_flags) },
    terminology: object(workflow.terminology),
    role_app_options: object(workflow.role_app_options)
  });
}

export async function writeConfigurationApp(id: string, appId: string, body: unknown, author: Author) {
  const parsed = changeBody.safeParse(body ?? {});
  if (!parsed.success) throw badRequest("sandbox_app_change", parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join(" "));
  const change = parsed.data;
  await refreshLibrary().catch(() => undefined);
  const entry = libraryEntry<SandboxConfigurationData>(SANDBOX_CONFIGURATION_KIND, id);
  if (!entry) throw notFound("workflow_not_in_library", `Workflow '${id}' is not a library configuration, so its apps are not edited here.`);
  if (entry.revision !== change.expected_revision) {
    throw conflict("config_library_revision_conflict", `${SANDBOX_CONFIGURATION_KIND}/${id} is at revision ${entry.revision}, not ${change.expected_revision}. Reload and reapply your change.`, { revision: entry.revision });
  }
  const { expected_revision, ...rest } = change;
  const data = await applyAppChange(entry.data, appId, rest);
  const what = [rest.state && `state ${rest.state}`, rest.features && `features ${Object.keys(rest.features).join(", ")}`, rest.options && `options ${Object.keys(rest.options).join(", ")}`,
    rest.pill !== undefined && `pill ${rest.pill || "none"}`, rest.placement !== undefined && `placement ${rest.placement || "default"}`].filter(Boolean).join("; ");
  const saved = await saveEntry({ kind: SANDBOX_CONFIGURATION_KIND, id, data, expected_revision, note: `Sandbox Apps tab: ${appId} ${what}`.slice(0, 2000) }, author);
  // An untouched sandbox copy follows the new revision now, so the next launch uses it.
  await ensureSeedData();
  return { ...(await view(id, saved.entry as LibraryEntry<SandboxConfigurationData>, saved.entry.data as SandboxConfigurationData)), changed: saved.changed };
}
