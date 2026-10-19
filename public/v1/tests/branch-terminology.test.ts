import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { closePlatformFixtureStores } from "./helpers/platform-fixture.js";

/** What an organization calls a branch and a region: terminology keys branches.*, kept with the default branch. */
const dir = await mkdtemp(path.join(os.tmpdir(), "branch-terminology-"));
Object.assign(process.env, { NODE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "firstmeasure", "projects_index.sqlite"), V1_LOG_LEVEL: "error" });
after(async () => { await closePlatformFixtureStores(); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

test("the terminology contract has the branch and region words", async () => {
  const contract = JSON.parse(await readFile(new URL("../platform/localization/terminology-contract.json", import.meta.url), "utf8"));
  const keys = JSON.stringify(contract);
  for (const key of ["branches.branch", "branches.branches", "branches.region", "branches.regions", "branches.main_branch"]) assert.ok(keys.includes(`"${key}"`), `${key} is declared`);
});

test("every branch reads the organization's words from the default branch; a branch's own words win", async () => {
  const s = await import("../platform/storage.js");
  const ORG = "org_branch_words";
  await s.createOrganization({ id: ORG, name: ORG });
  await s.upsertDocument(ORG, "branch", { id: "east", data: { name: "East" } });
  await s.saveBranchModule(ORG, "default", "variable_mappings", { data: { labels: { branches: { branch: "Yard", branches: "Yards", region: "District" } } } });
  const { readTerminologyMappings } = await import("../platform/localization/terminology-settings.js");
  const main = await readTerminologyMappings(ORG, "default");
  assert.equal((main.labels as any).branches.branch, "Yard");
  const east = await readTerminologyMappings(ORG, "east");
  assert.deepEqual((east.labels as any).branches, { branch: "Yard", branches: "Yards", region: "District" }, "the default branch's words apply in every branch");
  await s.saveBranchModule(ORG, "east", "variable_mappings", { data: { labels: { branches: { region: "Area" } } } });
  const own = await readTerminologyMappings(ORG, "east");
  assert.equal((own.labels as any).branches.region, "Area");
  assert.equal((own.labels as any).branches.branch, "Yard");
});
