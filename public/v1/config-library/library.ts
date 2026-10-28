import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../src/config/env.js";
import { contentHash, deepFreeze, idFromSnapshotFileName } from "./canonical.js";
import type { JsonData, LibraryChange, LibraryEntry } from "./contracts.js";

/**
 * Reading the platform config library (docs/architecture/config-library.md). Code reads defaults only through here.
 *
 * Where entries come from:
 * - **Development data environment** (dev.1m8.ai, a local stack): the library store. It is seeded once from the
 *   checked-in snapshot (only entries it has never had), then edited live; every process polls one sequence number
 *   each second and reloads what changed, so an edit is read on the next load anywhere, with no rollout.
 * - **Everywhere else** (production, tests that do not opt in): the checked-in snapshot only. Writes are refused.
 *
 * Reads are synchronous and return frozen values: clone (`libraryCopy`) before changing one. Before the store has
 * loaded, reads return the snapshot, which on a fresh store is the same content.
 */

type Bucket = Map<string, LibraryEntry>;
const entries = new Map<string, Bucket>();
const listeners = new Set<(change: LibraryChange) => void>();
let snapshotLoaded = false;
let version = 0;

export function librarySource(): "store" | "snapshot" {
  const forced = String(process.env.CONFIG_LIBRARY_SOURCE || "").trim().toLowerCase();
  if (forced === "store" || forced === "snapshot") return env.isProduction ? "snapshot" : forced;
  return !env.isProduction && env.dataEnvironment === "development" ? "store" : "snapshot";
}
export const libraryWritable = () => librarySource() === "store";

const here = path.dirname(fileURLToPath(import.meta.url));
/** The checked-in snapshot. A compiled build (dist/config-library) reads the source tree's copy. */
export function snapshotDir() {
  const configured = String(process.env.CONFIG_LIBRARY_SNAPSHOT_DIR || "").trim();
  if (configured) return path.resolve(configured);
  // A compiled build may carry a partial copy (JSON only) under dist/: the source tree's snapshot comes first there.
  const source = path.resolve(here, "..", "..", "config-library", "snapshot");
  const compiled = path.basename(path.resolve(here, "..")) === "dist";
  const candidates = compiled ? [source, path.join(here, "snapshot")] : [path.join(here, "snapshot"), source, path.resolve(process.cwd(), "config-library", "snapshot")];
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0]!;
}

export type SnapshotFile = { kind: string; id: string; revision: number; sha256: string; title: string; data: JsonData; updated_at?: string; updated_by?: string };

/** Every entry in the checked-in snapshot, kind by kind. */
export function readSnapshot(dir = snapshotDir()): SnapshotFile[] {
  if (!existsSync(dir)) return [];
  const found: SnapshotFile[] = [];
  for (const kind of readdirSync(dir, { withFileTypes: true })) {
    if (!kind.isDirectory() || kind.name.startsWith("_")) continue;
    for (const file of readdirSync(path.join(dir, kind.name))) {
      if (!file.endsWith(".json")) continue;
      const parsed = JSON.parse(readFileSync(path.join(dir, kind.name, file), "utf8")) as SnapshotFile;
      if (parsed.kind !== kind.name || parsed.id !== idFromSnapshotFileName(file)) throw new Error(`Config library snapshot ${kind.name}/${file} does not name its own kind and id.`);
      if (contentHash(parsed.data) !== parsed.sha256) throw new Error(`Config library snapshot ${kind.name}/${file} was edited by hand: its sha256 does not match. Regenerate it from the store.`);
      found.push(parsed);
    }
  }
  return found;
}

function ensureLoaded() {
  if (snapshotLoaded) return;
  snapshotLoaded = true;
  for (const file of readSnapshot()) {
    put({ kind: file.kind, id: file.id, revision: file.revision, sha256: file.sha256, title: file.title, data: file.data, updated_at: file.updated_at || "", updated_by: file.updated_by || "snapshot" });
  }
  if (librarySource() === "store") void startLibrarySync().catch(() => undefined);
}

function put(entry: LibraryEntry) {
  let bucket = entries.get(entry.kind);
  if (!bucket) entries.set(entry.kind, bucket = new Map());
  bucket.set(entry.id, deepFreeze(entry));
}

/** Called by the store sync and by writes in this process. */
export function applyLibraryChange(entry: LibraryEntry | { kind: string; id: string; revision: number; deleted: true }) {
  ensureLoaded();
  const current = entries.get(entry.kind)?.get(entry.id);
  if ("deleted" in entry) {
    if (!current) return;
    entries.get(entry.kind)!.delete(entry.id);
  } else {
    if (current && current.revision === entry.revision && current.sha256 === entry.sha256) return;
    put(entry);
  }
  version += 1;
  const change: LibraryChange = { kind: entry.kind, id: entry.id, revision: entry.revision, deleted: "deleted" in entry };
  for (const listener of listeners) { try { listener(change); } catch { /* a listener never breaks a read */ } }
}

/** Every current entry of a kind, ordered by id. */
export function libraryEntries<T = JsonData>(kind: string): LibraryEntry<T>[] {
  ensureLoaded();
  return [...(entries.get(kind)?.values() || [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) as unknown as LibraryEntry<T>[];
}
export function libraryEntry<T = JsonData>(kind: string, id: string): LibraryEntry<T> | null {
  ensureLoaded();
  return (entries.get(kind)?.get(id) as unknown as LibraryEntry<T> | undefined) || null;
}
/** An entry's data (frozen), or null. */
export function libraryData<T = JsonData>(kind: string, id: string): T | null {
  return libraryEntry<T>(kind, id)?.data ?? null;
}
/** An entry's data as a fresh, changeable copy, or null. */
export function libraryCopy<T = JsonData>(kind: string, id: string): T | null {
  const data = libraryData<T>(kind, id);
  return data === null ? null : structuredClone(data) as T;
}
export function libraryKinds() { ensureLoaded(); return [...entries.keys()].sort(); }

/** Rises with every change this process has seen: a cheap key for caches derived from library entries. */
export function libraryVersion() { ensureLoaded(); return version; }
/** Called after any entry changes in this process (a local write or a change another process made). */
export function onLibraryChange(listener: (change: LibraryChange) => void) { listeners.add(listener); return () => listeners.delete(listener); }

/** What an organization's copy records about the entry it came from, so an untouched copy can be told apart. */
export type LibraryStamp = { kind: string; id: string; revision: number; sha256: string };
export function libraryStamp(entry: LibraryEntry): LibraryStamp { return { kind: entry.kind, id: entry.id, revision: entry.revision, sha256: entry.sha256 }; }

// Store sync (development data environment). Imported lazily so the snapshot path never opens a database.
let syncing: Promise<void> | undefined;
let timer: NodeJS.Timeout | undefined;
let seenSeq = -1;
export const LIBRARY_POLL_MS = 1000;

/** Seeds the store from the snapshot (entries it never had), loads it and keeps this process current. Idempotent. */
export function startLibrarySync() {
  if (librarySource() !== "store") return Promise.resolve();
  return syncing ??= (async () => {
    const { seedStoreFromSnapshot } = await import("./writes.js");
    await seedStoreFromSnapshot();
    await refreshLibrary();
    timer = setInterval(() => { void refreshLibrary().catch(() => undefined); }, LIBRARY_POLL_MS);
    timer.unref?.();
  })().catch((error) => { syncing = undefined; throw error; });
}
export function stopLibrarySync() { if (timer) clearInterval(timer); timer = undefined; syncing = undefined; seenSeq = -1; }

/** Reads whatever changed in the store since this process last looked. One query when nothing did. */
export async function refreshLibrary() {
  if (librarySource() !== "store") return;
  ensureLoaded();
  const { libraryStore, currentSeq } = await import("./store.js");
  const seq = await currentSeq();
  if (seq === seenSeq) return;
  const rows = await libraryStore().prepare("SELECT * FROM config_library_heads WHERE seq > ? ORDER BY seq").all(seenSeq);
  for (const row of rows) {
    if (Number(row.deleted)) applyLibraryChange({ kind: String(row.kind), id: String(row.entry_id), revision: Number(row.revision), deleted: true });
    else applyLibraryChange(entryFromRow(row));
  }
  seenSeq = Math.max(seq, ...rows.map((row) => Number(row.seq)));
}

export function entryFromRow(row: Record<string, unknown>): LibraryEntry {
  return {
    kind: String(row.kind), id: String(row.entry_id), revision: Number(row.revision), sha256: String(row.sha256), title: String(row.title || ""),
    data: JSON.parse(String(row.data_json)) as JsonData, updated_at: String(row.updated_at || ""), updated_by: String(row.updated_by || "")
  };
}

/** Tests: forget everything read, so the next read loads the snapshot (and store) again. */
export function resetLibraryForTests() { stopLibrarySync(); entries.clear(); snapshotLoaded = false; version += 1; }
