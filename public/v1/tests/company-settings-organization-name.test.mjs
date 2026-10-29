import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const publicRoot = path.resolve(import.meta.dirname, "../..");

test("PlatformAPI organization patches send organization fields directly", async () => {
  const source = await readFile(path.join(publicRoot, "libraries/platform-api/platform-api.js"), "utf8");
  const requests = [];
  const window = { __APP: { platformApiBase: "https://example.test/v1/platform" } };
  const context = {
    window,
    location: { hostname: "example.test", origin: "https://example.test", protocol: "https:" },
    document: { cookie: "" },
    FormData: class FormData {},
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
    },
    URLSearchParams,
    URL,
    Blob,
    File: globalThis.File,
    console,
    setTimeout,
    clearTimeout
  };
  vm.runInNewContext(source, context, { filename: "platform-api.js" });

  await window.PlatformAPI.orgs.patch("org_test", { name: "Acme Roofing" });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://example.test/v1/platform/organizations/org_test");
  assert.equal(requests[0].options.method, "PATCH");
  assert.deepEqual(JSON.parse(requests[0].options.body), { name: "Acme Roofing" });
});

test("Company Settings keeps organization and branch names separate", async () => {
  const source = await readFile(path.join(publicRoot, "libraries/apps/settings/company.js"), "utf8");

  assert.match(source, /name:\s*portalState\?\.organization\?\.name\s*\|\|\s*''/);
  assert.doesNotMatch(source, /name:\s*branchData\.name\s*\|\|\s*portalState\?\.organization\?\.name/);
  assert.doesNotMatch(source, /if\s*\(branch\?\.name\)\s*result\.name\s*=\s*branch\.name/);
  // FM-300: saving the company name must rename the organization itself, not only the branch's presentation
  // copy; without it every signup left "Your Company" kept the placeholder whatever the owner typed here.
  const saveOrg = source.slice(source.indexOf("async function saveOrg("), source.indexOf("async function saveReportSettings("));
  assert.ok(saveOrg.length > 0, "saveOrg is found");
  const rename = saveOrg.search(/window\.PlatformAPI\.orgs\.patch\(orgId,\s*\{\s*name:/);
  assert.ok(rename > 0, "saveOrg renames the organization with PlatformAPI.orgs.patch");
  assert.ok(rename < saveOrg.indexOf("PlatformAPI.branches.save("), "the organization is renamed on the platform (branch) save path");
  assert.match(source, /name:\s*branch\.name\s*\?\?\s*''/);
  assert.match(source, /name:\s*String\(window\.__APP\?\.userCompany\s*\|\|\s*''\)\.trim\(\)/);
  assert.doesNotMatch(source, /state\.name\s*=\s*\(bootTheme\.name/);
});
