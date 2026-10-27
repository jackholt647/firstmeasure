import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { contentHash, snapshotFileName } from "./canonical.js";
import { ASSET_TYPES } from "./assets.js";
import type { JsonData } from "./contracts.js";
import { snapshotDir, type SnapshotFile } from "./library.js";

/**
 * Writes the checked-in snapshot (config-library/snapshot/). It is produced from the store (or, once, by the
 * generator from the code seeds) and never edited by hand: every file carries the sha256 of its data and a read
 * refuses a file that does not match. `kinds` limits the rewrite to those kinds' folders; without it the whole
 * snapshot is replaced.
 */
export function writeSnapshot(
  entries: Array<Omit<SnapshotFile, "sha256"> & { sha256?: string }>,
  assets: Array<{ sha256: string; content_type: string; file_name: string; bytes: Buffer }> = [],
  options: { dir?: string; kinds?: string[] } = {}
) {
  const dir = options.dir || snapshotDir();
  mkdirSync(dir, { recursive: true });
  const kinds = options.kinds || readdirSync(dir, { withFileTypes: true }).filter((item) => item.isDirectory() && !item.name.startsWith("_")).map((item) => item.name);
  for (const kind of new Set([...kinds, ...(options.kinds ? [] : entries.map((entry) => entry.kind))])) rmSync(path.join(dir, kind), { recursive: true, force: true });
  const written: Record<string, number> = {};
  for (const entry of [...entries].sort((a, b) => a.kind.localeCompare(b.kind) || (a.id < b.id ? -1 : 1))) {
    if (options.kinds && !options.kinds.includes(entry.kind)) continue;
    const folder = path.join(dir, entry.kind);
    mkdirSync(folder, { recursive: true });
    const file: SnapshotFile = { kind: entry.kind, id: entry.id, revision: entry.revision, sha256: contentHash(entry.data), title: entry.title, updated_at: entry.updated_at || "", updated_by: entry.updated_by || "", data: entry.data as JsonData };
    writeFileSync(path.join(folder, snapshotFileName(entry.id)), JSON.stringify(file, null, 2) + "\n");
    written[entry.kind] = (written[entry.kind] || 0) + 1;
  }
  if (assets.length || !options.kinds) {
    const folder = path.join(dir, "_assets");
    if (!options.kinds) rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    let index: Array<{ sha256: string; content_type: string; file_name: string }> = [];
    try { index = JSON.parse(readFileSync(path.join(folder, "index.json"), "utf8")); } catch { index = []; }
    const known = new Map(index.map((item) => [item.sha256, item]));
    for (const asset of assets) {
      writeFileSync(path.join(folder, `${asset.sha256}.${ASSET_TYPES[asset.content_type] || "bin"}`), asset.bytes);
      known.set(asset.sha256, { sha256: asset.sha256, content_type: asset.content_type, file_name: asset.file_name });
    }
    writeFileSync(path.join(folder, "index.json"), JSON.stringify([...known.values()].sort((a, b) => a.sha256.localeCompare(b.sha256)), null, 2) + "\n");
  }
  return written;
}
