import pg, { type Pool, type PoolClient, type PoolConfig, type QueryResultRow } from "pg";
import { readFileSync } from "node:fs";
import path from "node:path";

import { env } from "../config/env.js";

const { Pool: PgPool } = pg;

let applicationPool: Pool | null = null;
let adminPool: Pool | null = null;
let bootstrapPromise: Promise<{ appUser: string; database: string; grantsAttempted: boolean }> | null = null;

const SSL_CONNECTION_PARAMETERS = [
  "ssl", "sslmode", "sslcert", "sslkey", "sslrootcert", "sslnegotiation", "uselibpqcompat"
] as const;

export function connectionStringWithExternalTlsConfig(connectionString: string) {
  if (!env.databaseCaCertPath.trim()) return connectionString;
  const parsed = new URL(connectionString);
  for (const name of SSL_CONNECTION_PARAMETERS) parsed.searchParams.delete(name);
  return parsed.toString();
}

export function isFirstMeasurePostgresEnabled() {
  return env.firstmeasureDatabaseMode === "postgres";
}

function poolConfig(connectionString: string, max: number): PoolConfig {
  const config: PoolConfig = {
    // pg parses connectionString after the surrounding config and lets URL SSL
    // parameters overwrite config.ssl. Remove them when a pinned CA is supplied.
    connectionString: connectionStringWithExternalTlsConfig(connectionString),
    max,
    connectionTimeoutMillis: env.postgresConnectionTimeoutMs,
    idleTimeoutMillis: env.postgresIdleTimeoutMs,
    application_name: `firstmeasure-v1-${process.pid}`,
    options: `-c statement_timeout=${env.postgresStatementTimeoutMs}`
  };
  if (env.databaseCaCertPath.trim()) {
    const certificatePath = path.resolve(process.cwd(), env.databaseCaCertPath);
    config.ssl = {
      ca: readFileSync(certificatePath, "utf8"),
      rejectUnauthorized: true
    };
  }
  return config;
}

export function getPostgresPool(): Pool {
  if (!isFirstMeasurePostgresEnabled()) {
    throw new Error("PostgreSQL is not enabled for FirstMeasure.");
  }
  if (!env.databaseUrl.trim()) {
    throw new Error("FIRSTMEASURE_DATABASE_MODE=postgres requires DATABASE_URL.");
  }
  if (!applicationPool) {
    applicationPool = new PgPool(poolConfig(env.databaseUrl, env.postgresPoolMax));
    applicationPool.on("error", (error) => {
      console.error("Unexpected idle PostgreSQL application connection error", error);
    });
  }
  return applicationPool;
}

export function getPostgresAdminPool(): Pool | null {
  if (!env.databaseAdminUrl.trim()) return null;
  if (!adminPool) {
    adminPool = new PgPool(poolConfig(env.databaseAdminUrl, 1));
    adminPool.on("error", (error) => {
      console.error("Unexpected idle PostgreSQL administrator connection error", error);
    });
  }
  return adminPool;
}

export async function queryPostgres<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = []
) {
  return getPostgresPool().query<T>(text, values);
}

export async function withPostgresClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPostgresPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function withPostgresTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withPostgresClient(async (client) => {
    await client.query("BEGIN");
    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });
}

function quoteIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

export function bootstrapPostgresApplicationUser() {
  bootstrapPromise ??= performPostgresApplicationUserBootstrap().catch((error) => {
    bootstrapPromise = null;
    throw error;
  });
  return bootstrapPromise;
}

async function performPostgresApplicationUserBootstrap() {
  const appPool = getPostgresPool();
  const appIdentity = await appPool.query<{ current_user: string; current_database: string }>(
    "SELECT current_user, current_database() AS current_database"
  );
  const appUser = String(appIdentity.rows[0]?.current_user ?? "");
  const database = String(appIdentity.rows[0]?.current_database ?? "");
  if (!appUser || !database) throw new Error("Could not resolve the PostgreSQL application identity.");

  // Only the first clustered process performs deployment-time grants. Opening
  // an administrator pool in every web worker wastes scarce managed-Postgres
  // connections and can cause a connection storm during a 44-worker restart.
  const clusterWorkerId = String(process.env.V1_CLUSTER_WORKER ?? "").trim();
  if (clusterWorkerId && clusterWorkerId !== "1") {
    return { appUser, database, grantsAttempted: false };
  }

  const admin = getPostgresAdminPool();
  if (!admin) return { appUser, database, grantsAttempted: false };
  try {
    const adminIdentity = await admin.query<{ current_user: string; current_database: string }>(
      "SELECT current_user, current_database() AS current_database"
    );
    if (String(adminIdentity.rows[0]?.current_user ?? "") === appUser) {
      return { appUser, database, grantsAttempted: false };
    }
    const adminDatabase = String(adminIdentity.rows[0]?.current_database ?? "");
    if (adminDatabase !== database) {
      throw new Error(
        `DATABASE_ADMIN_URL connects to database '${adminDatabase}', but DATABASE_URL connects to '${database}'. ` +
        "Select the firstmeasure database for both DigitalOcean connection strings."
      );
    }

    await admin.query(`GRANT CONNECT, TEMPORARY ON DATABASE ${quoteIdentifier(database)} TO ${quoteIdentifier(appUser)}`);
    await admin.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${quoteIdentifier(appUser)}`);
    return { appUser, database, grantsAttempted: true };
  } finally {
    adminPool = null;
    await admin.end().catch(() => undefined);
  }
}

export async function closePostgresPools() {
  const pools = [applicationPool, adminPool].filter((pool): pool is Pool => Boolean(pool));
  applicationPool = null;
  adminPool = null;
  bootstrapPromise = null;
  await Promise.all(pools.map((pool) => pool.end()));
}
