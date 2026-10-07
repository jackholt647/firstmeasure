import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("a newer template adds items and classification to an existing market book without touching prices", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pricebook-upgrade-"));
  Object.assign(process.env, { NODE_ENV: "test", PRICEBOOK_STORAGE_ROOT: root });
  try {
    const storage = await import("../pricebook/storage.js");
    const { GLOBAL_MARKET_PRICEBOOK_ID, PRICEBOOK_FILE_NAMES } = await import("../pricebook/constants.js");
    const { DEFAULT_PRICEBOOK_TEMPLATE } = await import("../pricebook/default_template.js");
    const orgId = "org_template_upgrade";

    // Stand in for a market book and an organization made from template 1:
    // no GAF NS/UHDZ, no item types, and a price the market has since changed.
    const fresh = await storage.getGlobalMarketPricebook();
    const organization = await storage.getOrganizationPricebook(orgId);
    const older = fresh.catalog.items
      .filter((item: any) => !["gaf_ns", "gaf_uhdz"].includes(item.id))
      .map((item: any) => {
        const { itemTypeId: _type, ...rest } = item;
        return item.id === "gaf_hd" ? { ...rest, variant_dimensions: [], default_variant_selection: {}, unit_price: 411, unitPrice: 411 } : rest;
      });
    await storage.saveCatalog(GLOBAL_MARKET_PRICEBOOK_ID, { ...fresh.catalog, items: older });
    await storage.saveManifest(GLOBAL_MARKET_PRICEBOOK_ID, { ...(await storage.readManifest(GLOBAL_MARKET_PRICEBOOK_ID)), template_ref: { key: DEFAULT_PRICEBOOK_TEMPLATE.key, version: 1 } });
    // The organization's links are a file beside its manifest.
    const overlayPath = path.join(storage.pricebookDir(String(organization.manifest.id)), PRICEBOOK_FILE_NAMES.organizationOverlay);
    await writeFile(overlayPath, JSON.stringify({
      ...organization.overlay,
      entries: organization.overlay.entries.filter((entry: any) => !["gaf_ns", "gaf_uhdz", "malarkey_vista"].includes(entry.id)),
      metadata: { ...organization.overlay.metadata, template_version: 1 }
    }));

    const upgraded = await storage.getGlobalMarketPricebook();
    const item = (id: string) => upgraded.catalog.items.find((entry: any) => entry.id === id) as any;
    assert.equal(upgraded.manifest.template_ref.version, DEFAULT_PRICEBOOK_TEMPLATE.version);
    assert.ok(item("gaf_ns") && item("gaf_uhdz"), "the template's new items are added");
    assert.equal(item("gaf_hd").itemTypeId, "field_shingles", "existing items gain their classification");
    assert.equal(item("gaf_hd").variant_dimensions.length, 2, "and their colors and finish");
    assert.equal(item("gaf_hd").unit_price, 411, "a price already in the market book is kept");

    const after = await storage.getOrganizationPricebook(orgId);
    const ids = after.catalog.items.map((entry: any) => entry.id);
    assert.ok(ids.includes("gaf_ns") && ids.includes("gaf_uhdz"), "the organization links the new items once");
    assert.ok(!ids.includes("malarkey_vista"), "an item the organization removed stays removed");
    assert.equal(after.overlay.metadata.template_version, DEFAULT_PRICEBOOK_TEMPLATE.version);

    const revision = (await storage.readManifest(GLOBAL_MARKET_PRICEBOOK_ID)).revision;
    await storage.getGlobalMarketPricebook();
    assert.equal((await storage.readManifest(GLOBAL_MARKET_PRICEBOOK_ID)).revision, revision, "an up-to-date book is not rewritten");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
