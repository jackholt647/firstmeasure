import assert from "node:assert/strict";
import test from "node:test";
import "../platform/capability_defs.js";
import "../chat/capabilities.js";
import "../comms/capabilities.js";
import { capabilityDefinitions } from "../platform/capabilities.js";
import { hasPermission } from "../platform/auth.js";
import { initializePublication } from "../platform/publication/bootstrap.js";
import { listActions } from "../platform/publication/actions.js";
import { listDataProviders } from "../platform/publication/providers.js";
import { publishedActionPermission, publishedDataPermission, publishedPermissionBundles } from "../platform/publication/permission-bundles.js";

test("every built-in published operation belongs to one known business permission or explicit subject grant", () => {
  initializePublication();
  const actions = listActions().filter(action => action.executionKinds.includes("api"));
  const data = listDataProviders().flatMap(provider => Object.keys(provider.exports).map(name => `${provider.id}.${name}`));
  const actionIds = new Set(actions.map(action => action.id));
  const dataIds = new Set(data);
  assert.ok(actions.length >= 80);
  assert.ok(data.length >= 33);
  for (const action of actions) {
    assert.notEqual(publishedActionPermission(action.id), undefined, action.id);
    assert.ok(action.executionKinds.includes("agent"), `Agent runtime cannot invoke ${action.id}.`);
  }
  for (const id of data) assert.notEqual(publishedDataPermission(id), undefined, id);
  const permissionKeys = new Set(capabilityDefinitions().filter(node => node.kind === "permission").map(node => node.permission_key));
  for (const [permission, bundle] of Object.entries(publishedPermissionBundles())) {
    if (permission) assert.ok(permissionKeys.has(permission), `Permission ${permission} is absent from the role UI catalog.`);
    for (const id of bundle.actions || []) assert.ok(actionIds.has(id), `Action ${id} is not registered.`);
    for (const id of bundle.data || []) assert.ok(dataIds.has(id), `Data export ${id} is not registered.`);
  }
});

test("FirstMeasure's seven production keys retain legacy role behavior while expanded roles honor explicit denial", () => {
  const legacy = ["order_reports", "view_reports", "manage_billing", "manage_company_settings", "manage_report_settings", "manage_company_users", "manage_company_user_permissions"];
  const permissionKeys = new Set(capabilityDefinitions().filter(node => node.kind === "permission").map(node => node.permission_key));
  for (const key of legacy) assert.ok(permissionKeys.has(key), key);
  const admin = { role: "admin", permissions: {}, accessProfile: undefined } as any;
  for (const key of legacy) assert.equal(hasPermission(admin, key), true, key);
  const expanded = { role: "admin", permissions: { "*": true, manage_billing: false }, accessProfile: {} } as any;
  assert.equal(hasPermission(expanded, "manage_billing"), false);
  assert.equal(hasPermission(expanded, "view_reports"), true);
});
