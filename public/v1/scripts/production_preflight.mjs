import { access, opendir, readFile } from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { availableParallelism } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_V1_ROOT = path.resolve(SCRIPT_DIR, "..");
const execFileAsync = promisify(execFile);

async function verifyPortalProviderKeyAccess(providerPath, environment) {
  const phpUser = String(environment.FIRSTMEASURE_PHP_USER || "www-data").trim();
  const runuserBinary = String(environment.FIRSTMEASURE_RUNUSER_BINARY || "runuser").trim();
  const phpBinary = String(environment.FIRSTMEASURE_PHP_BINARY || "php").trim();
  const probe = [
    "$raw = @file_get_contents($argv[1]);",
    "if ($raw === false) { fwrite(STDERR, 'provider key file is unreadable'); exit(2); }",
    "$data = json_decode($raw, true);",
    "if (!is_array($data)) { fwrite(STDERR, 'provider key file is invalid JSON'); exit(3); }",
    "$google = is_array($data['google'] ?? null) ? $data['google'] : [];",
    "$key = trim((string)($google['customer_browser_api_key'] ?? $google['browser_api_key'] ?? $google['shared_api_key'] ?? ''));",
    "if ($key === '') { fwrite(STDERR, 'customer browser map key is missing'); exit(4); }"
  ].join(" ");
  try {
    await execFileAsync(runuserBinary, ["-u", phpUser, "--", phpBinary, "-r", probe, providerPath], {
      timeout: 10_000,
      windowsHide: true
    });
    return { ok: true, detail: `provider keys are readable by PHP user ${phpUser}` };
  } catch (error) {
    const detail = String(error?.stderr || error?.message || "PHP runtime access probe failed").trim();
    return { ok: false, detail: detail || `provider keys are not readable by PHP user ${phpUser}` };
  }
}

function parseEnvFile(raw) {
  const values = {};
  for (const sourceLine of raw.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = normalized.indexOf("=");
    if (separator <= 0) continue;
    const name = normalized.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    let value = normalized.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
      if (normalized.slice(separator + 1).trim().startsWith('"')) {
        value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");
      }
    }
    values[name] = value;
  }
  return values;
}

async function readEnvFile(filePath) {
  if (!existsSync(filePath)) return {};
  return parseEnvFile(await readFile(filePath, "utf8"));
}

export async function loadDeploymentEnv(v1Root = DEFAULT_V1_ROOT, overrides = {}) {
  const projectRoot = path.resolve(v1Root, "../..");
  const rootEnv = await readEnvFile(path.join(projectRoot, ".env"));
  const v1Env = await readEnvFile(path.join(v1Root, ".env"));
  return { ...rootEnv, ...v1Env, ...process.env, ...overrides };
}

export function resolveDeploymentProviderKeysPath(v1Root, environment) {
  const explicit = String(environment.PROVIDER_KEYS_PATH ?? "").trim();
  return explicit
    ? path.resolve(v1Root, explicit)
    : path.resolve(v1Root, "../../private/provider-keys.json");
}

function configuredDatabaseMode(environment) {
  const explicit = String(environment.FIRSTMEASURE_DATABASE_MODE ?? "").trim().toLowerCase();
  if (explicit === "postgres" || explicit === "sqlite") return explicit;
  return String(environment.DATABASE_URL ?? "").trim() ? "postgres" : "sqlite";
}

function resolveFromV1(v1Root, value, fallback) {
  return path.resolve(v1Root, String(value ?? "").trim() || fallback);
}

function databaseIdentity(value) {
  try {
    const parsed = new URL(String(value ?? ""));
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return null;
    return {
      database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
      username: decodeURIComponent(parsed.username),
      sslmode: parsed.searchParams.get("sslmode") || ""
    };
  } catch {
    return null;
  }
}

function normalizePhone(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (raw.startsWith("+") && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return "";
}

async function scanProjectManifests(projectsRoot) {
  const stats = { manifests: 0, invalid: 0, duplicate_ids: 0, io_errors: 0 };
  const failures = [];
  const ids = new Set();
  if (!existsSync(projectsRoot)) return { stats, failures: [{ path: projectsRoot, reason: "projects directory is missing" }] };
  const stack = [projectsRoot];
  while (stack.length) {
    const directory = stack.pop();
    try {
      const entries = [];
      const handle = await opendir(directory);
      for await (const entry of handle) entries.push(entry);
      const projectManifest = entries.find((entry) => entry.isFile() && entry.name === "manifest.json");
      if (projectManifest) {
        const manifestPath = path.join(directory, projectManifest.name);
        stats.manifests += 1;
        try {
          const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
          const id = String(manifest?.id ?? "").trim();
          if (!id) throw new Error("manifest id is missing");
          if (ids.has(id)) {
            stats.duplicate_ids += 1;
            throw new Error(`duplicate project id '${id}'`);
          }
          ids.add(id);
        } catch (error) {
          stats.invalid += 1;
          if (failures.length < 20) failures.push({ path: manifestPath, reason: error instanceof Error ? error.message : String(error) });
        }
        // Match the PostgreSQL importer: once a project manifest identifies the
        // project directory, artifact subdirectories are not traversed.
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== "manifest_backups") stack.push(path.join(directory, entry.name));
      }
    } catch (error) {
      stats.io_errors += 1;
      if (failures.length < 20) failures.push({ path: directory, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { stats, failures };
}

async function scanPlatformPhones(platformRoot) {
  const identitiesRoot = path.join(platformRoot, "identities");
  const stats = { identities: 0, with_phone: 0, missing_phone: 0, invalid_phone: 0, duplicate_phone_accounts: 0 };
  const warnings = [];
  if (!existsSync(identitiesRoot)) {
    warnings.push("Platform identities directory does not exist yet; no phone compatibility audit was possible.");
    return { stats, warnings };
  }
  const phones = new Map();
  const handle = await opendir(identitiesRoot);
  for await (const entry of handle) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    stats.identities += 1;
    try {
      const identity = JSON.parse(await readFile(path.join(identitiesRoot, entry.name), "utf8"));
      const rawPhone = String(identity?.phone_normalized || identity?.phone || "").trim();
      if (!rawPhone) {
        stats.missing_phone += 1;
        continue;
      }
      const phone = normalizePhone(rawPhone);
      if (!phone) {
        stats.invalid_phone += 1;
        continue;
      }
      stats.with_phone += 1;
      phones.set(phone, (phones.get(phone) || 0) + 1);
    } catch {
      stats.invalid_phone += 1;
    }
  }
  stats.duplicate_phone_accounts = [...phones.values()].filter((count) => count > 1).reduce((sum, count) => sum + count, 0);
  if (stats.missing_phone) warnings.push(`${stats.missing_phone} existing identities have no phone; they can still recover by email.`);
  if (stats.invalid_phone) warnings.push(`${stats.invalid_phone} identities have unreadable or invalid phone data.`);
  if (stats.duplicate_phone_accounts) warnings.push(`${stats.duplicate_phone_accounts} identities share duplicate phone numbers; phone login/reset will reject those ambiguous matches.`);
  return { stats, warnings };
}

async function databaseConnectivity(environment, caCertificate) {
  const imported = await import("pg");
  const Client = imported.default?.Client || imported.Client;
  const connect = async (connectionString) => {
    const parsedConnection = new URL(connectionString);
    for (const name of ["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert", "sslnegotiation", "uselibpqcompat"]) {
      parsedConnection.searchParams.delete(name);
    }
    const client = new Client({
      connectionString: parsedConnection.toString(),
      ssl: { ca: caCertificate, rejectUnauthorized: true },
      connectionTimeoutMillis: Number(environment.POSTGRES_CONNECTION_TIMEOUT_MS || 10_000)
    });
    try {
      await client.connect();
      const result = await client.query("SELECT current_database() AS database, current_user AS username, current_setting('server_version') AS version");
      return result.rows[0] || {};
    } finally {
      await client.end().catch(() => undefined);
    }
  };
  const application = await connect(environment.DATABASE_URL);
  const adminUrl = String(environment.DATABASE_ADMIN_URL || "").trim();
  if (!adminUrl) {
    return { server_version: String(application.version || ""), database_match: true, separate_users: null };
  }
  const administrator = await connect(adminUrl);
  if (String(application.database) !== String(administrator.database)) throw new Error("Application and administrator URLs connect to different databases.");
  if (String(application.username) === String(administrator.username)) throw new Error("Application and administrator URLs use the same database account.");
  return { server_version: String(application.version || ""), database_match: true, separate_users: true };
}

export async function runProductionPreflight(options = {}) {
  const v1Root = path.resolve(options.v1Root || DEFAULT_V1_ROOT);
  const environment = await loadDeploymentEnv(v1Root, options.envOverrides || {});
  const checkDatabase = options.checkDatabase !== false;
  const checks = [];
  const warnings = [];
  const stats = {};
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: String(detail || "") });

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  check("node_version", nodeMajor >= 22, nodeMajor >= 22 ? "Node.js 22 or newer" : "Node.js 22 or newer is required");
  check("v1_root", existsSync(path.join(v1Root, "package.json")), "v1 package root found");

  const port = Number(environment.V1_PORT || 3101);
  check("production_port", port === 3101 || environment.FIRSTMEASURE_ALLOW_NONSTANDARD_PORT === "1", `resolved port ${port}`);

  const mode = configuredDatabaseMode(environment);
  const topology = String(environment.DEPLOYMENT_TOPOLOGY || "single").trim().toLowerCase();
  const nodeRole = String(environment.CLUSTER_NODE_ROLE || "web").trim().toLowerCase();
  const autoMigrate = !/^(0|false|no|off)$/i.test(String(environment.POSTGRES_AUTO_MIGRATE ?? "true"));
  const adminRequired = autoMigrate;
  check("database_mode", mode === "postgres", `resolved mode ${mode}`);
  const applicationDb = databaseIdentity(environment.DATABASE_URL);
  const administratorDb = databaseIdentity(environment.DATABASE_ADMIN_URL);
  check("database_application_url", Boolean(applicationDb?.database && applicationDb?.username), "application PostgreSQL URL is configured");
  check("database_admin_url", !adminRequired || Boolean(administratorDb?.database && administratorDb?.username), adminRequired ? "administrator PostgreSQL URL is configured" : "administrator URL is optional after cluster schema migration");
  check("database_targets_match", !administratorDb || Boolean(applicationDb && applicationDb.database === administratorDb.database), "configured URLs select the same database");
  check("database_users_separate", !administratorDb || Boolean(applicationDb && applicationDb.username !== administratorDb.username), "configured application and administrator accounts are distinct");

  if (topology === "cluster") {
    const artifactMode = String(environment.FIRSTMEASURE_ARTIFACT_STORAGE || "").trim().toLowerCase();
    check("cluster_artifact_mode", artifactMode === "spaces", `resolved artifact mode ${artifactMode || "unset"}`);
    check("cluster_spaces_configuration", ["SPACES_ENDPOINT", "SPACES_REGION", "SPACES_BUCKET", "SPACES_ACCESS_KEY_ID", "SPACES_SECRET_ACCESS_KEY"].every((name) => String(environment[name] || "").trim()), "private Spaces endpoint, bucket, region, and credentials are configured");
    const sessionSecret = String(environment.PLATFORM_SESSION_SECRET || "").trim();
    check("cluster_session_secret", sessionSecret.length >= 32 && !sessionSecret.includes("local-dev"), "shared platform session secret is non-default");
    check("cluster_release_id", Boolean(String(environment.RELEASE_ID || "").trim()) && String(environment.RELEASE_ID).trim() !== "development", "immutable release identifier is configured");
    check("cluster_instance_id", Boolean(String(environment.INSTANCE_ID || environment.DROPLET_ID || "").trim()), "unique instance identifier is configured");
    if (nodeRole === "web") {
      check("cluster_legacy_proxy", Boolean(String(environment.LEGACY_SERVICE_URL || "").trim() && String(environment.LEGACY_PROXY_SECRET || "").trim()), "legacy state service and shared proxy secret are configured");
    }
    const processRole = String(environment.FIRSTMEASURE_PROCESS_ROLE || (nodeRole === "worker" ? "worker" : "web")).trim().toLowerCase();
    check("cluster_process_role", nodeRole === "worker" ? processRole === "worker" : processRole === "web", `${nodeRole} node resolves background role ${processRole}`);
  }
  const availableCpus = Math.max(1, availableParallelism());
  const configuredWorkers = Number.parseInt(String(environment.V1_WEB_WORKERS ?? ""), 10);
  const webWorkers = Number.isFinite(configuredWorkers) && configuredWorkers > 0
    ? Math.min(availableCpus, configuredWorkers)
    : Math.max(1, Math.min(44, availableCpus - 1));
  const poolMax = Math.max(1, Number.parseInt(String(environment.POSTGRES_POOL_MAX || "1"), 10) || 1);
  const connectionLimit = Math.max(1, Number.parseInt(String(environment.POSTGRES_CONNECTION_LIMIT || "97"), 10) || 97);
  const reservedConnections = Math.max(5, Number.parseInt(String(environment.POSTGRES_RESERVED_CONNECTIONS || "10"), 10) || 10);
  const connectionProcesses = topology === "cluster" && nodeRole !== "web" ? 1 : webWorkers;
  const projectedConnections = connectionProcesses * poolMax;
  check(
    "database_connection_budget",
    projectedConnections <= Math.max(1, connectionLimit - reservedConnections),
    `${connectionProcesses} ${nodeRole === "web" ? "web workers" : "service process"} x pool ${poolMax} = ${projectedConnections} projected connections (limit ${connectionLimit}, reserve ${reservedConnections})`
  );

  const caPath = resolveFromV1(v1Root, environment.DATABASE_CA_CERT_PATH, "");
  let caCertificate = "";
  try {
    await access(caPath, fsConstants.R_OK);
    caCertificate = await readFile(caPath, "utf8");
  } catch {
    // Reported by the check below without leaking the supplied path.
  }
  check("database_ca_certificate", caCertificate.includes("BEGIN CERTIFICATE"), "readable DigitalOcean CA certificate");

  const providerPath = resolveDeploymentProviderKeysPath(v1Root, environment);
  let providerKeys = {};
  try {
    await access(providerPath, fsConstants.R_OK);
    providerKeys = JSON.parse(await readFile(providerPath, "utf8"));
    check("provider_keys_file", true, "private provider file is readable JSON");
  } catch {
    check("provider_keys_file", false, "private/provider-keys.json is missing or invalid");
  }
  const google = providerKeys?.google || {};
  const hasGoogleServerKey = Boolean(String(google.server_api_key || google.shared_api_key || "").trim());
  const hasGoogleCustomerBrowserKey = Boolean(String(google.customer_browser_api_key || google.browser_api_key || google.shared_api_key || "").trim());
  check("google_server_credentials", hasGoogleServerKey, "Google server/Solar credential is configured privately");
  check("google_customer_browser_credentials", hasGoogleCustomerBrowserKey, "Google customer browser/Maps credential is configured privately");
  if (options.checkPhpRuntime !== false && process.platform !== "win32") {
    const phpAccess = await verifyPortalProviderKeyAccess(providerPath, environment);
    check("provider_keys_php_access", phpAccess.ok, phpAccess.detail);
  } else {
    check("provider_keys_php_access", true, "PHP runtime access probe skipped outside Linux production preflight");
  }
  check("internal_api_secret", Boolean(String(providerKeys?.application?.internal_api_secret || environment.FIRSTMEASURE_INTERNAL_API_SECRET || "").trim()), "internal service secret is configured");
  const publicRoot = path.resolve(v1Root, "..");
  const providerRelativeToPublic = path.relative(publicRoot, path.resolve(providerPath));
  const providerIsOutsidePublic = providerRelativeToPublic.startsWith(`..${path.sep}`) || path.isAbsolute(providerRelativeToPublic);
  check("provider_keys_private", providerIsOutsidePublic, "provider credentials are outside the public web root");

  const googleOAuthClientId = String(environment.GOOGLE_AUTH_CLIENT_ID || "559396801204-jnlgd52pr4q45li0tp8lda4jakqg8ccu.apps.googleusercontent.com").trim();
  check("google_oauth_client", /\.apps\.googleusercontent\.com$/.test(googleOAuthClientId), "Google OAuth client ID is configured");
  check("telnyx_verify", Boolean(String(environment.TELNYX_API_KEY || "").trim() && String(environment.TELNYX_VERIFY_PROFILE_ID || "").trim()), "Telnyx API key and Verify profile are configured");

  const stripeTestMode = /^(1|true)$/i.test(String(environment.STRIPE_TEST_MODE || ""));
  const stripeKey = String(environment.STRIPE_SECRET_KEY || (stripeTestMode ? environment.STRIPE_TEST_SECRET_KEY : environment.STRIPE_LIVE_SECRET_KEY) || "").trim();
  const stripeWebhook = String(environment.STRIPE_WEBHOOK_SECRET || (stripeTestMode ? environment.STRIPE_TEST_WEBHOOK_SECRET : environment.STRIPE_LIVE_WEBHOOK_SECRET) || "").trim();
  check("stripe_secret", Boolean(stripeKey), "active Stripe credential is configured as a deployment secret");
  check("stripe_webhook_secret", Boolean(stripeWebhook), "active Stripe webhook credential is configured as a deployment secret");

  const firstMeasureRoot = resolveFromV1(v1Root, environment.FIRSTMEASURE_STORAGE_ROOT, "./storage/firstmeasure");
  const projectScan = await scanProjectManifests(path.join(firstMeasureRoot, "projects"));
  stats.projects = projectScan.stats;
  check("project_manifests", topology === "cluster" || projectScan.stats.manifests > 0,
    topology === "cluster" ? `${projectScan.stats.manifests} local manifests found; PostgreSQL is authoritative in cluster mode` : `${projectScan.stats.manifests} project manifests found`);
  const invalidManifestLimit = Math.max(0, Number.parseInt(String(
    environment.POSTGRES_IMPORT_MAX_INVALID_MANIFESTS ?? (mode === "postgres" ? "100" : "0")
  ), 10) || 0);
  const projectIntegrityOk = projectScan.stats.io_errors === 0
    && projectScan.stats.duplicate_ids === 0
    && projectScan.stats.invalid <= invalidManifestLimit;
  check(
    "project_manifest_integrity",
    projectIntegrityOk,
    projectScan.stats.invalid
      ? `${projectScan.stats.invalid} invalid manifest(s); importer limit ${invalidManifestLimit}`
      : "all manifests are readable with unique ids"
  );
  if (projectIntegrityOk && projectScan.stats.invalid) {
    warnings.push(
      `${projectScan.stats.invalid} invalid legacy project manifest(s) will be skipped and preserved during PostgreSQL import.`
    );
  }

  const platformRoot = resolveFromV1(v1Root, environment.PLATFORM_STORAGE_ROOT, "./storage/platform");
  const phoneScan = await scanPlatformPhones(platformRoot);
  stats.phones = phoneScan.stats;
  warnings.push(...phoneScan.warnings);

  if (checkDatabase && checks.every((entry) => entry.ok)) {
    try {
      stats.database = await databaseConnectivity(environment, caCertificate);
      check("database_connectivity", true, "application and administrator TLS connections succeeded");
    } catch (error) {
      check("database_connectivity", false, error instanceof Error ? error.message : String(error));
    }
  } else if (!checkDatabase) {
    checks.push({ name: "database_connectivity", ok: true, detail: "skipped for offline preflight" });
  }

  return { ok: checks.every((entry) => entry.ok), checks, warnings, stats };
}

function printReport(report, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`FirstMeasure production preflight: ${report.ok ? "PASS" : "FAIL"}\n`);
  for (const item of report.checks) process.stdout.write(`${item.ok ? "PASS" : "FAIL"} ${item.name}: ${item.detail}\n`);
  for (const warning of report.warnings) process.stdout.write(`WARN ${warning}\n`);
  if (report.stats.projects) process.stdout.write(`INFO projects=${report.stats.projects.manifests} invalid=${report.stats.projects.invalid} duplicates=${report.stats.projects.duplicate_ids}\n`);
  if (report.stats.phones) process.stdout.write(`INFO identities=${report.stats.phones.identities} phones=${report.stats.phones.with_phone}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const report = await runProductionPreflight({ checkDatabase: !process.argv.includes("--offline") });
  printReport(report, process.argv.includes("--json"));
  if (!report.ok) process.exitCode = 1;
}
