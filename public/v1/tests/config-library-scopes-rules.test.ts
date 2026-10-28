import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// The scope library, form templates and default organization rules are config library entries
// (config-library/kinds/scope_template.ts, form_template.ts, automation_rule_default.ts). An organization's untouched
// scope copy follows the library; an edited one never does until reset. Default rules are read live, and a
// read-modify-save caller does not freeze them into the organization's rules.
const root = await mkdtemp(path.join(os.tmpdir(), "config-library-scopes-"));
Object.assign(process.env, { FIRSTMATE_ENV: "test", NODE_ENV: "test", CONFIG_LIBRARY_SOURCE: "snapshot", PLATFORM_STORAGE_ROOT: root, FIRSTMEASURE_DATABASE_MODE: "local", PLATFORM_HEARTBEAT_DISABLED: "1" });
const library = await import("../config-library/library.js");
const { contentHash } = await import("../config-library/canonical.js");
const scopes = await import("../scopes/storage.js");
const store = await import("../work/storage.js");
after(async () => {
  library.resetLibraryForTests();
  await store.closeWorkDatabase();
  await (await import("../platform/sql_store.js")).closeSqlStoresForTests();
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

/** Another revision of an entry, as a library edit on dev would make it. */
function editEntry(kind: string, id: string, change: (data: any) => void) {
  const current = library.libraryEntry(kind, id)!;
  const data = structuredClone(current.data) as any;
  change(data);
  library.applyLibraryChange({ ...current, data, revision: current.revision + 1, sha256: contentHash(data) });
  return library.libraryEntry(kind, id)!;
}
const getWorkDatabaseForLegacy = () => store.getWorkDatabase();
const states = async (org: string) => Object.fromEntries((await scopes.scopeLibraryCopyStatus(org)).map((status) => [status.id, status.state]));

test("scope library: copies are stamped, untouched ones follow the library, edited ones wait for a reset", async () => {
  const { scopeTemplateKind } = await import("../config-library/kinds/scope_template.js");
  const org = `scopes_${randomUUID()}`;
  const templates = await scopes.listScopeTemplates(org, "default", { include_disabled: true });
  const defaults = (await import("../scopes/library.js")).defaultScopeLibraryEntries();
  assert.deepEqual(templates.map((template) => template.id), defaults.map((entry) => entry.id), "every default, in library order");
  assert.ok(!templates.some((template) => template.id === "insurance_roof_sale"), "industry scopes are not installed in every organization");
  const roof = templates.find((template) => template.id === "roof_replacement")!;
  assert.equal((roof.definition as any).metadata.preset, true);
  assert.equal((roof.definition as any).metadata.library_stamp.sha256, library.libraryEntry("scope_template", "roof_replacement")!.sha256);
  let status = await states(org);
  assert.equal(status.roof_replacement, "library");
  assert.equal(status.insurance_roof_sale, "missing");

  // The organization edits Gutters; the library then changes Repairs and Gutters.
  const gutters = templates.find((template) => template.id === "gutters")!;
  await scopes.saveScopeTemplate(org, "default", { ...(gutters.definition as any), name: "Our gutters", expected_version: gutters.version });
  const repairsEntry = editEntry("scope_template", "repairs", (data) => { data.details = "Updated in the library."; });
  editEntry("scope_template", "gutters", (data) => { data.details = "Updated in the library."; });
  status = await states(org);
  assert.equal(status.repairs, "behind");
  assert.equal(status.gutters, "changed");

  const after = await scopes.listScopeTemplates(org, "default", { include_disabled: true });
  const repairs = after.find((template) => template.id === "repairs")!;
  assert.equal(repairs.details, "Updated in the library.", "an untouched copy upgrades");
  assert.equal((repairs.definition as any).metadata.library_stamp.revision, repairsEntry.revision);
  const edited = after.find((template) => template.id === "gutters")!;
  assert.equal(edited.name, "Our gutters", "an edited copy is never touched");
  assert.equal((edited.definition as any).metadata.preset, false);
  status = await states(org);
  assert.equal(status.repairs, "library");
  assert.equal(status.gutters, "changed");

  // Reset puts the edited copy back to the current entry, untouched again.
  const ctx = { orgId: org, branchId: "default" } as any;
  await scopeTemplateKind.orgCopies!.reset(ctx, "gutters");
  const reset = await scopes.readScopeTemplate(org, "default", "gutters") as any;
  assert.equal(reset.name, "Gutters");
  assert.equal(reset.details, "Updated in the library.");
  assert.equal((await scopeTemplateKind.orgCopies!.status(org, ["gutters"]))[0]!.state, "library");
});

test("scope library: a copy made before the library upgrades once, and industry scopes install from it", async () => {
  const org = String((await (await import("../platform/storage.js")).createOrganization({ name: "Legacy" })).id);
  await scopes.ensureDefaultScopeTemplates(org);
  const manual = await scopes.readScopeTemplate(org, "default", "manual");
  // What a pre-library preset looked like: preset with a revision number and no stamp.
  const { library_stamp: _stamp, ...legacyMetadata } = (manual.definition as any).metadata;
  await getWorkDatabaseForLegacy().prepare("UPDATE scope_templates SET metadata_json=? WHERE organization_id=? AND branch_id='default' AND id='manual'")
    .run(JSON.stringify({ ...legacyMetadata, preset_revision: 13 }), org);
  const legacy = (await scopes.scopeLibraryCopyStatus(org, "default", ["manual"]))[0]!;
  assert.equal(legacy.state, "behind");
  assert.match(String(legacy.detail), /before the scope library/);
  await scopes.listScopeTemplates(org);
  assert.equal((await states(org)).manual, "library");
  assert.equal((await scopes.readScopeTemplate(org, "default", "manual")).version, Number(manual.version) + 1, "upgraded once");

  const { applyCrmPreset } = await import("../crm/presets.js");
  const added = await applyCrmPreset(org, { industry: "roofing" as any });
  assert.ok((added.scopes as string[]).includes("insurance_roof_sale"));
  const installed = await scopes.readScopeTemplate(org, "default", "insurance_roof_sale");
  assert.equal((installed.definition as any).metadata.industry_preset, "roofing");
  assert.equal((await states(org)).insurance_roof_sale, "library");
  assert.ok(!(await scopes.listScopeLibrary(org)).some((item) => item.id === "insurance_roof_sale"), "the scope library list shows the defaults only");
});

test("default rules: read live, never frozen by a read-modify-save, an edit is kept", async () => {
  const rules = await import("../work/rules.js");
  const org = String((await (await import("../platform/storage.js")).createOrganization({ name: "Rules" })).id);
  const read = await rules.readAutomationRules(org);
  const ids = library.libraryEntries("automation_rule_default").map((entry) => entry.id);
  assert.deepEqual(read.rules.map((rule) => rule.id).sort(), [...ids].sort());
  assert.ok(read.rules.every((rule) => typeof rule[rules.LIBRARY_DEFAULT_MARKER] === "string"));

  // A caller that adds its own rule and writes everything back, as CRM routing and contact rules do.
  const custom = { id: "custom_rule", enabled: true, title: "Custom", event: "lead.received", automation: "notification.create.v1", input: { title: "x" } };
  const saved = await rules.saveAutomationRules(org, "default", { expected_revision: read.revision, rules: [...read.rules, custom] });
  const { readBranchModule } = await import("../platform/storage.js");
  const stored = (await readBranchModule(org, "default", rules.AUTOMATION_RULES_MODULE_ID)).data as any;
  assert.deepEqual(stored.rules.map((rule: any) => rule.id), ["custom_rule"], "unchanged defaults are not stored");
  assert.equal(saved.rules.length, ids.length + 1, "the save answers with what the organization runs");

  // A caller that drops the marker but sends a default unchanged: still not stored. Switching one off is kept.
  const plain = (await rules.readAutomationRules(org)).rules.map(({ [rules.LIBRARY_DEFAULT_MARKER]: _marker, ...rule }) => rule);
  const off = plain.map((rule) => (rule.id === "platform_queue_new_lead_calls" ? { ...rule, enabled: false } : rule));
  await rules.saveAutomationRules(org, "default", { rules: off });
  const storedNow = ((await readBranchModule(org, "default", rules.AUTOMATION_RULES_MODULE_ID)).data as any).rules.map((rule: any) => rule.id).sort();
  assert.deepEqual(storedNow, ["custom_rule", "platform_queue_new_lead_calls"]);

  // The library changes a default: an organization that has not changed it gets the new version at once.
  editEntry("automation_rule_default", "platform_notify_new_lead", (data) => { data.title = "Tell sales about a new lead"; });
  const live = (await rules.readAutomationRules(org)).rules;
  assert.equal(live.find((rule) => rule.id === "platform_notify_new_lead")!.title, "Tell sales about a new lead");
  assert.equal(live.find((rule) => rule.id === "platform_queue_new_lead_calls")!.enabled, false, "the organization's own version wins");
});

test("form templates come from the library in picker order", async () => {
  const forms = await import("../forms/templates.js");
  const listed = forms.listFormTemplates();
  assert.deepEqual(listed.map((template) => template.id), ["blank", "contact", "call_in_lead", "service_request", "appointment", "estimate", "roofing_instant_estimate"]);
  assert.equal(forms.formTemplate("roofing_instant_estimate")!.industry, "roofing");
  const definition = forms.buildTemplateDefinition("appointment");
  definition.presentation.headline = "Changed";
  assert.notEqual(forms.buildTemplateDefinition("appointment").presentation.headline, "Changed", "each form gets its own copy");
  assert.equal(forms.buildTemplateDefinition("no_such_template").template, "blank");
});
