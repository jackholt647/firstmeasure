import type { PoolClient, QueryResultRow } from "pg";

import { bootstrapPostgresApplicationUser, queryPostgres, withPostgresClient, withPostgresTransaction } from "./postgres.js";

export type SharedDocumentKey = {
  namespace: string;
  scope?: string;
  collection: string;
  id: string;
};

type DocumentRow = QueryResultRow & { document: unknown };
type MutateOptions<T> = {
  create?: () => T;
  missing?: () => never;
};

let readyPromise: Promise<void> | null = null;

export async function ensureSharedDocumentsReady() {
  readyPromise ??= (async () => {
    await bootstrapPostgresApplicationUser();
    await withPostgresClient(async (client) => {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", ["firstmeasure-shared-documents-v1"]);
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS app_shared_documents (
          namespace TEXT NOT NULL,
          scope TEXT NOT NULL DEFAULT '',
          collection TEXT NOT NULL,
          id TEXT NOT NULL,
          document JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (namespace, scope, collection, id)
        );
        CREATE INDEX IF NOT EXISTS app_shared_documents_list_idx
          ON app_shared_documents(namespace, scope, collection, updated_at DESC, id);
      `);
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", ["firstmeasure-shared-documents-v1"]).catch(() => undefined);
    }
    });
  })().catch((error) => {
    readyPromise = null;
    throw error;
  });
  await readyPromise;
}

function values(key: SharedDocumentKey) {
  return [key.namespace, key.scope ?? "", key.collection, key.id];
}

export async function readSharedDocument<T>(key: SharedDocumentKey): Promise<T | null> {
  await ensureSharedDocumentsReady();
  const result = await queryPostgres<DocumentRow>(`
    SELECT document FROM app_shared_documents
    WHERE namespace=$1 AND scope=$2 AND collection=$3 AND id=$4
  `, values(key));
  return result.rows[0] ? result.rows[0].document as T : null;
}

export async function listSharedDocuments<T>(input: Omit<SharedDocumentKey, "id"> & { limit?: number; allScopes?: boolean }): Promise<T[]> {
  await ensureSharedDocumentsReady();
  const limit = Math.max(1, Math.min(500_000, Math.floor(input.limit ?? 10_000)));
  const result = await queryPostgres<DocumentRow>(`
    SELECT document FROM app_shared_documents
    WHERE namespace=$1 AND collection=$2 ${input.allScopes ? "" : "AND scope=$3"}
    ORDER BY updated_at DESC, id
    LIMIT $${input.allScopes ? 3 : 4}
  `, input.allScopes
    ? [input.namespace, input.collection, limit]
    : [input.namespace, input.collection, input.scope ?? "", limit]);
  return result.rows.map((row) => row.document as T);
}

export async function replaceSharedDocument<T>(key: SharedDocumentKey, document: T): Promise<T> {
  await ensureSharedDocumentsReady();
  await queryPostgres(`
    INSERT INTO app_shared_documents(namespace,scope,collection,id,document)
    VALUES($1,$2,$3,$4,$5::jsonb)
    ON CONFLICT(namespace,scope,collection,id)
    DO UPDATE SET document=EXCLUDED.document, updated_at=now()
  `, [...values(key), JSON.stringify(document)]);
  return document;
}

export async function createSharedDocument<T>(key: SharedDocumentKey, document: T): Promise<boolean> {
  await ensureSharedDocumentsReady();
  const result = await queryPostgres(`
    INSERT INTO app_shared_documents(namespace,scope,collection,id,document)
    VALUES($1,$2,$3,$4,$5::jsonb)
    ON CONFLICT(namespace,scope,collection,id) DO NOTHING
  `, [...values(key), JSON.stringify(document)]);
  return result.rowCount === 1;
}

export async function mutateSharedDocument<T>(
  key: SharedDocumentKey,
  mutate: (current: T) => T | Promise<T>,
  options: MutateOptions<T> = {}
): Promise<T> {
  await ensureSharedDocumentsReady();
  return withPostgresTransaction(async (client) => {
    const current = await lockedRead<T>(client, key);
    const base = current ?? options.create?.();
    if (base === undefined) {
      if (options.missing) options.missing();
      throw new Error(`Shared document not found: ${key.namespace}/${key.scope ?? ""}/${key.collection}/${key.id}`);
    }
    const next = await mutate(base);
    await client.query(`
      INSERT INTO app_shared_documents(namespace,scope,collection,id,document)
      VALUES($1,$2,$3,$4,$5::jsonb)
      ON CONFLICT(namespace,scope,collection,id)
      DO UPDATE SET document=EXCLUDED.document, updated_at=now()
    `, [...values(key), JSON.stringify(next)]);
    return next;
  });
}

export async function deleteSharedDocument<T>(key: SharedDocumentKey): Promise<T | null> {
  await ensureSharedDocumentsReady();
  return withPostgresTransaction(async (client) => {
    const current = await lockedRead<T>(client, key);
    if (current === null) return null;
    await client.query(`DELETE FROM app_shared_documents WHERE namespace=$1 AND scope=$2 AND collection=$3 AND id=$4`, values(key));
    return current;
  });
}

async function lockedRead<T>(client: PoolClient, key: SharedDocumentKey): Promise<T | null> {
  const result = await client.query<DocumentRow>(`
    SELECT document FROM app_shared_documents
    WHERE namespace=$1 AND scope=$2 AND collection=$3 AND id=$4
    FOR UPDATE
  `, values(key));
  return result.rows[0] ? result.rows[0].document as T : null;
}
