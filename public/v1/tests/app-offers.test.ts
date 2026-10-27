import assert from "node:assert/strict";
import test from "node:test";
import { maskOfferedCapabilities, offeredAppIds } from "../platform/app-experience/offers.js";
import { resolveCapabilities } from "../platform/capabilities.js";
import "../platform/capability_defs.js";
import { resolveAppEntitlements } from "../workforce/access.js";
import { hasAppAccess, hasAppEntitlement, type PlatformAuthContext } from "../platform/auth.js";
import { containsAppFlagMutation } from '../platform/app_flags.js';

test("offers mask the operational capabilities and their dependent features", () => {
  const configured = { "platform.expanded_access": true, "platform.project_photos": true, "platform.photos_feed": true,
    "platform.customer_portal": true, "platform.customer_portal_media": true };
  const masked = maskOfferedCapabilities(configured, ["project.photos", "project.customer_portal"]);
  const resolved = resolveCapabilities(masked).effectiveByKey;
  assert.equal(resolved["platform.project_photos"], false);
  assert.equal(resolved["platform.photos_feed"], true, "the company Feed is independent of the project Photos offer");
  assert.equal(resolved["platform.customer_portal"], false);
  assert.equal(resolved["platform.customer_portal_media"], false);
  assert.equal(configured["platform.project_photos"], true);
});

test("an enabled Feed remains operational while project Photos is offered", () => {
  const values = maskOfferedCapabilities({ "platform.expanded_access": true, "platform.photos_feed": true, "platform.project_photos": true }, ["project.photos"]);
  const { effectiveByKey } = resolveCapabilities(values);
  const appEntitlements = resolveAppEntitlements({ effectiveByKey, offeredAppIds: ["project.photos"] });
  const feed = appEntitlements.find(app => app.id === "portal.photos_feed");
  assert.equal(feed?.allowed, true);
  assert.notEqual(feed?.offered, true);
  assert.equal(feed?.visible.desktop, true);
  assert.equal(feed?.visible.mobile, true);
  for (const expanded of [false, true]) {
    const ctx = { appEntitlements, accessProfile: expanded ? {} : undefined } as PlatformAuthContext;
    assert.equal(hasAppAccess(ctx, "portal.photos_feed"), true);
    assert.equal(hasAppAccess(ctx, "project.photos"), false);
  }
  assert.equal(resolveCapabilities({ ...values, "platform.photos_feed": false }).effectiveByKey["platform.photos_feed"], false,
    "an explicitly disabled Feed stays disabled");
});

test("only known offers are accepted and duplicate values are removed", () => {
  assert.deepEqual(offeredAppIds(["project.docs", "project.docs", "platform.expanded_access", null]), ["project.docs"]);
  assert.deepEqual(maskOfferedCapabilities({ "platform.expanded_access": true }, ["platform.expanded_access"]),
    { "platform.expanded_access": true });
});

test("an offered app is discoverable while unrelated apps remain off", () => {
  const apps = resolveAppEntitlements({ effectiveByKey: {}, offeredAppIds: ["project.photos"] });
  const photos = apps.find(app => app.id === "project.photos");
  assert.equal(photos?.offered, true);
  assert.equal(photos?.allowed, true);
  assert.equal(apps.some(app => app.id === "portal.photos_feed"), false);
});

test("an offered tab does not grant access to its operational routes", () => {
  const appEntitlements = resolveAppEntitlements({ effectiveByKey: {}, offeredAppIds: ["project.photos"] });
  for (const expanded of [false, true]) {
    const ctx = { appEntitlements, accessProfile: expanded ? {} : undefined } as PlatformAuthContext;
    assert.equal(hasAppAccess(ctx, "project.photos"), false);
    assert.equal(hasAppEntitlement(ctx, 'photos'), false);
  }
});

test('generic global writes cannot consume offers or forge their activation record', () => {
  assert.equal(containsAppFlagMutation({ data: { app_offers: [] } }), true);
  assert.equal(containsAppFlagMutation({ app_activations: {} }), true);
});


test("Equipment is discoverable globally but operationally off until its offer is accepted", () => {
 const masked=resolveCapabilities(maskOfferedCapabilities({'platform.expanded_access':true,'apps.equipment':true,'equipment.scheduling':true},['portal.equipment'])).effectiveByKey;
 assert.equal(masked['apps.equipment'],false);
 assert.notEqual(masked['equipment.scheduling'],true);
 const appEntitlements=resolveAppEntitlements({effectiveByKey:masked,offeredAppIds:['portal.equipment']});
 const equipment=appEntitlements.find(app=>app.id==='portal.equipment');
 assert.equal(equipment?.allowed,true);
 assert.equal(equipment?.offered,true);
 assert.equal(equipment?.welcome?.theme,'equipment');
 assert.equal(hasAppAccess({appEntitlements} as PlatformAuthContext,'portal.equipment'),false);
});
