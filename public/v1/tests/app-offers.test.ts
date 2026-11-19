import assert from "node:assert/strict";
import test from "node:test";
import { NEW_ORGANIZATION_APP_OFFERS, isOfferableApp, maskOfferedCapabilities, offerSiblings, offerSwitches, offeredAppIds } from "../platform/app-experience/offers.js";
import { appDefinitions } from "../platform/app-experience/registry.js";
import { resolveCapabilities } from "../platform/capabilities.js";
import "../platform/capability_defs.js";
import { resolveAppEntitlements } from "../workforce/access.js";
import { can, hasAppAccess, hasAppEntitlement, type PlatformAuthContext } from "../platform/auth.js";
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

test("project Notes stays on whether Channels is on, off or offered; only the Messages tray waits for Channels (FM-482)", async () => {
  const configured = { "platform.expanded_access": true, "apps.projects": true, "apps.channels": true, "channels.project_notes": true,
    "channels.separate_project_notes": true, "channels.project_messages_tray": true };
  const states: Array<[string, Record<string, unknown>, string[], boolean]> = [
    ["on", configured, [], true],
    ["off", { ...configured, "apps.channels": false }, [], false],
    ["offered, not started", configured, ["portal.channels"], false]
  ];
  for (const [label, values, offers, channelsOn] of states) {
    const resolution = resolveCapabilities(maskOfferedCapabilities(values, offers) as any);
    assert.equal(resolution.effectiveByKey["apps.channels"], channelsOn, `Channels ${label}`);
    assert.equal(resolution.effectiveByKey["channels.project_notes"], true, `Notes with Channels ${label}`);
    assert.equal(resolution.effectiveByKey["channels.project_messages_tray"], channelsOn, `Messages tray with Channels ${label}`);
    const appEntitlements = resolveAppEntitlements({ effectiveByKey: resolution.effectiveByKey, offeredAppIds: offers });
    const ctx = { orgId: "org", userId: "user", capabilities: resolution, appEntitlements } as unknown as PlatformAuthContext;
    assert.equal(await can(ctx, "channels.project_notes"), true, `Notes routes with Channels ${label}`);
  }
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

test("Photos is never a new organization's offer: where it is on it is on, the window's first tab (GP-88)", () => {
  assert.equal(NEW_ORGANIZATION_APP_OFFERS.includes("project.photos"), false);
  assert.deepEqual(offeredAppIds(NEW_ORGANIZATION_APP_OFFERS), NEW_ORGANIZATION_APP_OFFERS, "every default offer can be offered");
});

test("every app with an organization switch can be offered, with a placeholder welcome until it has its own", () => {
  for (const app of appDefinitions()) assert.equal(isOfferableApp(app.id), app.capabilities.length > 0, app.id);
  // An app outside APP_OFFERS holds back its own switches; the explicit groups keep theirs.
  assert.deepEqual(offerSwitches("portal.stats"), ["apps.stats"]);
  assert.deepEqual(offerSwitches("portal.financials"), ["platform.money"]);
  assert.equal(resolveCapabilities(maskOfferedCapabilities({ "platform.expanded_access": true, "apps.stats": true }, ["portal.stats"])).effectiveByKey["apps.stats"], false);
  assert.deepEqual(offerSiblings("portal.crew_overview").sort(), ["portal.crew_overview", "portal.crew_schedule", "project.crew_overview"]);
  const apps = resolveAppEntitlements({ effectiveByKey: {}, offeredAppIds: ["portal.stats", "project.photos"] });
  const stats = apps.find(app => app.id === "portal.stats");
  assert.equal(stats?.offered, true);
  assert.equal(stats?.welcome?.placeholder, true, "no app_welcome entry: the placeholder");
  assert.equal(stats?.welcome?.headline.text, stats?.title);
  assert.ok(stats?.welcome?.benefits.length);
  assert.notEqual(apps.find(app => app.id === "project.photos")?.welcome?.placeholder, true, "an app's own welcome wins");
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

test("Scheduling is offered as one app: its project tab and its page hold back scheduling until started", () => {
  assert.deepEqual(offerSiblings("project.schedule"), ["project.schedule", "portal.scheduling"]);
  const configured = { "platform.expanded_access": true, "platform.scheduling": true, "scheduling.appointment_slots": true };
  const masked = resolveCapabilities(maskOfferedCapabilities(configured, ["project.schedule", "portal.scheduling"])).effectiveByKey;
  assert.equal(masked["platform.scheduling"], false);
  assert.notEqual(masked["scheduling.appointment_slots"], true);
  const appEntitlements = resolveAppEntitlements({ effectiveByKey: masked, offeredAppIds: ["project.schedule", "portal.scheduling"] });
  for (const id of ["project.schedule", "portal.scheduling"]) {
    const app = appEntitlements.find(entry => entry.id === id);
    assert.equal(app?.allowed, true, id);
    assert.equal(app?.offered, true, id);
    assert.equal(hasAppAccess({ appEntitlements } as PlatformAuthContext, id), false, id);
  }
});
