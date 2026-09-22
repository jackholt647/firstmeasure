import assert from "node:assert/strict";
import test from "node:test";

/**
 * Portal tab relevance — docs/customer-portal-v2-spec.md §2.
 *
 * A tab shows when it has data now OR the project's scope says it will. These
 * are pure-function tests over that rule; the payload-level behavior is covered
 * in customer-portal-v2.test.ts.
 */

type Json = Record<string, any>;

function emptyRelevance() {
  return { show: new Set<string>(), hide: new Set<string>(), automations: new Set<string>() };
}

test("a tab with neither data nor a scope signal is hidden", async () => {
  const { tabIsRelevant } = await import("../platform/portal_tab_relevance.js");

  // The case that motivated this: an HVAC/maintenance package will never have a
  // punch list, so the tab must not appear at all.
  assert.equal(tabIsRelevant("punch_lists", { punch_lists: [] }, emptyRelevance()), false);
  assert.equal(tabIsRelevant("documents", { documents: [] }, emptyRelevance()), false);
  assert.equal(tabIsRelevant("checklists", {}, emptyRelevance()), false);
});

test("a tab with data present is shown", async () => {
  const { tabIsRelevant } = await import("../platform/portal_tab_relevance.js");
  assert.equal(tabIsRelevant("punch_lists", { punch_lists: [{ id: "p1" }] }, emptyRelevance()), true);
  assert.equal(tabIsRelevant("documents", { documents: [{ id: "d1" }] }, emptyRelevance()), true);
});

test("a tab whose scope WILL produce it is shown before any data exists", async () => {
  const { tabIsRelevant } = await import("../platform/portal_tab_relevance.js");
  const relevance = emptyRelevance();
  relevance.automations.add("punchlist.request.v1");

  // The whole point: a roofing job whose scope requests a punch list next week
  // should show the tab today, so the customer knows it is coming.
  assert.equal(tabIsRelevant("punch_lists", { punch_lists: [] }, relevance), true);
  // ...but that signal is specific. It must not light up unrelated tabs.
  assert.equal(tabIsRelevant("documents", { documents: [] }, relevance), false);
});

test("spine tabs are never scope-conditional", async () => {
  const { tabIsRelevant } = await import("../platform/portal_tab_relevance.js");
  for (const id of ["home", "summary", "schedule", "photos", "payments"]) {
    assert.equal(tabIsRelevant(id, {}, emptyRelevance()), true, `${id} should always show`);
  }
});

test("an explicit scope declaration beats inference, and hide beats show", async () => {
  const { tabIsRelevant } = await import("../platform/portal_tab_relevance.js");

  const forced = emptyRelevance();
  forced.show.add("punch_lists");
  assert.equal(tabIsRelevant("punch_lists", { punch_lists: [] }, forced), true, "explicit show wins over no data");

  // A scope that explicitly hides a tab wins even when data exists — otherwise
  // "hide" would be unenforceable the moment anything got created.
  const hidden = emptyRelevance();
  hidden.hide.add("punch_lists");
  hidden.automations.add("punchlist.request.v1");
  assert.equal(tabIsRelevant("punch_lists", { punch_lists: [{ id: "p1" }] }, hidden), false, "explicit hide wins over everything");
});

test("unknown tab ids default to visible", async () => {
  const { tabIsRelevant } = await import("../platform/portal_tab_relevance.js");
  // A tab we have no signal for is not one we should silently swallow — the
  // failure mode of guessing wrong should be a visible tab, not a missing one.
  assert.equal(tabIsRelevant("some_future_tab", {}, emptyRelevance()), true);
});

test("relevance degrades safely when scope cannot be read", async () => {
  const { projectTabRelevance, tabIsRelevant } = await import("../platform/portal_tab_relevance.js");

  // No org / no project / unreadable work database must not throw — it falls
  // back to resource-only relevance, which is the pre-scope behavior.
  const none = await projectTabRelevance("", "");
  assert.equal(none.automations.size, 0);
  assert.equal(tabIsRelevant("punch_lists", { punch_lists: [{ id: "x" }] }, none), true);

  const missing = await projectTabRelevance("org_does_not_exist", "project_does_not_exist");
  assert.ok(missing.automations instanceof Set);
});

test("every declared tab signal names a real automation or resource", async () => {
  const { portalTabSignals } = await import("../platform/portal_tab_relevance.js");
  const { registerBuiltinWorkAutomations } = await import("../work/automations/builtins.js");
  registerBuiltinWorkAutomations();
  const { listWorkAutomations } = await import("../work/registry.js");
  const registered = new Set(listWorkAutomations());

  const signals = portalTabSignals() as Record<string, Json>;
  for (const [tabId, signal] of Object.entries(signals)) {
    for (const automation of (signal.automations || []) as string[]) {
      // A signal naming an automation that does not exist is dead config: the
      // tab would silently never light up from scope.
      assert.ok(
        registered.has(automation),
        `tab "${tabId}" references unregistered automation "${automation}"`
      );
    }
  }
});
