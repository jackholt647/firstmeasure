import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { env } from "../config/env.js";
import { closePostgresPools, isFirstMeasurePostgresEnabled, queryPostgres } from "../database/postgres.js";
import { ensureSharedDocumentsReady, replaceSharedDocument } from "../database/shared_documents.js";
import { getSharedObject, putSharedObject } from "../storage/project_artifacts.js";
import { ensureInternalStorage, listInternalUsers, saveInternalDocument } from "../../internal/storage.js";
import { ensurePostgresPlatformStorage } from "../../platform/storage_postgres.js";

type JsonObject = Record<string, unknown>;
type Options = { apply: boolean; verify: boolean; concurrency: number };
type Counts = Record<string, number>;
type MigratedObject = { key: string; size: number };

const PLATFORM_COLLECTIONS = new Set([
  "users", "projects", "customers", "branch", "notifications", "action_items", "activity", "customer_portals",
  "onboarding_events", "proposals", "proposal_snapshots", "proposal_events", "material_lists", "material_list_versions",
  "material_orders", "material_deliveries", "material_events", "payment_schedules", "payment_obligations",
  "payment_transactions", "payment_allocations", "payment_intents", "payment_payables", "payment_disbursements",
  "payment_ledger_events", "payment_events"
]);

function parseOptions(argv: string[]): Options {
  const numberAfter = (name: string, fallback: number) => {
    const index = argv.indexOf(name);
    return index >= 0 ? Number(argv[index + 1] ?? fallback) : fallback;
  };
  return {
    apply: argv.includes("--apply"),
    verify: argv.includes("--verify"),
    concurrency: Math.max(1, Math.min(16, Math.floor(numberAfter("--concurrency", 4)) || 4))
  };
}

function root(value: string) { return path.resolve(process.cwd(), value); }
async function exists(value: string) { return stat(value).then(() => true).catch(() => false); }
async function jsonFile<T>(value: string): Promise<T> { return JSON.parse(await readFile(value, "utf8")) as T; }
async function jsonFiles(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => path.join(directory, entry.name));
}
function bump(counts: Counts, key: string, amount = 1) { counts[key] = (counts[key] ?? 0) + amount; }

async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      if (item !== undefined) await fn(item);
    }
  }));
}

async function upsertPlatform(table: string, columns: string[], values: unknown[], conflictColumns: string[], updateColumns: string[]) {
  const placeholders = values.map((_, index) => `$${index + 1}`).join(",");
  await queryPostgres(`INSERT INTO ${table}(${columns.join(",")}) VALUES(${placeholders})
    ON CONFLICT(${conflictColumns.join(",")}) DO UPDATE SET ${updateColumns.map((column) => `${column}=EXCLUDED.${column}`).join(",")}`, values);
}

async function migratePlatform(options: Options, counts: Counts, migratedObjects: MigratedObject[]) {
  const platformRoot = root(env.platformStorageRoot);
  if (!(await exists(platformRoot))) return;

  for (const file of await jsonFiles(path.join(platformRoot, "identities"))) {
    const document = await jsonFile<JsonObject>(file);
    bump(counts, "platform_identities_seen");
    if (options.apply) await upsertPlatform("platform_identities", ["id","email","phone_normalized","document"],
      [String(document.id), String(document.email_normalized ?? document.email ?? "").toLowerCase(), String(document.phone_normalized ?? ""), JSON.stringify(document)], ["id"], ["email","phone_normalized","document"]);
  }
  for (const file of await jsonFiles(path.join(platformRoot, "sessions"))) {
    const document = await jsonFile<JsonObject>(file);
    bump(counts, "platform_sessions_seen");
    if (options.apply) await upsertPlatform("platform_sessions", ["id_hash","identity_id","expires_at","document"],
      [String(document.id_hash), String(document.identity_id), String(document.expires_at), JSON.stringify(document)], ["id_hash"], ["identity_id","expires_at","document"]);
  }

  const orgRoot = path.join(platformRoot, "organizations");
  const orgEntries = await readdir(orgRoot, { withFileTypes: true }).catch(() => []);
  for (const orgEntry of orgEntries.filter((entry) => entry.isDirectory())) {
    const orgId = orgEntry.name;
    const directory = path.join(orgRoot, orgId);
    const manifest = await jsonFile<JsonObject>(path.join(directory, "manifest.json"));
    bump(counts, "platform_organizations_seen");
    if (options.apply) await upsertPlatform("platform_organizations", ["id","document"], [orgId, JSON.stringify(manifest)], ["id"], ["document"]);

    const globalPath = path.join(directory, "global.json");
    if (await exists(globalPath)) {
      const document = await jsonFile<JsonObject>(globalPath);
      bump(counts, "platform_documents_seen");
      if (options.apply) await upsertPlatform("platform_documents", ["organization_id","collection","id","document"], [orgId,"global","global",JSON.stringify(document)], ["organization_id","collection","id"], ["document"]);
    }
    for (const collection of PLATFORM_COLLECTIONS) {
      for (const file of await jsonFiles(path.join(directory, collection))) {
        const document = await jsonFile<JsonObject>(file);
        const id = String(document.id ?? path.basename(file, ".json"));
        bump(counts, "platform_documents_seen");
        if (options.apply) await upsertPlatform("platform_documents", ["organization_id","collection","id","document"], [orgId,collection,id,JSON.stringify(document)], ["organization_id","collection","id"], ["document"]);
      }
    }
    const branches = await readdir(path.join(directory, "branch_data"), { withFileTypes: true }).catch(() => []);
    for (const branch of branches.filter((entry) => entry.isDirectory())) {
      for (const file of await jsonFiles(path.join(directory, "branch_data", branch.name))) {
        const document = await jsonFile<JsonObject>(file);
        const id = String(document.id ?? path.basename(file, ".json"));
        bump(counts, "platform_branch_modules_seen");
        if (options.apply) await upsertPlatform("platform_branch_modules", ["organization_id","branch_id","id","document"], [orgId,branch.name,id,JSON.stringify(document)], ["organization_id","branch_id","id"], ["document"]);
      }
    }

    const mediaEntries = await readdir(path.join(directory, "media"), { withFileTypes: true }).catch(() => []);
    for (const mediaEntry of mediaEntries.filter((entry) => entry.isDirectory())) {
      const mediaId = mediaEntry.name;
      const mediaDir = path.join(directory, "media", mediaId);
      const metadataPath = path.join(mediaDir, "metadata.json");
      if (!(await exists(metadataPath))) continue;
      const metadata = await jsonFile<JsonObject>(metadataPath);
      bump(counts, "platform_media_seen");
      if (options.apply) await upsertPlatform("platform_media", ["organization_id","id","document"], [orgId,mediaId,JSON.stringify(metadata)], ["organization_id","id"], ["document"]);
      for (const file of await jsonFiles(path.join(mediaDir, "markup"))) {
        const document = await jsonFile<JsonObject>(file); const id = String(document.id ?? path.basename(file, ".json"));
        bump(counts, "platform_media_markup_seen");
        if (options.apply) await upsertPlatform("platform_media_markup", ["organization_id","media_id","id","document"], [orgId,mediaId,id,JSON.stringify(document)], ["organization_id","media_id","id"], ["document"]);
      }
      const binaryFiles: Array<{ absolute: string; relative: string }> = [];
      for (const subdir of ["original", "renditions"]) {
        const entries = await readdir(path.join(mediaDir, subdir), { withFileTypes: true }).catch(() => []);
        for (const entry of entries) if (entry.isFile()) binaryFiles.push({ absolute: path.join(mediaDir, subdir, entry.name), relative: `${subdir}/${entry.name}` });
      }
      bump(counts, "platform_media_objects_seen", binaryFiles.length);
      await runPool(binaryFiles, options.concurrency, async (file) => {
        const key = `platform/organizations/${orgId}/media/${mediaId}/${file.relative}`;
        if (options.apply) {
          const content = await readFile(file.absolute);
          await putSharedObject(key, content);
          migratedObjects.push({ key, size: content.length });
        } else {
          migratedObjects.push({ key, size: (await stat(file.absolute)).size });
        }
      });
    }
  }
}

async function migrateSharedJsonStores(options: Options, counts: Counts, migratedObjects: MigratedObject[]) {
  const migrateDirectory = async (directory: string, namespace: string, collection: string) => {
    for (const file of await jsonFiles(directory)) {
      const document = await jsonFile<JsonObject>(file);
      const id = String(document.id ?? document.report_id ?? path.basename(file, ".json"));
      bump(counts, `${namespace}_${collection}_seen`);
      if (options.apply) await replaceSharedDocument({ namespace, collection, id }, document);
    }
  };
  await migrateDirectory(path.join(root(env.weatherStorageRoot), "reports"), "weather", "reports");
  await migrateDirectory(path.join(root(env.codeReportStorageRoot), "reports"), "code_reports", "reports");
  const rushPath = path.join(root(env.firstmeasureStorageRoot), "rush_modes.json");
  if (await exists(rushPath)) {
    bump(counts, "firstmeasure_rush_modes_seen");
    if (options.apply) await replaceSharedDocument({ namespace: "firstmeasure", collection: "runtime", id: "rush_modes" }, await jsonFile(rushPath));
  }

  const crmRoot = root(env.crmStorageRoot);
  const globalCollections = await readdir(path.join(crmRoot, "global"), { withFileTypes: true }).catch(() => []);
  for (const collection of globalCollections.filter((entry) => entry.isDirectory())) {
    for (const file of await jsonFiles(path.join(crmRoot, "global", collection.name))) {
      const document = await jsonFile<JsonObject>(file); const id = String(document.id ?? path.basename(file, ".json")); bump(counts,"crm_documents_seen");
      if (options.apply) await replaceSharedDocument({ namespace:"crm", scope:"global", collection:collection.name, id }, document);
    }
  }
  const orgs = await readdir(path.join(crmRoot, "organizations"), { withFileTypes: true }).catch(() => []);
  for (const org of orgs.filter((entry) => entry.isDirectory())) {
    const collections = await readdir(path.join(crmRoot,"organizations",org.name), { withFileTypes:true }).catch(()=>[]);
    for(const collection of collections.filter((entry)=>entry.isDirectory())) for(const file of await jsonFiles(path.join(crmRoot,"organizations",org.name,collection.name))) {
      const document=await jsonFile<JsonObject>(file); const id=String(document.id??path.basename(file,".json")); bump(counts,"crm_documents_seen");
      if(options.apply) await replaceSharedDocument({namespace:"crm",scope:org.name,collection:collection.name,id},document);
    }
  }

  const canvassingRoot = path.join(root(env.canvassingStorageRoot), "organizations");
  const canvassingOrgs = await readdir(canvassingRoot, { withFileTypes: true }).catch(() => []);
  for (const org of canvassingOrgs.filter((entry) => entry.isDirectory())) {
    const branchesRoot = path.join(canvassingRoot, org.name, "branches");
    const branches = await readdir(branchesRoot, { withFileTypes: true }).catch(() => []);
    for (const branch of branches.filter((entry) => entry.isDirectory())) {
      for (const file of await jsonFiles(path.join(branchesRoot, branch.name, "pins"))) {
        const document = await jsonFile<JsonObject>(file);
        const id = String(document.id ?? path.basename(file, ".json"));
        bump(counts, "canvassing_pins_seen");
        if (options.apply) {
          await replaceSharedDocument({
            namespace: "canvassing",
            scope: `${org.name}:${branch.name}`,
            collection: "pins",
            id
          }, document);
        }
      }
    }
  }

  const pricebooks = await readdir(path.join(root(env.pricebookStorageRoot), "pricebooks"), { withFileTypes: true }).catch(() => []);
  for (const entry of pricebooks.filter((item) => item.isDirectory())) {
    const directory = path.join(root(env.pricebookStorageRoot), "pricebooks", entry.name);
    if (!(await exists(path.join(directory,"manifest.json"))) || !(await exists(path.join(directory,"catalog.json")))) continue;
    const manifest = await jsonFile<JsonObject>(path.join(directory,"manifest.json")); const catalog = await jsonFile<JsonObject>(path.join(directory,"catalog.json")); bump(counts,"pricebooks_seen");
    if(options.apply) await replaceSharedDocument({namespace:"pricebook",collection:"pricebooks",id:entry.name},{manifest,catalog});
    const assets=await readdir(path.join(directory,"assets"),{withFileTypes:true}).catch(()=>[]); bump(counts,"pricebook_assets_seen",assets.filter((item)=>item.isFile()).length);
    await runPool(assets.filter((item)=>item.isFile()),options.concurrency,async(asset)=>{
      const sourcePath=path.join(directory,"assets",asset.name); const key=`pricebooks/${entry.name}/assets/${asset.name}`;
      if(options.apply){const content=await readFile(sourcePath); await putSharedObject(key,content); migratedObjects.push({key,size:content.length});}
      else migratedObjects.push({key,size:(await stat(sourcePath)).size});
    });
  }

  const platformRoot = root(env.platformStorageRoot);
  await migrateDirectory(path.join(platformRoot,"public_firstmeasure","reports"),"public_firstmeasure","reports");
  await migrateDirectory(path.join(platformRoot,"api_keys","firstmeasure"),"public_firstmeasure","api_keys");
  await migrateDirectory(path.join(platformRoot,"api_keys","firstmeasure",".secret-vault"),"public_firstmeasure","key_secrets");
  await migrateDirectory(path.join(platformRoot,"api_keys","firstmeasure",".deliveries"),"public_firstmeasure","key_deliveries");
}

async function inventoryInternalState(counts: Counts) {
  const internalRoot = root(env.internalStorageRoot);
  bump(counts, "internal_users_seen", (await jsonFiles(path.join(internalRoot, "users"))).length);
  const collections = await readdir(path.join(internalRoot, "state"), { withFileTypes: true }).catch(() => []);
  for (const collection of collections.filter((entry) => entry.isDirectory())) {
    bump(counts, "internal_documents_seen", (await jsonFiles(path.join(internalRoot, "state", collection.name))).length);
  }
}

async function migrateCommunications(options: Options, counts: Counts) {
  const communicationsRoot = root(process.env.COMMUNICATIONS_STORAGE_ROOT ?? "./storage/communications");
  const mailboxRoot = path.join(communicationsRoot, "gmail_mailboxes");
  const mailboxes = await readdir(mailboxRoot, { withFileTypes: true }).catch(() => []);
  for (const mailbox of mailboxes.filter((entry) => entry.isDirectory())) {
    const mailboxDirectory = path.join(mailboxRoot, mailbox.name);
    const statePath = path.join(mailboxDirectory, "mailbox.json");
    if (await exists(statePath)) {
      bump(counts, "communications_gmail_mailbox_state_seen");
      if (options.apply) await replaceSharedDocument({
        namespace: "communications", scope: mailbox.name, collection: "gmail_mailbox_state", id: "mailbox"
      }, await jsonFile(statePath));
    }
    for (const [directory, collection, countKey] of [
      ["messages", "gmail_messages", "communications_gmail_messages_seen"],
      ["unmatched", "gmail_unmatched", "communications_gmail_unmatched_seen"],
      ["sync_runs", "gmail_sync_runs", "communications_gmail_sync_runs_seen"]
    ] as const) {
      for (const file of await jsonFiles(path.join(mailboxDirectory, directory))) {
        const document = await jsonFile<JsonObject>(file);
        const id = String(document.gmail_message_id ?? document.id ?? path.basename(file, ".json"));
        bump(counts, countKey);
        if (options.apply) await replaceSharedDocument({
          namespace: "communications", scope: mailbox.name, collection, id
        }, document);
      }
    }
  }
}

async function migrateAppleKeyState(options: Options, counts: Counts) {
  const keyPath = path.join(root(env.firstmeasureStorageRoot), "apple_key.json");
  if (await exists(keyPath)) {
    const document = await jsonFile<JsonObject>(keyPath);
    bump(counts, "apple_key_seen");
    if (options.apply) await saveInternalDocument("config", "apple_key", { data: document }, { replace: true });
  }
  const auditPath = path.join(root(env.firstmeasureStorageRoot), "logs", "apple_key_ingest.ndjson");
  if (!(await exists(auditPath))) return;
  const lines = (await readFile(auditPath, "utf8")).split(/\r?\n/).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const document = JSON.parse(lines[index]!) as JsonObject;
    bump(counts, "apple_key_audit_seen");
    if (options.apply) {
      const timestamp = String(document.ts_utc ?? "").replace(/[^0-9A-Za-z_-]/g, "_");
      await saveInternalDocument("apple_key_audit", `legacy_${timestamp || "event"}_${index}`, { data: document }, { replace: true });
    }
  }
}

async function verify(counts: Counts, migratedObjects: MigratedObject[], concurrency: number) {
  const checks = {
    platform_identities: Number((await queryPostgres<{ count:string }>("SELECT COUNT(*)::text count FROM platform_identities")).rows[0]?.count ?? 0),
    platform_sessions: Number((await queryPostgres<{ count:string }>("SELECT COUNT(*)::text count FROM platform_sessions")).rows[0]?.count ?? 0),
    platform_organizations: Number((await queryPostgres<{ count:string }>("SELECT COUNT(*)::text count FROM platform_organizations")).rows[0]?.count ?? 0),
    platform_documents: Number((await queryPostgres<{ count:string }>("SELECT COUNT(*)::text count FROM platform_documents")).rows[0]?.count ?? 0),
    platform_branch_modules: Number((await queryPostgres<{ count:string }>("SELECT COUNT(*)::text count FROM platform_branch_modules")).rows[0]?.count ?? 0),
    platform_media: Number((await queryPostgres<{ count:string }>("SELECT COUNT(*)::text count FROM platform_media")).rows[0]?.count ?? 0),
    platform_media_markup: Number((await queryPostgres<{ count:string }>("SELECT COUNT(*)::text count FROM platform_media_markup")).rows[0]?.count ?? 0),
    internal_users: Number((await queryPostgres<{ count:string }>("SELECT COUNT(*)::text count FROM internal_users_index")).rows[0]?.count ?? 0),
    internal_documents: Number((await queryPostgres<{ count:string }>("SELECT COUNT(*)::text count FROM internal_documents")).rows[0]?.count ?? 0),
    shared_documents: Number((await queryPostgres<{ count:string }>("SELECT COUNT(*)::text count FROM app_shared_documents")).rows[0]?.count ?? 0)
  };
  const failures: string[] = [];
  const atLeast = (label: string, actual: number, expected: number) => {
    if (actual < expected) failures.push(`${label}: expected at least ${expected}, found ${actual}`);
  };
  atLeast("platform identities", checks.platform_identities, counts.platform_identities_seen ?? 0);
  atLeast("platform sessions", checks.platform_sessions, counts.platform_sessions_seen ?? 0);
  atLeast("platform organizations", checks.platform_organizations, counts.platform_organizations_seen ?? 0);
  atLeast("platform documents", checks.platform_documents, counts.platform_documents_seen ?? 0);
  atLeast("platform branch modules", checks.platform_branch_modules, counts.platform_branch_modules_seen ?? 0);
  atLeast("platform media", checks.platform_media, counts.platform_media_seen ?? 0);
  atLeast("platform media markup", checks.platform_media_markup, counts.platform_media_markup_seen ?? 0);
  atLeast("internal users", checks.internal_users, counts.internal_users_seen ?? 0);
  atLeast("internal documents", checks.internal_documents, counts.internal_documents_seen ?? 0);
  if (counts.apple_key_seen) {
    const actual = Number((await queryPostgres<{ count:string }>("SELECT COUNT(*)::text count FROM internal_documents WHERE collection='config' AND id='apple_key'")).rows[0]?.count ?? 0);
    atLeast("Apple Maps key state", actual, 1);
  }
  if (counts.apple_key_audit_seen) {
    const actual = Number((await queryPostgres<{ count:string }>("SELECT COUNT(*)::text count FROM internal_documents WHERE collection='apple_key_audit'")).rows[0]?.count ?? 0);
    atLeast("Apple Maps key audit", actual, counts.apple_key_audit_seen);
  }

  const sharedExpectations: Array<[string, string, string | null, number]> = [
    ["weather", "reports", null, counts.weather_reports_seen ?? 0],
    ["code_reports", "reports", null, counts.code_reports_reports_seen ?? 0],
    ["crm", "", null, counts.crm_documents_seen ?? 0],
    ["canvassing", "pins", null, counts.canvassing_pins_seen ?? 0],
    ["pricebook", "pricebooks", null, counts.pricebooks_seen ?? 0],
    ["public_firstmeasure", "reports", null, counts.public_firstmeasure_reports_seen ?? 0],
    ["public_firstmeasure", "api_keys", null, counts.public_firstmeasure_api_keys_seen ?? 0],
    ["public_firstmeasure", "key_secrets", null, counts.public_firstmeasure_key_secrets_seen ?? 0],
    ["public_firstmeasure", "key_deliveries", null, counts.public_firstmeasure_key_deliveries_seen ?? 0],
    ["communications", "gmail_mailbox_state", null, counts.communications_gmail_mailbox_state_seen ?? 0],
    ["communications", "gmail_messages", null, counts.communications_gmail_messages_seen ?? 0],
    ["communications", "gmail_unmatched", null, counts.communications_gmail_unmatched_seen ?? 0],
    ["communications", "gmail_sync_runs", null, counts.communications_gmail_sync_runs_seen ?? 0]
  ];
  for (const [namespace, collection, scope, expected] of sharedExpectations) {
    if (!expected) continue;
    const parameters: unknown[] = [namespace];
    let sql = "SELECT COUNT(*)::text count FROM app_shared_documents WHERE namespace = $1";
    if (collection) { parameters.push(collection); sql += ` AND collection = $${parameters.length}`; }
    if (scope) { parameters.push(scope); sql += ` AND scope = $${parameters.length}`; }
    const actual = Number((await queryPostgres<{ count:string }>(sql, parameters)).rows[0]?.count ?? 0);
    atLeast(`${namespace}/${collection || "*"}`, actual, expected);
  }
  if (counts.firstmeasure_rush_modes_seen) {
    const actual = Number((await queryPostgres<{ count:string }>("SELECT COUNT(*)::text count FROM app_shared_documents WHERE namespace='firstmeasure' AND collection='runtime' AND id='rush_modes'")).rows[0]?.count ?? 0);
    atLeast("firstmeasure rush state", actual, 1);
  }

  await runPool(migratedObjects, concurrency, async (object) => {
    const stored = await getSharedObject(object.key);
    if (!stored || stored.length !== object.size) failures.push(`${object.key}: expected ${object.size} bytes, found ${stored?.length ?? 0}`);
  });
  process.stdout.write(`${JSON.stringify({ verification: checks, verified_objects: migratedObjects.length, source_counts: counts, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(`Cluster state verification failed (${failures.length} mismatch${failures.length === 1 ? "" : "es"}).`);
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (!isFirstMeasurePostgresEnabled()) throw new Error("Set FIRSTMEASURE_DATABASE_MODE=postgres and DATABASE_URL.");
  if (options.apply && env.firstmeasureArtifactStorage !== "spaces") throw new Error("--apply requires FIRSTMEASURE_ARTIFACT_STORAGE=spaces for shared binary objects.");
  const counts: Counts = {};
  const migratedObjects: MigratedObject[] = [];
  await inventoryInternalState(counts);
  if (options.apply) {
    await ensurePostgresPlatformStorage();
    await ensureSharedDocumentsReady();
    await ensureInternalStorage();
    const users = await listInternalUsers(); // imports the legacy stores once under a PostgreSQL lock
    counts.internal_users_imported = users.length;
  } else if (options.verify) {
    await ensurePostgresPlatformStorage();
    await ensureSharedDocumentsReady();
  }
  await migratePlatform(options, counts, migratedObjects);
  await migrateSharedJsonStores(options, counts, migratedObjects);
  await migrateCommunications(options, counts);
  await migrateAppleKeyState(options, counts);
  process.stdout.write(`${JSON.stringify({ mode: options.apply ? "apply" : "dry-run", counts }, null, 2)}\n`);
  if (options.verify) await verify(counts, migratedObjects, options.concurrency);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(async () => closePostgresPools());
