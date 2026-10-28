import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Terminology defaults are config library entries (kind terminology_namespace): the server contract is built from
// them, an edit on dev reaches it without a rollout, keys and namespaces are never removed, and an organization's
// variable_mappings keep overrides only.
const dir = await mkdtemp(path.join(os.tmpdir(), "terminology-library-"));
Object.assign(process.env, {
  NODE_ENV: "test", FIRSTMEASURE_DATA_ENVIRONMENT: "development", CONFIG_LIBRARY_SOURCE: "store",
  PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"),
  FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "index.sqlite"), INTERNAL_STORAGE_ROOT: path.join(dir, "internal"), PLATFORM_HEARTBEAT_DISABLED: "1", V1_LOG_LEVEL: "error"
});
after(async () => {
  (await import("../config-library/library.js")).stopLibrarySync();
  const { closeSqlStores } = await import("../platform/sql_store.js");
  await closeSqlStores();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});
const agent = { kind: "agent" as const, id: "test-agent" };

test("the server contract is the library's terminology namespaces, in order, and follows an edit", async () => {
  const { registerAllLibraryKinds } = await import("../config-library/kinds/index.js");
  registerAllLibraryKinds();
  const { startLibrarySync, libraryEntry, libraryEntries } = await import("../config-library/library.js");
  await startLibrarySync();
  const { terminologyContract } = await import("../platform/localization/terminology-defaults.js");
  const { canonicalTerm } = await import("../platform/localization/terminology.js");
  const contract = terminologyContract();
  const keys = Object.keys(contract);
  assert.ok(libraryEntries("terminology_namespace").length >= 46);
  assert.equal(keys[0], "partners.partner", "the first namespace by position comes first");
  assert.deepEqual(contract["projects.project"], { label: "Project", kind: "entity" });
  assert.equal(contract["scope.project_tab"]?.label, "Operations");
  assert.equal(contract["money.project_tab"]?.label, "Financials");
  assert.ok(contract["event_types.equipment_booking"], "scheduling's event type labels are terms");
  assert.equal(canonicalTerm("crew.crew_member"), "workforce.worker_singular");

  const { saveEntry } = await import("../config-library/writes.js");
  const projects = structuredClone(libraryEntry<any>("terminology_namespace", "projects")!);
  projects.data.terms.find((item: any) => item.key === "project").label = "Job";
  await saveEntry({ kind: "terminology_namespace", id: "projects", data: projects.data, expected_revision: projects.revision }, agent);
  assert.equal(terminologyContract()["projects.project"]?.label, "Job", "the next read sees the edit");
  projects.data.terms.find((item: any) => item.key === "project").label = "Project";
  await saveEntry({ kind: "terminology_namespace", id: "projects", data: projects.data }, agent);
  assert.equal(terminologyContract()["projects.project"]?.label, "Project");
});

test("a namespace keeps every term key and kind; labels may change and terms may be added", async () => {
  const { checkEntry, deleteEntry } = await import("../config-library/writes.js");
  const { libraryEntry } = await import("../config-library/library.js");
  const previous = libraryEntry<any>("terminology_namespace", "projects")!;
  const data = structuredClone(previous.data);
  const errorsOf = (next: unknown) => checkEntry("terminology_namespace", "projects", next, previous).errors;

  assert.deepEqual(errorsOf({ ...data, terms: [...data.terms, { key: "job_site", label: "Job site", kind: "entity" }] }), []);
  assert.deepEqual(errorsOf({ ...data, terms: data.terms.map((item: any) => item.key === "project" ? { ...item, label: "Job" } : item) }), []);
  assert.match(errorsOf({ ...data, terms: data.terms.filter((item: any) => item.key !== "project") }).join(" "), /projects\.project cannot be removed/);
  assert.match(errorsOf({ ...data, terms: data.terms.map((item: any) => item.key === "project" ? { ...item, kind: "navigation" } : item) }).join(" "), /stays one/);
  assert.match(errorsOf({ ...data, terms: [...data.terms, data.terms[0]] }).join(" "), /listed twice/);
  assert.ok(errorsOf({ ...data, terms: data.terms.map((item: any) => item.key === "project" ? { ...item, label: "  " } : item) }).length);
  assert.ok(errorsOf({ ...data, terms: [...data.terms, { key: "x", label: "X", kind: "noun" }] }).length);
  assert.ok(checkEntry("terminology_namespace", "Bad-Id", data, null).errors.length);
  await assert.rejects(deleteEntry({ kind: "terminology_namespace", id: "projects" }, agent), /append-only|never removed/);
});

test("an organization's variable_mappings store overrides only; reads return overrides only", async () => {
  const s = await import("../platform/storage.js");
  const ORG = "org_terminology_overrides";
  await s.createOrganization({ id: ORG, name: ORG });
  await s.saveBranchModule(ORG, "default", "variable_mappings", { data: { labels: { projects: { project: "Project", projects: "Jobs" }, money: { workspace: "Money" }, event_types: { custom_visit: "Custom Visit" } }, localized_labels: { "en-US": { projects: { project: "" } } } } });
  const stored = (await s.readBranchModule(ORG, "default", "variable_mappings")).data as any;
  assert.deepEqual(stored.labels, { projects: { projects: "Jobs" }, event_types: { custom_visit: "Custom Visit" } });
  assert.deepEqual(stored.localized_labels, { "en-US": { projects: { project: "" } } }, "an explicit reset is kept");
  const { readTerminologyMappings } = await import("../platform/localization/terminology-settings.js");
  const read = await readTerminologyMappings(ORG, "default");
  assert.equal(read.labels?.projects?.projects, "Jobs");
  assert.equal(read.labels?.projects?.project, undefined);
});
