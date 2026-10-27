import assert from "node:assert/strict";
import test from "node:test";
import { maskOfferedCapabilities, offeredAppIds } from "../platform/app-experience/offers.js";
import { resolveCapabilities } from "../platform/capabilities.js";
import "../platform/capability_defs.js";
import { resolveAppEntitlements } from "../workforce/access.js";
import { hasAppAccess, hasAppEntitlement, type PlatformAuthContext } from "../platform/auth.js";
import { containsAppFlagMutation } from '../platform/app_flags.js';

test("offers mask the operational capabilities and their dependent features", () => {
  const configured = { "platform.project_photos": true, "platform.photos_feed": true,
    "platform.customer_portal": true, "platform.customer_portal_media": true };
  const masked = maskOfferedCapabilities(configured, ["project.photos", "project.customer_portal"]);
  const resolved = resolveCapabilities(masked).effectiveByKey;
  assert.equal(resolved["platform.project_photos"], false);
  assert.equal(resolved["platform.photos_feed"], false);
  assert.equal(resolved["platform.customer_portal"], false);
  assert.equal(resolved["platform.customer_portal_media"], false);
  assert.equal(configured["platform.project_photos"], true);
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
