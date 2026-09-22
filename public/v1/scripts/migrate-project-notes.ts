/* One-time migration: move legacy project_note_items (JSON arrays embedded in
 * project documents) into the channels backend as messages in each project's
 * channel, then strip the legacy arrays from the documents.
 *
 * Idempotent: messages are keyed by client_msg_id = "legacy:<note id>", so
 * re-running skips notes that already migrated.
 *
 * Run from public/v1:
 *   node --experimental-sqlite --import tsx scripts/migrate-project-notes.ts
 * Storage roots come from the usual env vars (.env is loaded by env.ts).
 */
import { readdir } from "node:fs/promises";
import path from "node:path";

import { listDocuments, upsertDocument } from "../platform/storage.js";
import { ensureProjectChannelRecord } from "../channels/service.js";
import { createMessageRecord, findMessageByClientId } from "../channels/storage.js";
import { env } from "../src/config/env.js";

type JsonObject = Record<string, unknown>;

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

async function listOrganizationIds() {
  const organizationsDir = path.resolve(process.cwd(), env.platformStorageRoot, "organizations");
  try {
    const entries = await readdir(organizationsDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function migrateOrganization(orgId: string) {
  let migrated = 0;
  let skipped = 0;
  let projectsTouched = 0;
  const projects = await listDocuments(orgId, "projects").catch(() => []);
  for (const document of projects) {
    const data = asObject(document.data);
    const notes = Array.isArray(data.project_note_items) ? data.project_note_items.map(asObject) : [];
    if (!notes.length) continue;

    const title = cleanText(data.title || data.name || data.project_title);
    const channel = ensureProjectChannelRecord(orgId, document.id, title, "migration");

    for (const note of notes) {
      const noteId = cleanText(note.id) || `unidentified_${migrated + skipped}`;
      const text = cleanText(note.text || note.body || note.note);
      if (!text) {
        skipped += 1;
        continue;
      }
      const clientMsgId = `legacy:${noteId}`;
      const author = asObject(note.created_by);
      const authorId = cleanText(author.id) || cleanText(author.email).toLowerCase() || "legacy";
      if (findMessageByClientId(channel.id, authorId, clientMsgId)) {
        skipped += 1;
        continue;
      }
      const visibility = Array.isArray(note.visibility) ? note.visibility.map(cleanText).filter(Boolean) : [];
      const audience = visibility.length >= 3 ? [] : visibility; // all three groups = everyone
      createMessageRecord({
        organization_id: orgId,
        channel_id: channel.id,
        client_msg_id: clientMsgId,
        author_id: authorId,
        text,
        audience,
        tags: Array.isArray(note.type_tags) ? note.type_tags.map(cleanText).filter(Boolean) : [],
        mention_users: Array.isArray(note.mention_users) ? note.mention_users.map(asObject) : [],
        metadata: { legacy_note: { id: noteId, updated_at: cleanText(note.updated_at), author } },
        created_at: cleanText(note.created_at) || undefined
      });
      migrated += 1;
    }

    // Strip the legacy array so no surface double-reads stale note JSON.
    await upsertDocument(orgId, "projects", {
      id: document.id,
      expected_revision: document.revision,
      data: { project_note_items: [] },
      metadata: document.metadata
    }).catch((error) => {
      console.warn(`  ! could not strip legacy notes from ${document.id}: ${(error as Error).message}`);
    });
    projectsTouched += 1;
  }
  return { migrated, skipped, projectsTouched };
}

const orgIds = await listOrganizationIds();
console.log(`Migrating project notes to channels for ${orgIds.length} organization(s)…`);
let totals = { migrated: 0, skipped: 0, projectsTouched: 0 };
for (const orgId of orgIds) {
  const result = await migrateOrganization(orgId);
  if (result.projectsTouched) {
    console.log(`  ${orgId}: ${result.migrated} migrated, ${result.skipped} skipped, ${result.projectsTouched} project(s)`);
  }
  totals = {
    migrated: totals.migrated + result.migrated,
    skipped: totals.skipped + result.skipped,
    projectsTouched: totals.projectsTouched + result.projectsTouched
  };
}
console.log(`Done. ${totals.migrated} note(s) migrated, ${totals.skipped} skipped, across ${totals.projectsTouched} project(s).`);
