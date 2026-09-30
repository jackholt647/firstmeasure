import { AsyncLocalStorage } from "node:async_hooks";
import { PlatformError, conflict } from "./errors.js";
import { readDocument, upsertDocument, type JsonObject } from "./storage.js";

/* Safe read-modify-write for project documents.
 *
 * A project document embeds its schedule items (data.events), so every writer
 * that rewrites the events array must never replace it with a copy read before
 * another writer's save (R3-RAIL-2: two concurrent creates both answered 200
 * and only one item was stored). Two layers make that hold:
 *
 *  1. Writers in this process are serialized per project (a promise chain), so
 *     double-clicks, cascades and parallel requests to one API process never
 *     interleave their read and write.
 *  2. The write is conditional on the document revision that was read
 *     (upsertDocument expected_revision: a compare-and-set inside the storage
 *     lock / Postgres row lock). A conflict re-reads and re-applies the change,
 *     so the guarantee also holds across several web processes.
 *
 * Re-entrant calls (a mutation that indirectly triggers another mutation of
 * the same project in the same async context) skip the in-process queue and
 * rely on the revision check alone instead of deadlocking. */

type LockScope = Set<string>;
const heldLocks = new AsyncLocalStorage<LockScope>();
const lockTails = new Map<string, Promise<void>>();

function lockKey(orgId: string, projectId: string) {
  return `${orgId}\u0000${projectId}`;
}

export async function withProjectDocumentLock<T>(orgId: string, projectId: string, work: () => Promise<T>): Promise<T> {
  const key = lockKey(orgId, projectId);
  const held = heldLocks.getStore();
  if (held?.has(key)) return await work();
  const previous = lockTails.get(key) || Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate, () => gate);
  lockTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await heldLocks.run(new Set([...(held || []), key]), work);
  } finally {
    release();
    if (lockTails.get(key) === tail) lockTails.delete(key);
  }
}

/* R4-EQ-5: equipment double-booking. The conflict check reads every booking
 * of the unit (other projects, floating calendar events) and the write then
 * stores this one; two writers for different projects hold different project
 * locks, so both could pass the check before either writes. Writes that carry
 * or release equipment therefore also hold one per-organization booking lock
 * from the check through the write, and re-run the check inside it.
 *
 * Lock order: always taken INSIDE a project / calendar item lock and never
 * the other way round (nothing inside it takes a project lock), so it cannot
 * deadlock. Like the project lock it is in-process only: several web
 * processes serving one organization can still interleave (the storage layer
 * has no cross-document transaction to make the check-and-write atomic). */
export async function withEquipmentBookingLock<T>(orgId: string, enabled: boolean, work: () => Promise<T>): Promise<T> {
  if (!enabled) return await work();
  return await withProjectDocumentLock(orgId, "\u0000equipment_bookings", work);
}

export function isRevisionConflict(error: unknown) {
  return error instanceof PlatformError && (error.code === "revision_conflict" || error.code === "document_revision_conflict");
}

const DEFAULT_ATTEMPTS = 8;

function backoff(attempt: number) {
  const ms = Math.min(250, 10 * 2 ** attempt) * (0.5 + Math.random());
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `attempt` with the freshly read project document while holding the
 * per-project lock. `attempt` must write with
 * `expected_revision: document.revision` (see `writeProjectDocument`); a
 * revision conflict re-reads the document and runs `attempt` again.
 * Side effects inside `attempt` must therefore be idempotent.
 */
export async function mutateProjectDocument<T>(
  orgId: string,
  projectId: string,
  attempt: (document: JsonObject & { data?: unknown; metadata?: unknown; revision?: unknown }, attemptIndex: number) => Promise<T>,
  options: { attempts?: number } = {}
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  return await withProjectDocumentLock(orgId, projectId, async () => {
    for (let index = 0; ; index += 1) {
      const document = await readDocument(orgId, "projects", projectId);
      try {
        return await attempt(document as JsonObject, index);
      } catch (error) {
        if (!isRevisionConflict(error)) throw error;
        if (index >= attempts - 1) {
          throw conflict("revision_conflict", "The project changed repeatedly while it was being saved. Try again.");
        }
        await backoff(index);
      }
    }
  });
}

/** Conditional full write of a project document read by `mutateProjectDocument`. */
export async function writeProjectDocument(
  orgId: string,
  document: JsonObject & { data?: unknown; metadata?: unknown; revision?: unknown },
  data: JsonObject,
  metadata: JsonObject = (document.metadata && typeof document.metadata === "object" ? document.metadata as JsonObject : {})
) {
  return await upsertDocument(orgId, "projects", {
    id: String(document.id),
    expected_revision: Number(document.revision || 0),
    data,
    metadata
  }, { replace: true });
}

/**
 * Convenience wrapper: apply `change` to the current project data and write
 * it conditionally. Return `null` from `change` to skip the write.
 */
export async function updateProjectData(
  orgId: string,
  projectId: string,
  change: (data: JsonObject, document: JsonObject) => JsonObject | null | Promise<JsonObject | null>,
  options: { attempts?: number; metadata?: (metadata: JsonObject) => JsonObject } = {}
) {
  return await mutateProjectDocument(orgId, projectId, async (document) => {
    const data = document.data && typeof document.data === "object" && !Array.isArray(document.data)
      ? { ...(document.data as JsonObject) }
      : {};
    const next = await change(data, document);
    if (!next) return null;
    const metadata = document.metadata && typeof document.metadata === "object" ? { ...(document.metadata as JsonObject) } : {};
    return await writeProjectDocument(orgId, document, next, options.metadata ? options.metadata(metadata) : metadata);
  }, options);
}
