import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

import { CRM_COLLECTIONS, asObject, ensureCrmStorage, upsertCrmDocument } from "./storage.js";

export type CrmMigrationMode = "dry-run" | "fresh" | "validate";

export type CrmMigrationOptions = {
  sourceRoot: string;
  targetRoot?: string;
  mode?: CrmMigrationMode;
  confirmFresh?: boolean;
};

type LegacyCrmRecord = {
  scope: "global" | "organization";
  organization_id?: string;
  collection: string;
  id?: string;
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export async function runLegacyCrmMigration(options: CrmMigrationOptions) {
  const mode = options.mode ?? "dry-run";
  if (options.targetRoot) process.env.CRM_STORAGE_ROOT = options.targetRoot;
  const records = await readLegacyCrmRecords(options.sourceRoot);
  const summary = {
    ok: true,
    mode,
    source_root: options.sourceRoot,
    target_root: options.targetRoot ?? process.env.CRM_STORAGE_ROOT ?? "",
    counts: {
      legacy_records_read: records.length,
      crm_records_expected: records.length,
      crm_records_written: 0
    },
    validation: null as null | Awaited<ReturnType<typeof validateRecords>>
  };

  if (mode === "fresh") {
    if (!options.confirmFresh) throw new Error("confirmFresh is required for fresh CRM migration.");
    if (options.targetRoot) await rm(options.targetRoot, { recursive: true, force: true });
    await ensureCrmStorage();
    for (const record of records) {
      await upsertCrmDocument(record.scope, record.collection, {
        id: record.id,
        data: record.data,
        metadata: {
          ...asObject(record.metadata),
          migrated_from: "legacy_crm",
          migrated_at: new Date().toISOString()
        }
      }, { replace: true, orgId: record.organization_id });
      summary.counts.crm_records_written += 1;
    }
  }

  if (mode === "validate" || mode === "fresh") {
    summary.validation = await validateRecords(records);
    summary.ok = summary.validation.failed === 0;
  }

  return summary;
}

async function readLegacyCrmRecords(sourceRoot: string): Promise<LegacyCrmRecord[]> {
  const root = path.resolve(sourceRoot);
  const records: LegacyCrmRecord[] = [];
  await readRecordsFromDirectory(path.join(root, "global"), "global", records);
  await readRecordsFromDirectory(path.join(root, "organizations"), "organization", records);
  return records;
}

async function readRecordsFromDirectory(root: string, scope: "global" | "organization", records: LegacyCrmRecord[]) {
  if (!(await exists(root))) return;
  if (scope === "global") {
    for (const collection of CRM_COLLECTIONS) {
      await readCollectionFiles(path.join(root, collection), scope, collection, records);
    }
    return;
  }

  await mkdir(root, { recursive: true });
  for (const orgEntry of await readdir(root, { withFileTypes: true })) {
    if (!orgEntry.isDirectory()) continue;
    for (const collection of CRM_COLLECTIONS) {
      await readCollectionFiles(path.join(root, orgEntry.name, collection), scope, collection, records, orgEntry.name);
    }
  }
}

async function readCollectionFiles(
  root: string,
  scope: "global" | "organization",
  collection: string,
  records: LegacyCrmRecord[],
  orgId?: string
) {
  if (!(await exists(root))) return;
  await mkdir(root, { recursive: true });
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const parsed = JSON.parse(await readFile(path.join(root, entry.name), "utf8"));
    const data = asObject(parsed.data ?? parsed);
    records.push({
      scope,
      organization_id: orgId,
      collection,
      id: String(parsed.id ?? path.basename(entry.name, ".json")),
      data,
      metadata: asObject(parsed.metadata)
    });
  }
}

async function validateRecords(records: LegacyCrmRecord[]) {
  const failures: Array<Record<string, unknown>> = [];
  for (const record of records) {
    try {
      const saved = await import("./storage.js").then((module) => module.readCrmDocument(
        record.scope,
        record.collection,
        String(record.id ?? ""),
        record.organization_id
      ));
      if (saved.collection !== record.collection) {
        failures.push({ id: record.id, collection: record.collection, reason: "collection_mismatch" });
      }
    } catch (error) {
      failures.push({
        id: record.id,
        collection: record.collection,
        organization_id: record.organization_id ?? null,
        reason: error instanceof Error ? error.message : "missing"
      });
    }
  }
  return {
    checked: records.length,
    failed: failures.length,
    failures
  };
}

async function exists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
