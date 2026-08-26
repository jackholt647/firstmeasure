import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { FastifyInstance } from "fastify";

import { runLegacyPlatformMigration, type MigrationReport } from "./legacy_migration.js";

type JsonObject = Record<string, unknown>;

export type CutoverSimulationOptions = {
  sourceRoot: string;
  targetRoot: string;
  confirmFresh?: boolean;
  runtimeSmoke?: boolean;
  firstmeasureStorageRoot?: string;
  firstmeasureIndexDbPath?: string;
  pricebookStorageRoot?: string;
  canvassingStorageRoot?: string;
};

export type CutoverSmokeCheck = {
  name: string;
  ok: boolean;
  statusCode?: number;
  detail?: string;
};

export type CutoverStorageCounts = {
  organizations: number;
  globals: number;
  branches: number;
  identities: number;
  email_indexes: number;
  org_users: number;
};

export type CutoverSimulationReport = {
  ok: boolean;
  sourceRoot: string;
  targetRoot: string;
  migration: MigrationReport;
  storage: CutoverStorageCounts;
  smoke: {
    skipped: boolean;
    checks: CutoverSmokeCheck[];
  };
};

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

async function pathExists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath: string) {
  return JSON.parse(await readFile(filePath, "utf8")) as JsonObject;
}

async function countJsonFiles(dirPath: string) {
  if (!(await pathExists(dirPath))) return 0;
  let count = 0;
  for (const entry of await readdir(dirPath, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json")) count += 1;
  }
  return count;
}

async function countMigratedStorage(targetRoot: string): Promise<CutoverStorageCounts> {
  const organizationsDir = path.join(targetRoot, "organizations");
  let organizations = 0;
  let globals = 0;
  let branches = 0;
  let orgUsers = 0;

  if (await pathExists(organizationsDir)) {
    for (const entry of await readdir(organizationsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const orgRoot = path.join(organizationsDir, entry.name);
      if (await pathExists(path.join(orgRoot, "manifest.json"))) organizations += 1;
      if (await pathExists(path.join(orgRoot, "global.json"))) globals += 1;
      branches += await countJsonFiles(path.join(orgRoot, "branch"));
      orgUsers += await countJsonFiles(path.join(orgRoot, "users"));
    }
  }

  return {
    organizations,
    globals,
    branches,
    identities: await countJsonFiles(path.join(targetRoot, "identities")),
    email_indexes: await countJsonFiles(path.join(targetRoot, "auth_index", "email")),
    org_users: orgUsers
  };
}

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = values.find((value) => value.startsWith(`${name}=`));
  return match?.split(";")[0] || "";
}

function createSessionClient(app: FastifyInstance, checks: CutoverSmokeCheck[]) {
  let cookie = "";
  let csrf = "";
  const request = async (name: string, method: string, url: string, payload?: unknown) => {
    const response = await (app.inject as any)({
      method,
      url,
      payload,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {})
      }
    });
    const setCookie = response.headers["set-cookie"];
    const sessionCookie = readCookie(setCookie, "fm_platform_session");
    const csrfCookie = readCookie(setCookie, "fm_platform_session_csrf");
    if (sessionCookie || csrfCookie) {
      cookie = [
        sessionCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session=")) || "",
        csrfCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session_csrf=")) || ""
      ].filter(Boolean).join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    let json: JsonObject | null = null;
    try {
      json = response.body ? JSON.parse(response.body) as JsonObject : null;
    } catch {
      json = null;
    }
    const ok = response.statusCode >= 200 && response.statusCode < 400;
    checks.push({
      name,
      ok,
      statusCode: response.statusCode,
      detail: ok ? undefined : response.body.slice(0, 500)
    });
    if (!ok) throw new Error(`${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return json;
  };
  return { request };
}

function setRuntimeEnv(options: Required<Pick<CutoverSimulationOptions, "targetRoot">> & CutoverSimulationOptions) {
  const targetRoot = path.resolve(options.targetRoot);
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = targetRoot;
  process.env.FIRSTMEASURE_STORAGE_ROOT = options.firstmeasureStorageRoot || path.join(targetRoot, "..", "firstmeasure-cutover-smoke");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = options.firstmeasureIndexDbPath || path.join(process.env.FIRSTMEASURE_STORAGE_ROOT, "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = options.pricebookStorageRoot || path.join(targetRoot, "..", "pricebook-cutover-smoke");
  process.env.CANVASSING_STORAGE_ROOT = options.canvassingStorageRoot || path.join(targetRoot, "..", "canvassing-cutover-smoke");
  process.env.V1_LOG_LEVEL = process.env.V1_LOG_LEVEL || "error";
}

async function runRuntimeSmoke(options: CutoverSimulationOptions): Promise<CutoverSmokeCheck[]> {
  setRuntimeEnv({ ...options, targetRoot: options.targetRoot });
  const checks: CutoverSmokeCheck[] = [];
  let app: FastifyInstance | null = null;
  try {
    const { buildApp } = await import("../src/app.js");
    app = await buildApp();
    await app.ready();

    const ping = await (app.inject as any)({ method: "GET", url: "/v1/platform/ping" });
    checks.push({ name: "platform ping", ok: ping.statusCode === 200, statusCode: ping.statusCode, detail: ping.statusCode === 200 ? undefined : ping.body.slice(0, 500) });
    if (ping.statusCode !== 200) throw new Error(`GET /v1/platform/ping failed: ${ping.statusCode} ${ping.body}`);

    const suffix = Date.now().toString(36);
    const owner = createSessionClient(app, checks);
    const registered = await owner.request("register smoke owner", "POST", "/v1/platform/auth/register", {
      email: `cutover-owner-${suffix}@example.test`,
      password: "cutover-smoke-password",
      name: "Cutover Smoke Owner",
      company: "Cutover Smoke Roofing",
      global: {
        credits_balance: 20,
        credits_ledger: [{ ts: new Date().toISOString(), delta: 20, reason: "cutover_smoke_seed" }]
      }
    });
    const orgId = String(asObject(registered?.organization).id || "");
    if (!orgId) throw new Error("Smoke registration did not return an organization id.");

    const session = await owner.request("session after register", "GET", "/v1/platform/auth/session");
    if (session?.authenticated !== true) throw new Error("Smoke session was not authenticated after register.");

    const me = await owner.request("me after register", "GET", "/v1/platform/me");
    if (String(asObject(me?.organization).id || "") !== orgId) throw new Error("Smoke /me returned a different organization.");

    const portalState = await owner.request("portal state", "GET", `/v1/platform/organizations/${orgId}/portal-state`);
    if (Number(asObject(portalState?.credits).balance) !== 20) throw new Error("Smoke portal state did not return seeded credits.");

    const charged = await owner.request("credit charge", "POST", `/v1/platform/organizations/${orgId}/credits/charge`, {
      amount: 3,
      reason: "cutover_smoke_charge"
    });
    if (Number(charged?.balance) !== 17) throw new Error("Smoke credit charge returned the wrong balance.");

    const refunded = await owner.request("credit refund", "POST", `/v1/platform/organizations/${orgId}/credits/refund`, {
      amount: 1,
      reason: "cutover_smoke_refund"
    });
    if (Number(refunded?.balance) !== 18) throw new Error("Smoke credit refund returned the wrong balance.");

    const created = await owner.request("create org user", "POST", `/v1/platform/organizations/${orgId}/users`, {
      data: {
        email: `cutover-manager-${suffix}@example.test`,
        password: "cutover-manager-password",
        name: "Cutover Smoke Manager",
        status: "active",
        role: "manager",
        permissions: { manage_billing: true, manage_company_users: true, order_reports: true }
      }
    });
    if (String(asObject(asObject(created?.document).data).email || "") === "") throw new Error("Smoke org-user create did not return user data.");

    const manager = createSessionClient(app, checks);
    const login = await manager.request("login created org user", "POST", "/v1/platform/auth/login", {
      email: `cutover-manager-${suffix}@example.test`,
      password: "cutover-manager-password",
      organization_id: orgId
    });
    if (asObject(login?.membership).organization_id !== orgId) throw new Error("Smoke manager login returned the wrong membership.");
  } finally {
    if (app) await app.close();
  }
  return checks;
}

export async function runPlatformCutoverSimulation(options: CutoverSimulationOptions): Promise<CutoverSimulationReport> {
  const sourceRoot = path.resolve(options.sourceRoot);
  const targetRoot = path.resolve(options.targetRoot);
  const migration = await runLegacyPlatformMigration({
    sourceRoot,
    targetRoot,
    mode: "fresh",
    confirmFresh: options.confirmFresh
  });
  const storage = await countMigratedStorage(targetRoot);

  let smokeChecks: CutoverSmokeCheck[] = [];
  if (migration.ok && options.runtimeSmoke !== false) {
    try {
      smokeChecks = await runRuntimeSmoke({ ...options, sourceRoot, targetRoot });
    } catch (error) {
      smokeChecks.push({
        name: "runtime smoke aborted",
        ok: false,
        detail: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const storageOk = storage.organizations >= Number(migration.counts.platform_orgs_expected || 0)
    && storage.identities >= Number(migration.counts.platform_identities_expected || 0)
    && storage.org_users >= Number(migration.counts.platform_org_users_expected || 0);
  const smokeOk = options.runtimeSmoke === false || smokeChecks.every((check) => check.ok);

  return {
    ok: migration.ok && storageOk && smokeOk,
    sourceRoot,
    targetRoot,
    migration,
    storage,
    smoke: {
      skipped: options.runtimeSmoke === false,
      checks: smokeChecks
    }
  };
}
