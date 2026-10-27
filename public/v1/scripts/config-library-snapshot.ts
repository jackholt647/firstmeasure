/**
 * Exports the config library store to the checked-in snapshot (docs/architecture/config-library.md, "Snapshot").
 * The snapshot is never edited by hand: change entries on dev, then run this and commit the result.
 *
 *   FM_CONFIG_LIBRARY_KEY=fmck_... node --import tsx scripts/config-library-snapshot.ts --from https://dev.1m8.ai
 *   node --experimental-sqlite --import tsx scripts/config-library-snapshot.ts --local   (this machine's store)
 *   ... --check   (exit 1 when the checked-in snapshot differs from the store)
 */
const args = process.argv.slice(2);
const from = args[args.indexOf("--from") + 1] && args.includes("--from") ? args[args.indexOf("--from") + 1]! : "";
const check = args.includes("--check");
if (!from && !args.includes("--local")) { console.error("Pass --from <dev origin> (with FM_CONFIG_LIBRARY_KEY) or --local."); process.exit(2); }

type Exported = { entries: Array<{ kind: string; id: string; revision: number; sha256: string; title: string; data: Record<string, unknown>; updated_at: string; updated_by: string }>; assets: Array<{ sha256: string; content_type: string; file_name: string; data_base64: string }> };
let exported: Exported;
if (from) {
  const key = String(process.env.FM_CONFIG_LIBRARY_KEY || "").trim();
  if (!key) { console.error("Set FM_CONFIG_LIBRARY_KEY to a config library access key."); process.exit(2); }
  const response = await fetch(new URL("/v1/config-library/export", from), { headers: { Authorization: `Bearer ${key}` } });
  if (!response.ok) { console.error(`Export failed: ${response.status} ${await response.text()}`); process.exit(1); }
  exported = await response.json() as Exported;
} else {
  process.env.CONFIG_LIBRARY_SOURCE = "store";
  const { storeEntries } = await import("../config-library/writes.js");
  const { storeAssets } = await import("../config-library/assets.js");
  const { seedStoreFromSnapshot } = await import("../config-library/writes.js");
  await seedStoreFromSnapshot();
  exported = { entries: await storeEntries() as Exported["entries"], assets: (await storeAssets()).map((asset) => ({ ...asset, data_base64: asset.bytes.toString("base64") })) };
}
const { readSnapshot } = await import("../config-library/library.js");
const { writeSnapshot } = await import("../config-library/snapshot.js");
const current = new Map(readSnapshot().map((file) => [`${file.kind}/${file.id}`, file.sha256]));
const next = new Map(exported.entries.map((entry) => [`${entry.kind}/${entry.id}`, entry.sha256]));
const changed = [...new Set([...current.keys(), ...next.keys()])].filter((key) => current.get(key) !== next.get(key)).sort();
console.log(changed.length ? `Changed: ${changed.join(", ")}` : "The snapshot matches the store.");
if (check) process.exit(changed.length ? 1 : 0);
writeSnapshot(exported.entries, exported.assets.map((asset) => ({ sha256: asset.sha256, content_type: asset.content_type, file_name: asset.file_name, bytes: Buffer.from(asset.data_base64, "base64") })));
process.exit(0);
