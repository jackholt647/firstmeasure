import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("an organization has one sparse overlay whose live fields follow the global market book", async () => {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-pricebook-model-"));
  process.env.PRICEBOOK_STORAGE_ROOT = storageRoot;
  const storage = await import("../pricebook/storage.js");

  try {
    const global = await storage.getGlobalMarketPricebook();
    const organization = await storage.getOrganizationPricebook("org_test");
    const linked = organization.overlay.entries.find((entry) => entry.id === "gaf_hd");
    assert.equal(linked?.link_mode, "live");
    assert.deepEqual(linked?.overrides, {});
    assert.equal(linked?.item, undefined);

    const editedCatalog = structuredClone(organization.catalog);
    const editedItem = editedCatalog.items.find((item) => item.id === "gaf_hd");
    assert.ok(editedItem);
    editedItem.unit_price = 450;
    editedItem.unitPrice = 450;
    await storage.saveOrganizationCatalog("org_test", editedCatalog, Number(organization.manifest.revision));

    const globalCatalog = structuredClone(global.catalog);
    const globalItem = globalCatalog.items.find((item) => item.id === "gaf_hd");
    assert.ok(globalItem);
    globalItem.unit_price = 425;
    globalItem.unitPrice = 425;
    globalItem.description = "Updated global market description";
    globalItem.external_description = "Updated global market description";
    await storage.saveCatalog(String(global.manifest.id), globalCatalog, Number(global.manifest.revision));

    const refreshed = await storage.getOrganizationPricebook("org_test");
    const refreshedItem = refreshed.catalog.items.find((item) => item.id === "gaf_hd");
    assert.equal(refreshedItem?.unit_price, 450);
    assert.equal(refreshedItem?.description, "Updated global market description");
    assert.equal(refreshed.manifest.id, organization.manifest.id);
    assert.equal(refreshed.overlay.entries.find((entry) => entry.id === "gaf_hd")?.link_mode, "live");
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});
