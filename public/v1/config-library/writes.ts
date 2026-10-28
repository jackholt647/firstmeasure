import { badRequest, conflict, forbidden, notFound } from "../platform/errors.js";
import { contentHash, sha256 } from "./canonical.js";
import type { Author, JsonData, LibraryEntry, LibraryRevision } from "./contracts.js";
import { DEFAULT_ID_PATTERN, libraryKind } from "./kinds.js";
import { applyLibraryChange, entryFromRow, libraryEntry, libraryWritable, readSnapshot, refreshLibrary } from "./library.js";
import { libraryStore, nextSeq } from "./store.js";
import { registryChecks } from "./registries.js";

/**
 * Writing the platform config library (docs/architecture/config-library.md). Every change is a new revision with
 * its author and time; nothing is ever edited or removed from history. A save is checked against the kind's structure
 * and against what the running code registers, an append-only kind (a dictionary) refuses deletes and incompatible
 * edits, and every asset an entry names must exist. Writes are refused outside the development data environment.
 */

const now = () => new Date().toISOString();
const text = (value: unknown) => String(value ?? "").trim();

export type SaveInput = { kind: string; id: string; data: unknown; expected_revision?: number; note?: string };
export type SaveResult = { entry: LibraryEntry; changed: boolean };

function requireWritable() {
  if (!libraryWritable()) throw forbidden("config_library_read_only", "The config library is edited on the development data environment only. Here it is the checked-in snapshot.");
}
function requireKind(name: string) {
  const kind = libraryKind(name);
  if (!kind) throw notFound("config_library_kind_unknown", `There is no config library kind called ${name}.`);
  return kind;
}

/** Checks an entry without saving it: the parsed data and every problem found. */
export function checkEntry(kindName: string, id: string, data: unknown, previous = libraryEntry(kindName, id)) {
  const kind = requireKind(kindName);
  const errors: string[] = [];
  if (!(kind.idPattern || DEFAULT_ID_PATTERN).test(id)) errors.push(`The id ${JSON.stringify(id)} is not a valid ${kind.kind} id.`);
  const parsed = kind.schema.safeParse(data);
  if (!parsed.success) {
    errors.push(...parsed.error.issues.slice(0, 40).map((issue) => `${issue.path.join(".") || "data"}: ${issue.message}`));
    return { kind, data: null as JsonData | null, errors };
  }
  const value = parsed.data as JsonData;
  try { errors.push(...(kind.validate?.(value, { id, previous, registries: registryChecks() }) || [])); }
  catch (error) { errors.push(`Checking references failed: ${(error as Error).message}`); }
  if (kind.appendOnly && previous) errors.push(...(kind.compatible?.(previous.data, value, id) || []));
  else if (previous && kind.compatible) errors.push(...kind.compatible(previous.data, value, id));
  return { kind, data: value, errors };
}

async function missingAssets(ids: string[]) {
  if (!ids.length) return [];
  const rows = await libraryStore().prepare(`SELECT sha256 FROM config_library_assets WHERE sha256 IN (${ids.map(() => "?").join(",")})`).all(...ids);
  const found = new Set(rows.map((row) => String(row.sha256)));
  return ids.filter((id) => !found.has(id));
}

async function readHead(kind: string, id: string) {
  return await libraryStore().prepare("SELECT * FROM config_library_heads WHERE kind=? AND entry_id=?").get(kind, id) || null;
}

async function writeRevision(input: { kind: string; id: string; data: JsonData | null; title: string; action: LibraryRevision["action"]; author: Author; note: string; expected?: number }) {
  const db = libraryStore();
  return db.transaction(async (tx) => {
    const head = await tx.prepare("SELECT * FROM config_library_heads WHERE kind=? AND entry_id=?").get(input.kind, input.id);
    const headRevision = head ? Number(head.revision) : 0;
    if (input.expected !== undefined && input.expected !== headRevision) {
      throw conflict("config_library_revision_conflict", `${input.kind}/${input.id} is at revision ${headRevision}, not ${input.expected}. Read it again and reapply your change.`, { revision: headRevision });
    }
    const hash = input.data === null ? "" : contentHash(input.data);
    const deletedNow = !!head && Number(head.deleted) === 1;
    if (head && (input.data === null ? deletedNow : !deletedNow && String(head.sha256) === hash && String(head.title) === input.title)) {
      return { entry: deletedNow ? null : entryFromRow(head), changed: false };
    }
    if (input.data === null && !head) throw notFound("config_library_entry_missing", `${input.kind}/${input.id} does not exist.`);
    const seq = await nextSeq(tx);
    const revision = headRevision + 1;
    const at = now();
    const json = input.data === null ? "null" : JSON.stringify(input.data);
    await tx.prepare(`INSERT INTO config_library_revisions (kind, entry_id, revision, sha256, title, data_json, action, author, author_kind, note, created_at, seq)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.kind, input.id, revision, hash, input.title, json, input.action, input.author.id, input.author.kind, input.note.slice(0, 2000), at, seq);
    const headJson = input.data === null ? String(head!.data_json) : json;
    const headHash = input.data === null ? String(head!.sha256) : hash;
    await tx.prepare(`INSERT INTO config_library_heads (kind, entry_id, revision, sha256, title, data_json, deleted, updated_at, updated_by, seq)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(kind, entry_id) DO UPDATE SET revision=excluded.revision, sha256=excluded.sha256, title=excluded.title, data_json=excluded.data_json,
        deleted=excluded.deleted, updated_at=excluded.updated_at, updated_by=excluded.updated_by, seq=excluded.seq`)
      .run(input.kind, input.id, revision, headHash, input.title, headJson, input.data === null ? 1 : 0, at, input.author.id, seq);
    const entry: LibraryEntry = { kind: input.kind, id: input.id, revision, sha256: headHash, title: input.title, data: JSON.parse(headJson), updated_at: at, updated_by: input.author.id };
    return { entry: input.data === null ? null : entry, changed: true, revision };
  }, "write");
}

/** Saves an entry as a new revision (no revision when nothing changed). `expected_revision` guards against lost edits. */
export async function saveEntry(input: SaveInput, author: Author, action: "create" | "update" | "revert" | "import" = "update"): Promise<SaveResult> {
  requireWritable();
  const kindName = text(input.kind), id = text(input.id);
  const previous = await readHead(kindName, id);
  const previousEntry = previous && !Number(previous.deleted) ? entryFromRow(previous) : null;
  if (action !== "import" && action !== "revert" && previous && Number(previous.deleted) && requireKind(kindName).appendOnly) {
    throw badRequest("config_library_append_only", `${kindName} is append-only.`);
  }
  const checked = checkEntry(kindName, id, input.data, previousEntry);
  if (checked.errors.length) throw badRequest("config_library_invalid", `${kindName}/${id} was not saved: ${checked.errors.slice(0, 5).join(" ")}`, { errors: checked.errors });
  const missing = await missingAssets(checked.kind.assetsOf?.(checked.data as never) || []);
  if (missing.length) throw badRequest("config_library_asset_missing", `Upload these assets first: ${missing.join(", ")}.`, { missing });
  const title = text(checked.kind.titleOf?.(checked.data as never, id)) || id;
  const result = await writeRevision({ kind: kindName, id, data: checked.data, title, action: previousEntry || action !== "update" ? action : "create", author, note: text(input.note), expected: input.expected_revision });
  if (result.entry) applyLibraryChange(result.entry);
  return { entry: result.entry!, changed: result.changed };
}

export async function deleteEntry(input: { kind: string; id: string; expected_revision?: number; note?: string }, author: Author) {
  requireWritable();
  const kind = requireKind(text(input.kind));
  if (kind.appendOnly) throw badRequest("config_library_append_only", `${kind.kind} is a dictionary: entries are only ever added, never removed.`);
  const result = await writeRevision({ kind: kind.kind, id: text(input.id), data: null, title: libraryEntry(kind.kind, text(input.id))?.title || text(input.id), action: "delete", author, note: text(input.note), expected: input.expected_revision });
  if (result.changed) applyLibraryChange({ kind: kind.kind, id: text(input.id), revision: Number(result.revision), deleted: true });
  return { changed: result.changed };
}

function revisionFromRow(row: Record<string, unknown>): LibraryRevision {
  const data = JSON.parse(String(row.data_json));
  return {
    kind: String(row.kind), id: String(row.entry_id), revision: Number(row.revision), sha256: String(row.sha256), title: String(row.title || ""),
    data, updated_at: String(row.created_at), updated_by: String(row.author || ""), action: String(row.action) as LibraryRevision["action"],
    author_kind: String(row.author_kind || "person") as LibraryRevision["author_kind"], note: String(row.note || "")
  };
}

/** Every revision of an entry, newest first. `data` only when asked (it can be large). */
export async function listRevisions(kind: string, id: string, options: { data?: boolean } = {}) {
  const rows = await libraryStore().prepare("SELECT * FROM config_library_revisions WHERE kind=? AND entry_id=? ORDER BY revision DESC LIMIT 500").all(kind, id);
  return rows.map((row) => { const revision = revisionFromRow(row); return options.data ? revision : { ...revision, data: undefined }; });
}
export async function readRevision(kind: string, id: string, revision: number) {
  const row = await libraryStore().prepare("SELECT * FROM config_library_revisions WHERE kind=? AND entry_id=? AND revision=?").get(kind, id, revision);
  if (!row) throw notFound("config_library_revision_missing", `${kind}/${id} has no revision ${revision}.`);
  return revisionFromRow(row);
}
/** Puts an entry back to an earlier revision, as a new revision (checked again against the running code). */
export async function revertEntry(input: { kind: string; id: string; revision: number; expected_revision?: number; note?: string }, author: Author) {
  requireWritable();
  const target = await readRevision(text(input.kind), text(input.id), Number(input.revision));
  const note = text(input.note) || `Back to revision ${target.revision}.`;
  if (target.data === null) return { ...(await deleteEntry({ kind: target.kind, id: target.id, expected_revision: input.expected_revision, note }, author)), entry: null };
  return saveEntry({ kind: target.kind, id: target.id, data: target.data, expected_revision: input.expected_revision, note }, author, "revert");
}

/** Recent changes across the library, newest first, for the dev console's activity list. */
export async function recentChanges(limit = 100, kind = "") {
  const rows = kind
    ? await libraryStore().prepare("SELECT kind, entry_id, revision, title, action, author, author_kind, note, created_at, seq FROM config_library_revisions WHERE kind=? ORDER BY seq DESC LIMIT ?").all(kind, Math.min(500, limit))
    : await libraryStore().prepare("SELECT kind, entry_id, revision, title, action, author, author_kind, note, created_at, seq FROM config_library_revisions ORDER BY seq DESC LIMIT ?").all(Math.min(500, limit));
  return rows.map((row) => ({ kind: String(row.kind), id: String(row.entry_id), revision: Number(row.revision), title: String(row.title || ""), action: String(row.action), author: String(row.author || ""), author_kind: String(row.author_kind || ""), note: String(row.note || ""), at: String(row.created_at), seq: Number(row.seq) }));
}

/**
 * Entries the checked-in snapshot has and the store never had are imported (revision as in the snapshot, author
 * `snapshot`). The store wins for everything else, including entries it deleted. Assets likewise.
 */
let seeded: Promise<number> | undefined;
export function seedStoreFromSnapshot() {
  return seeded ??= (async () => {
    const files = readSnapshot();
    const { readSnapshotAssets } = await import("./assets.js");
    const assets = readSnapshotAssets();
    const db = libraryStore();
    const known = new Set((await db.prepare("SELECT kind, entry_id FROM config_library_heads").all()).map((row) => `${row.kind}\u0000${row.entry_id}`));
    const missing = files.filter((file) => !known.has(`${file.kind}\u0000${file.id}`));
    const knownAssets = new Set((await db.prepare("SELECT sha256 FROM config_library_assets").all()).map((row) => String(row.sha256)));
    const at = now();
    for (const asset of assets.filter((item) => !knownAssets.has(item.sha256))) {
      await db.prepare("INSERT INTO config_library_assets (sha256, content_type, size_bytes, file_name, data_base64, created_by, created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(sha256) DO NOTHING")
        .run(asset.sha256, asset.content_type, asset.bytes.length, asset.file_name, asset.bytes.toString("base64"), "snapshot", at);
    }
    for (let start = 0; start < missing.length; start += 50) {
      await db.transaction(async (tx) => {
        for (const file of missing.slice(start, start + 50)) {
          const exists = await tx.prepare("SELECT 1 AS hit FROM config_library_heads WHERE kind=? AND entry_id=?").get(file.kind, file.id);
          if (exists) continue;
          const seq = await nextSeq(tx);
          const json = JSON.stringify(file.data);
          await tx.prepare(`INSERT INTO config_library_revisions (kind, entry_id, revision, sha256, title, data_json, action, author, author_kind, note, created_at, seq)
            VALUES (?,?,?,?,?,?,'import','snapshot','snapshot','Imported from the checked-in snapshot.',?,?) ON CONFLICT(kind, entry_id, revision) DO NOTHING`)
            .run(file.kind, file.id, file.revision, file.sha256, file.title, json, at, seq);
          await tx.prepare(`INSERT INTO config_library_heads (kind, entry_id, revision, sha256, title, data_json, deleted, updated_at, updated_by, seq)
            VALUES (?,?,?,?,?,?,0,?,'snapshot',?) ON CONFLICT(kind, entry_id) DO NOTHING`).run(file.kind, file.id, file.revision, file.sha256, file.title, json, at, seq);
        }
      }, "write");
    }
    return missing.length;
  })().catch((error) => { seeded = undefined; throw error; });
}
export function resetSeedForTests() { seeded = undefined; }

/** Every current entry in the store (for the snapshot export). */
export async function storeEntries() {
  await refreshLibrary();
  const rows = await libraryStore().prepare("SELECT * FROM config_library_heads WHERE deleted=0 ORDER BY kind, entry_id").all();
  return rows.map(entryFromRow);
}
export { sha256 };
