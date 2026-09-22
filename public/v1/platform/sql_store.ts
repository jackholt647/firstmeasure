import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { PoolClient, QueryResultRow } from "pg";
import { isFirstMeasurePostgresEnabled, queryPostgres, withPostgresTransaction, withPlatformPostgresClient } from "../src/database/postgres.js";

const openStores = new Set<SqlStore>();
type Row = Record<string, unknown>;
type SqlResult = { rows: Row[]; changes: number; lastInsertRowid: number | bigint };
const transactions = new AsyncLocalStorage<{ client?: PoolClient; sqlite?: Set<DatabaseSync>; schemas?: Map<SqlStore, Promise<void>>; committed?: Array<() => void> }>();

/** Convert positional bindings only. SQL dialect differences must be explicit at each call site. */
export function postgresBindings(sql: string) {
  let index = 0;
  return sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|\?/g,
    token => token === "?" ? `$${++index}` : token);
}

export interface SqlStore {
  readonly isPostgres: boolean;
  prepare(sql: string, postgresSql?: string): {
    all(...values: SQLInputValue[]): Promise<Row[]>;
    get(...values: SQLInputValue[]): Promise<Row | undefined>;
    run(...values: SQLInputValue[]): Promise<{ changes: number; lastInsertRowid: number | bigint }>;
  };
  exec(sql: string): Promise<void>;
  transaction<T>(operation: (db: SqlStore) => T | Promise<T>, lockKey?: string): Promise<T>;
  close(): Promise<void>;
}

/** Async stores share FirstMeasure's bounded pool; SQLite remains an explicit local backend. */
export function openSqlStore(options: {
  id: string;
  filename: string;
  schemaVersion?: number;
  initialize: (db: SqlStore) => Promise<void>;
}): SqlStore {
  const isPostgres = isFirstMeasurePostgresEnabled();
  let sqlite: DatabaseSync | undefined;
  let ready: Promise<void> | undefined;
  let initialized = false;
  let queue = Promise.resolve();
  let closed = false;
  if (!isPostgres) {
    mkdirSync(path.dirname(options.filename), { recursive: true });
    sqlite = new DatabaseSync(options.filename);
    sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  }
  async function serialized<T>(operation: () => T | Promise<T>): Promise<T> {
    if (sqlite && transactions.getStore()?.sqlite?.has(sqlite)) return operation();
    const previous = queue;
    let release!: () => void;
    queue = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
  async function execute(sql: string, values?: SQLInputValue[]): Promise<SqlResult> {
    if (closed) throw new Error(`SQL store ${options.id} is closed.`);
    if (isPostgres) {
      const client = transactions.getStore()?.client;
      const result = client
        ? await client.query<QueryResultRow>(values ? postgresBindings(sql) : sql, values)
        : await queryPostgres(values ? postgresBindings(sql) : sql, values);
      // Multi-statement schema queries return an array, with no row result needed.
      if (Array.isArray(result)) return { rows: [], changes: 0, lastInsertRowid: 0 };
      return { rows: result.rows, changes: result.rowCount || 0, lastInsertRowid: 0 };
    }
    return serialized(() => {
      if (!values) { sqlite!.exec(sql); return { rows: [], changes: 0, lastInsertRowid: 0 }; }
      const statement = sqlite!.prepare(sql);
      if (statement.columns().length) return { rows: statement.all(...values), changes: 0, lastInsertRowid: 0 };
      const result = statement.run(...values);
      return { rows: [], changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
    });
  }
  async function inTransaction<T>(operation: (db: SqlStore) => T | Promise<T>, db: SqlStore, lockKey?: string): Promise<T> {
    if (isPostgres) {
      const current = transactions.getStore()?.client;
      if (current) {
        await current.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`platform-store:${options.id}${lockKey === undefined ? "" : ":" + lockKey}`]);
        return operation(db);
      }
      const committed: Array<() => void> = [];
      const result = await withPostgresTransaction(async client => withPlatformPostgresClient(client, () =>
        transactions.run({ client, schemas: new Map(), committed }, async () => {
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`platform-store:${options.id}${lockKey === undefined ? "" : ":" + lockKey}`]);
          return operation(db);
        })));
      for (const finish of committed) finish();
      return result;
    }
    if (sqlite && transactions.getStore()?.sqlite?.has(sqlite)) return operation(db);
    return serialized(async () => transactions.run({ sqlite: new Set([...(transactions.getStore()?.sqlite || []), sqlite!]) }, async () => {
      sqlite!.exec("BEGIN IMMEDIATE");
      try { const result = await operation(db); sqlite!.exec("COMMIT"); return result; }
      catch (error) { sqlite!.exec("ROLLBACK"); throw error; }
    }));
  }
  function interfaceFor(initialize: boolean): SqlStore {
    const ensure = async () => {
      if (!initialize) return;
      const initializeSchema = async (raw: SqlStore) => {
        if (isPostgres) {
          await execute("SELECT pg_advisory_xact_lock(hashtext(?))", ["platform-sql-schema-registry"]);
          const registry = await execute("SELECT to_regclass('platform_sql_schemas') AS name", []);
          if (!registry.rows[0]?.name) await execute(`CREATE TABLE platform_sql_schemas (store_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL)`);
          const version = await execute("SELECT schema_version FROM platform_sql_schemas WHERE store_id=?", [options.id]);
          if (Number(version.rows[0]?.schema_version || 0) >= (options.schemaVersion || 1)) return;
        }
        await options.initialize(raw);
        if (isPostgres) await execute(`INSERT INTO platform_sql_schemas(store_id,schema_version) VALUES(?,?)
          ON CONFLICT(store_id) DO UPDATE SET schema_version=excluded.schema_version`, [options.id, options.schemaVersion || 1]);
      };
      const context = transactions.getStore();
      if (!initialized && isPostgres && context?.client) {
        // A store first opened inside another transaction must not announce a
        // usable schema before that transaction commits (it may roll back).
        let pending = context.schemas!.get(db);
        if (!pending) {
          pending = inTransaction(initializeSchema, raw);
          context.schemas!.set(db, pending);
          context.committed!.push(() => { initialized = true; ready = Promise.resolve(); });
        }
        await pending;
        return;
      }
      ready ??= inTransaction(initializeSchema, raw).then(() => { initialized = true; }).catch(error => { ready = undefined; throw error; });
      await ready;
    };
    const db: SqlStore = {
      isPostgres,
      prepare(sql, postgresSql) {
        const query = isPostgres && postgresSql !== undefined ? postgresSql : sql;
        const run = async (values: SQLInputValue[]) => { await ensure(); return execute(query, values); };
        return {
          all: async (...values) => (await run(values)).rows,
          get: async (...values) => (await run(values)).rows[0],
          run: async (...values) => { const result = await run(values); return { changes: result.changes, lastInsertRowid: result.lastInsertRowid }; }
        };
      },
      exec: async sql => { await ensure(); await execute(sql); },
      transaction: async (operation, lockKey) => { await ensure(); return inTransaction(operation, db, lockKey); },
      close: async () => { if (closed) return; if (ready) await ready.catch(() => undefined); await queue; if (closed) return; closed = true; openStores.delete(db); sqlite?.close(); }
    };
    return db;
  }
  const raw = interfaceFor(false);
  const db = interfaceFor(true);
  openStores.add(db);
  return db;
}

export async function ensureSqlColumn(db: SqlStore, table: string, column: string, declaration: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(table) || !/^[a-z_][a-z0-9_]*$/.test(column)) throw new Error("Invalid SQL migration identifier.");
  if (db.isPostgres) await db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${declaration}`);
  else if (!(await db.prepare(`PRAGMA table_info(${table})`).all()).some(row => row.name === column)) {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  }
}

/** Terminal process shutdown: release every shared store and local SQLite handle. */
export async function closeSqlStores() {
  await Promise.all([...openStores].map(async db => (await db.close())));
}

export const closeSqlStoresForTests = closeSqlStores;
