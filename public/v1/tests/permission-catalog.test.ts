// The permission catalog: every permission key the platform uses has a node with
// a label, a one-line description, a category and a subcategory.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import "../platform/capability_defs.js";
import "../chat/capabilities.js";
import "../comms/capabilities.js";
import "../assistant/capabilities.js";
import { capabilityDefinition, permissionCapabilities, permissionCatalog } from "../platform/capabilities.js";
import { PERMISSION_CATEGORIES, WILDCARD_PERMISSION, permissionSubcategory } from "../platform/permission_categories.js";
import { CREW_PERMISSION_KEYS, SALES_PERMISSION_KEYS, accessCatalog, factoryPersonaDefinitions } from "../workforce/access.js";
import { publishedPermissionBundles } from "../platform/publication/permission-bundles.js";

const root = path.resolve(import.meta.dirname, "..");
const PRODUCTION_FLAGS = ["order_reports", "view_reports", "manage_billing", "manage_company_settings", "manage_report_settings", "manage_company_users", "manage_company_user_permissions"];

const KEY = String.raw`[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*`;
const LITERAL = new RegExp(String.raw`["'\x60](${KEY}(?:\|${KEY})*)["'\x60]`, "g");
const literals = (source: string) => [...source.matchAll(LITERAL)].map((match) => match[1]!);
const split = (value: string) => value.split("|").map((part) => part.trim()).filter(Boolean);

function sourceFiles(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    if (["node_modules", "dist", "tests", ".git", "storage", "data", "scripts"].includes(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|mts)$/.test(name) && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/**
 * Permission keys named by the checks in the backend source: a `permission:`
 * option (requirePlatformAuth, agent tools, publication policies, notification
 * definitions), a `permissions: [...]` list, a `*_PERMISSION = "..."` constant,
 * the direct arguments of any `...Permission(...)` check helper (hasPermission,
 * requirePermission, hasResourcePermission, canUseScopedPermission, ...), the
 * collaboration `auth(req, "...")` and field `requireCrewActor(..., "...")`
 * gates, and any piped `a|b` alternative list.
 */
function scannedPermissionKeys() {
  const found = new Map<string, Set<string>>();
  const add = (value: string, file: string) => split(value).forEach((key) => {
    if (!found.has(key)) found.set(key, new Set());
    found.get(key)!.add(path.relative(root, file).replaceAll("\\", "/"));
  });
  const LIT = String.raw`["'\x60](${KEY}(?:\|${KEY})*)["'\x60]`;
  const direct = [
    new RegExp(String.raw`\bpermission\s*:\s*` + LIT, "g"),
    new RegExp(String.raw`\b[A-Z_]*PERMISSION[A-Z_]*\s*=\s*` + LIT, "g"),
    new RegExp(String.raw`\bauth\(\s*req\s*,\s*` + LIT, "g"),
    new RegExp(String.raw`["'\x60](${KEY}_${KEY}(?:\|${KEY})+)["'\x60]`, "g")
  ];
  for (const file of sourceFiles(root)) {
    const source = readFileSync(file, "utf8");
    for (const pattern of direct) for (const match of source.matchAll(pattern)) add(match[1]!, file);
    for (const match of source.matchAll(/\bpermissions\s*:\s*\[([^\]]*)\]/g)) literals(match[1]!).filter((value) => /[_.|]/.test(value)).forEach((value) => add(value, file));
    for (const match of source.matchAll(/\b(\w*[Pp]ermission\w*|requireCrewActor)\s*\(([^()]*)/g)) {
      if (/^collection(Read|Write)Permission$|^normalize|^notificationAccessPermissions$/.test(match[1]!)) continue;
      literals(match[2]!).filter((value) => /[_.|]/.test(value)).forEach((value) => add(value, file));
    }
  }
  return found;
}

function everyPermissionKey() {
  const keys = new Map<string, Set<string>>();
  const add = (key: string, source: string) => split(key).forEach((part) => {
    if (!keys.has(part)) keys.set(part, new Set());
    keys.get(part)!.add(source);
  });
  Object.values(CREW_PERMISSION_KEYS).forEach((key) => add(key, "CREW_PERMISSION_KEYS"));
  Object.values(SALES_PERMISSION_KEYS).forEach((key) => add(key, "SALES_PERMISSION_KEYS"));
  factoryPersonaDefinitions().forEach((persona) => Object.keys(persona.permissions).forEach((key) => add(key, `persona ${persona.id}`)));
  accessCatalog().forEach((entry) => {
    entry.required_permissions.forEach((key) => add(key, `app ${entry.id} required_permissions`));
    Object.values(entry.parameter_permissions).forEach((key) => add(key, `app ${entry.id} parameter_permissions`));
  });
  Object.keys(publishedPermissionBundles()).forEach((key) => add(key, "permission-bundles.ts"));
  for (const [key, files] of scannedPermissionKeys()) files.forEach((file) => add(key, file));
  return keys;
}

test("every permission key used anywhere has a catalog node with a category and a subcategory", () => {
  const nodes = new Map(permissionCapabilities().map((node) => [node.permission_key, node]));
  const keys = everyPermissionKey();
  // Shape guard: the scan must keep finding the checks it is meant to find.
  for (const known of ["view_feed", "crew.workflows.add", "manage_partner_payments", "manage_users", "admin", "equipment.service", "view_call_recordings"]) {
    assert.ok(keys.has(known), `the inventory no longer finds ${known}; update the scan patterns`);
  }
  const missing = [...keys.entries()].filter(([key]) => key !== WILDCARD_PERMISSION.key && !nodes.has(key)).map(([key, sources]) => `${key} (${[...sources].slice(0, 3).join(", ")})`);
  assert.deepEqual(missing, [], "add a permission node in platform/capability_defs.ts for each of these");
  for (const node of nodes.values()) {
    assert.ok(node.permission_group, `${node.permission_key} names no permission_group`);
    const placement = permissionSubcategory(node.permission_group);
    assert.ok(placement, `${node.permission_key} names unknown group ${node.permission_group}`);
    assert.equal(node.permission_category, placement!.category.id);
  }
});

test("permission labels are titles and descriptions are one line, without fixed group words", () => {
  for (const node of permissionCapabilities()) {
    assert.ok(node.label && node.label !== node.permission_key, `${node.permission_key} needs a human label`);
    assert.ok(node.label.length <= 40, `${node.permission_key}: keep the label a short title`);
    assert.doesNotMatch(node.label, /crew/i, `${node.permission_key}: say field or assignee, not crew`);
    assert.doesNotMatch(node.description, /crew/i, `${node.permission_key}: say field or assignee, not crew`);
    assert.ok(node.description && node.description !== node.label, `${node.permission_key} needs a one-line description`);
    assert.doesNotMatch(node.description, /\n/, `${node.permission_key}: one line`);
  }
});

test("the seven FirstMeasure production permissions keep their keys and are categorized", () => {
  for (const key of PRODUCTION_FLAGS) {
    const node = permissionCapabilities().find((entry) => entry.permission_key === key);
    assert.ok(node, `${key} has a node`);
    assert.equal(node!.key, `permission.${key}`);
    assert.ok(node!.permission_category && node!.permission_group);
  }
});

test("categories read as a contractor's office would group them, each with subcategories", () => {
  assert.ok(PERMISSION_CATEGORIES.length >= 8 && PERMISSION_CATEGORIES.length <= 12, "roughly eight to twelve categories");
  const used = new Set(permissionCapabilities().map((node) => node.permission_group));
  for (const category of PERMISSION_CATEGORIES) {
    assert.doesNotMatch(category.label, /crew/i);
    assert.ok(category.subcategories.length >= 1, `${category.id} has subcategories`);
    for (const subcategory of category.subcategories) {
      assert.doesNotMatch(subcategory.label, /crew/i);
      assert.ok(subcategory.id === WILDCARD_PERMISSION.group || used.has(subcategory.id), `${subcategory.id} is empty`);
      if (subcategory.capability) assert.ok(capabilityDefinition(subcategory.capability), `${subcategory.id} names unknown capability ${subcategory.capability}`);
    }
  }
});

test("the published catalog lists every permission once under its category and subcategory, and marks what is off", () => {
  const catalog = permissionCatalog();
  const listed = catalog.categories.flatMap((category) => category.subcategories.flatMap((sub) => sub.permissions.map((entry) => ({ ...entry, category: category.id, sub: sub.id }))));
  assert.equal(listed[0]!.key, "*", "Everything comes first");
  assert.equal(listed[0]!.sub, "full_access");
  const keys = listed.map((entry) => entry.key);
  assert.equal(new Set(keys).size, keys.length, "no permission is listed twice");
  assert.deepEqual(keys.filter((key) => key !== "*").sort(), permissionCapabilities().map((node) => node.permission_key).sort());
  const timeClock = listed.find((entry) => entry.key === "crew.time_clock.use")!;
  assert.deepEqual([timeClock.category, timeClock.sub, timeClock.label], ["field", "time_expenses", "Use the time clock"]);
  assert.equal(listed.find((entry) => entry.key === "manage_payroll")!.category, "money");
  assert.equal(listed.find((entry) => entry.key === "sales.followups.manage")!.sub, "sales_app");
  for (const category of catalog.categories) for (const sub of category.subcategories) {
    const access = sub.permissions.filter((entry) => entry.key !== "*").map((entry) => entry.access);
    assert.deepEqual(access, [...access].sort((left, right) => (left === "read" ? 0 : 1) - (right === "read" ? 0 : 1)), `${sub.id}: reads before writes`);
  }
  assert.equal(listed[1]!.available, undefined, "availability is only marked when resolved");
  const resolved = permissionCatalog({ "permission.equipment_view": false, "permission.view_projects": true });
  const flat = resolved.categories.flatMap((category) => category.subcategories.flatMap((sub) => sub.permissions));
  assert.equal(flat.find((entry) => entry.key === "equipment.view")!.available, false);
  assert.equal(flat.find((entry) => entry.key === "view_projects")!.available, true);
  assert.equal(flat.find((entry) => entry.key === "*")!.available, true);
  assert.equal(resolved.other.id, "other");
});
