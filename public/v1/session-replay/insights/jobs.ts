import { gunzipSync } from "node:zlib";

import { listReplaySessions, readReplayChunks, readReplaySession } from "../storage.js";
import { indexSession } from "./indexer.js";
import { deleteSessionIndex, saveSessionIndex, staleSessions } from "./store.js";

/**
 * Keeps the search index current (docs/architecture/session-replay-search.md). A session is indexed once it
 * has been quiet for QUIET_MS, and again whenever more of it was recorded or the indexer changed. Recordings
 * are read through the same storage functions as the viewer, so archived sessions index the same way.
 */
export const QUIET_MS = 10 * 60 * 1000;

export async function indexReplaySession(sessionId: string) {
  const found = await readReplaySession(sessionId);
  if (!found) { await deleteSessionIndex(sessionId); return null; }
  const started = Date.now();
  const pages: Array<{ page_id: string; chunks: unknown[] }> = [];
  let bytes = 0;
  for (const page of found.pages) {
    const chunks: unknown[] = [];
    let after = -1;
    for (;;) {
      const batch = await readReplayChunks(sessionId, page.page_id, after, 500);
      for (const chunk of batch) { bytes += chunk.bytes_stored; chunks.push(JSON.parse(gunzipSync(chunk.data).toString("utf8"))); after = chunk.seq; }
      if (batch.length < 500) break;
    }
    pages.push({ page_id: page.page_id, chunks });
  }
  const index = indexSession(pages);
  const s = found.session;
  await saveSessionIndex({ session_id: s.id, organization_id: s.organization_id, user_id: s.user_id, user_email: s.user_email, pages: found.pages.length,
    device: { platform: s.device.platform, mobile: s.device.mobile, viewport: s.device.viewport, user_agent: s.user_agent }, source_last_at: s.last_at }, index);
  return { session_id: s.id, steps: index.steps.length, ...index.counts, screens: index.screens.size, targets: index.targets.size, recording_bytes: bytes, index_ms: Date.now() - started };
}

/** Indexes up to `limit` sessions that went quiet and are new or changed since they were last indexed. */
export async function indexPendingReplaySessions(options: { limit?: number; quietMs?: number; scan?: number; log?: (message: string, error?: unknown) => void } = {}) {
  const limit = options.limit ?? 25, scanCap = options.scan ?? 2000;
  let before = Date.now() - (options.quietMs ?? QUIET_MS);
  let indexed = 0, scanned = 0, failed = 0;
  while (indexed < limit && scanned < scanCap) {
    const batch = await listReplaySessions({ before, limit: 200 });
    if (!batch.length) break;
    scanned += batch.length;
    for (const session of await staleSessions(batch.map((s) => ({ id: s.id, last_at: s.last_at })))) {
      if (indexed >= limit) break;
      try { await indexReplaySession(session.id); indexed++; }
      catch (error) { failed++; options.log?.(`Session replay index failed for ${session.id}`, error); }
    }
    if (batch.length < 200) break;
    before = batch[batch.length - 1]!.last_at;
  }
  return { indexed, scanned, failed };
}
