import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * What a document write is part of, carried with the work so the one writer
 * (saveDocumentInstance) records it without every caller passing it.
 *
 * A lifecycle operation (send, present, sign, restore, an "Edit manually"
 * override) wraps its body in withDocumentChange; every save inside it lands
 * in one revision with that cut. The outermost operation names the cut: a
 * send that takes a snapshot is a send. A change scoped to one document does
 * not leak into saves of another (an invoice created on send keeps its own).
 * See docs/architecture/document-history.md.
 */

export type DocumentChange = {
  cut: string;
  /** Shown with the revision, e.g. a named version or "Restored revision 4". */
  label?: string;
  /** Limit the change to saves of this document. */
  documentId?: string;
  /** The signed-in person doing it, when there is one. */
  userId?: string;
  /** Who did it when they are not a user (a signer's name, "Customer"). */
  actorLabel?: string;
  attributes?: Record<string, unknown>;
  /** Store this revision's state whole. */
  checkpoint?: boolean;
  operationId: string;
};

const changes = new AsyncLocalStorage<DocumentChange>();

export function withDocumentChange<T>(change: Omit<DocumentChange, "operationId"> & { operationId?: string }, run: () => Promise<T>): Promise<T> {
  const outer = changes.getStore();
  if (outer && (!outer.documentId || !change.documentId || outer.documentId === change.documentId)) {
    const kept = Object.fromEntries(Object.entries(outer).filter(([, value]) => value !== undefined && value !== ""));
    return changes.run({ ...change, ...kept, attributes: { ...(change.attributes || {}), ...(outer.attributes || {}) } } as DocumentChange, run);
  }
  return changes.run({ ...change, operationId: change.operationId || randomUUID() }, run);
}

/** The change a save of this document belongs to, if any. */
export function currentDocumentChange(documentId: string): DocumentChange | null {
  const change = changes.getStore();
  if (!change) return null;
  return !change.documentId || change.documentId === documentId ? change : null;
}
