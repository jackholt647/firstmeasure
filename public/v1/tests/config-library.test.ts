import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { z } from "zod";

// The platform config library (config-library/): revisions with author and time, revert, checks on save, append-only
// dictionaries, assets, snapshot seeding and export, another process seeing an edit, and the API's gate.
const dir = await mkdtemp(path.join(os.tmpdir(), "config-library-"));
Object.assign(process.env, {
  NODE_ENV: "test", FIRSTMEASURE_DATA_ENVIRONMENT: "development", CONFIG_LIBRARY_SOURCE: "store", CONFIG_LIBRARY_SNAPSHOT_DIR: path.join(dir, "snapshot"),
  PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"),
  FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "index.sqlite"), INTERNAL_STORAGE_ROOT: path.join(dir, "internal"), PLATFORM_HEARTBEAT_DISABLED: "1"
});
after(async () => {
  (await import("../config-library/library.js")).stopLibrarySync();
  const { closeSqlStores } = await import("../platform/sql_store.js");
  await closeSqlStores();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
const person = { kind: "person" as const, id: "admin@1m8.test" };

test("config library: revisions, checks, append-only, assets, snapshot and sync", async () => {
  const { registerLibraryKind } = await import("../config-library/kinds.js");
  registerLibraryKind({
    kind: "test_template", title: "Test templates", description: "A test kind.",
    schema: z.object({ name: z.string().min(1), widget: z.string().optional(), image: z.string().optional(), when: z.unknown().optional() }).strict(),
    validate: (data, ctx) => [
      ...(data.widget && !ctx.registries.widget(data.widget) ? [`No widget ${data.widget}.`] : []),
      ...(data.when === undefined ? [] : ctx.registries.conditions(data.when, "when"))
    ],
    titleOf: (data) => data.name,
    assetsOf: (data) => (data.image ? [data.image.replace(/^asset:/, "")] : [])
  });
  registerLibraryKind({
    kind: "test_dictionary", title: "Test dictionary", description: "Append-only.", appendOnly: true,
    schema: z.object({ key: z.string(), unit: z.string(), label: z.string() }).strict(),
    compatible: (previous, next) => (previous.key !== next.key || previous.unit !== next.unit ? ["The key and unit never change."] : [])
  });

  // A snapshot written once (as the generator does) seeds a fresh store.
  const { writeSnapshot } = await import("../config-library/snapshot.js");
  writeSnapshot([{ kind: "test_template", id: "seeded", revision: 3, title: "Seeded", data: { name: "Seeded" }, updated_at: "", updated_by: "generator" }], [], { kinds: ["test_template"] });
  const library = await import("../config-library/library.js");
  const writes = await import("../config-library/writes.js");
  assert.equal(library.libraryData("test_template", "seeded")?.name, "Seeded", "read from the snapshot before the store loads");
  await library.startLibrarySync();
  assert.equal(library.libraryEntry("test_template", "seeded")?.revision, 3, "imported at the snapshot's revision");
  assert.throws(() => { (library.libraryData("test_template", "seeded") as any).name = "x"; }, "entries are frozen");

  // Saving: structure, references to the running code, and revisions.
  await assert.rejects(() => writes.saveEntry({ kind: "test_template", id: "a", data: { name: "" } }, person), /config_library_invalid|was not saved/);
  await assert.rejects(() => writes.saveEntry({ kind: "test_template", id: "a", data: { name: "A", widget: "no.such.widget" } }, person), /No widget/);
  await assert.rejects(() => writes.saveEntry({ kind: "test_template", id: "a", data: { name: "A", when: { field: "x", operator: "not_an_operator", value: 1 } } }, person));
  await assert.rejects(() => writes.saveEntry({ kind: "test_template", id: "Bad Id", data: { name: "A" } }, person), /not a valid/);
  const first = await writes.saveEntry({ kind: "test_template", id: "a", data: { name: "A" } }, person);
  assert.equal(first.entry.revision, 1);
  assert.equal((await writes.saveEntry({ kind: "test_template", id: "a", data: { name: "A" } }, person)).changed, false, "no revision when nothing changed");
  await assert.rejects(() => writes.saveEntry({ kind: "test_template", id: "a", data: { name: "B" }, expected_revision: 0 }, person), /revision 1, not 0/);
  await writes.saveEntry({ kind: "test_template", id: "a", data: { name: "B" }, expected_revision: 1, note: "Renamed" }, { kind: "agent", id: "key:ck_1 codex" });
  assert.equal(library.libraryData("test_template", "a")?.name, "B", "read at once in this process");
  const revisions = await writes.listRevisions("test_template", "a");
  assert.deepEqual(revisions.map((r) => [r.revision, r.action, r.updated_by, r.author_kind, r.note]), [[2, "update", "key:ck_1 codex", "agent", "Renamed"], [1, "create", "admin@1m8.test", "person", ""]]);
  await writes.revertEntry({ kind: "test_template", id: "a", revision: 1 }, person);
  assert.equal(library.libraryEntry("test_template", "a")?.revision, 3);
  assert.equal(library.libraryData("test_template", "a")?.name, "A", "reverted as a new revision");
  await writes.deleteEntry({ kind: "test_template", id: "a" }, person);
  assert.equal(library.libraryEntry("test_template", "a"), null);
  await writes.revertEntry({ kind: "test_template", id: "a", revision: 3 }, person);
  assert.equal(library.libraryData("test_template", "a")?.name, "A", "a delete is reverted too");

  // Assets must exist before an entry names them.
  const assets = await import("../config-library/assets.js");
  const sha = (await import("../config-library/canonical.js")).sha256(PNG);
  await assert.rejects(() => writes.saveEntry({ kind: "test_template", id: "img", data: { name: "Img", image: `asset:${sha}` } }, person), /Upload these assets first/);
  await assert.rejects(() => assets.putAsset({ bytes: Buffer.from("<svg/>") }, person), /Only PNG/);
  const uploaded = await assets.putAsset({ bytes: PNG, file_name: "dot.png" }, person);
  assert.equal(uploaded.sha256, sha);
  await writes.saveEntry({ kind: "test_template", id: "img", data: { name: "Img", image: uploaded.ref } }, person);
  assert.deepEqual((await assets.readAsset(sha)).bytes, PNG);

  // A dictionary only grows.
  await writes.saveEntry({ kind: "test_dictionary", id: "roof.area", data: { key: "roof_area", unit: "sq_ft", label: "Roof area" } }, person);
  await writes.saveEntry({ kind: "test_dictionary", id: "roof.area", data: { key: "roof_area", unit: "sq_ft", label: "Roof area (plan)" } }, person);
  await assert.rejects(() => writes.saveEntry({ kind: "test_dictionary", id: "roof.area", data: { key: "roof_area", unit: "squares", label: "Roof area" } }, person), /never change/);
  await assert.rejects(() => writes.deleteEntry({ kind: "test_dictionary", id: "roof.area" }, person), /only ever added/);

  // Another process sees the change on its next poll: simulate by forgetting the cache and refreshing from the store.
  library.resetLibraryForTests();
  writes.resetSeedForTests();
  await library.startLibrarySync();
  assert.equal(library.libraryData("test_template", "a")?.name, "A");
  assert.equal(library.libraryData("test_template", "img")?.image, uploaded.ref);
  let seen = 0;
  library.onLibraryChange(() => { seen += 1; });
  const { libraryStore, nextSeq } = await import("../config-library/store.js");
  await libraryStore().transaction(async (tx) => {
    const seq = await nextSeq(tx);
    await tx.prepare("UPDATE config_library_heads SET data_json=?, revision=revision+1, seq=? WHERE kind='test_template' AND entry_id='seeded'").run(JSON.stringify({ name: "Changed elsewhere" }), seq);
  });
  await library.refreshLibrary();
  assert.equal(library.libraryData("test_template", "seeded")?.name, "Changed elsewhere");
  assert.equal(seen, 1);

  // The snapshot is exported from the store and refuses a hand edit.
  const exported = await writes.storeEntries();
  writeSnapshot(exported, await assets.storeAssets());
  const files = library.readSnapshot();
  assert.deepEqual(files.map((file) => `${file.kind}/${file.id}`).sort(), ["test_dictionary/roof.area", "test_template/a", "test_template/img", "test_template/seeded"]);
  assert.equal(assets.readSnapshotAssets()[0]?.sha256, sha);
  const { readFileSync, writeFileSync } = await import("node:fs");
  const file = path.join(dir, "snapshot", "test_template", "a.json");
  writeFileSync(file, readFileSync(file, "utf8").replace('"name": "A"', '"name": "Edited"'));
  assert.throws(() => library.readSnapshot(), /edited by hand/);
});

test("config library: snapshot only and read-only outside development", async () => {
  const library = await import("../config-library/library.js");
  const { env } = await import("../src/config/env.js");
  const original = env.dataEnvironment;
  (env as any).dataEnvironment = "production";
  const saved = process.env.CONFIG_LIBRARY_SOURCE;
  delete process.env.CONFIG_LIBRARY_SOURCE;
  try {
    assert.equal(library.librarySource(), "snapshot");
    const writes = await import("../config-library/writes.js");
    await assert.rejects(() => writes.saveEntry({ kind: "test_template", id: "p", data: { name: "P" } }, person), /development data environment only/);
    const access = await import("../config-library/access.js");
    assert.throws(() => access.requireLibraryEnvironment(), /Not found/);
  } finally {
    (env as any).dataEnvironment = original;
    process.env.CONFIG_LIBRARY_SOURCE = saved;
  }
});
