import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { applicationPublication } from "../platform/publication/coverage.js";
import { initializePublication } from "../platform/publication/bootstrap.js";
import { listDataProviders } from "../platform/publication/providers.js";
import { listActions } from "../platform/publication/actions.js";
import { registerModuleDataProvider } from "../documents/modules/provider.js";

test("every current app makes an explicit publication decision backed by real registrations", async () => {
  initializePublication(); registerModuleDataProvider();
  const manifest = await readFile(new URL("../../libraries/apps/firstmate-apps-manifest.js", import.meta.url), "utf8");
  const packages = [...new Set([...manifest.matchAll(/package:\s*'([^']+)'/g)].map(m => m[1]!))].sort();
  assert.deepEqual(Object.keys(applicationPublication).sort(), packages, "New apps must declare data/action ownership or a justified presentation-only exception.");
  const providers = new Set(listDataProviders().map(p => p.id));
  const domains = new Set(listActions().map(a => a.domain));
  for (const [app, entry] of Object.entries(applicationPublication)) {
    for (const provider of entry.providers) assert.ok(providers.has(provider), `${app}: provider ${provider} is not registered`);
    for (const domain of entry.domains) assert.ok(domains.has(domain), `${app}: action domain ${domain} is not registered`);
    if (!entry.providers.length || !entry.domains.length) assert.ok("note" in entry && entry.note, `${app}: explain why no separate publication is needed`);
  }
});
