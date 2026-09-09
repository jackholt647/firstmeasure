import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";

const TABLES = ["referral_partners", "referral_codes", "referral_attributions", "referral_events", "referral_reward_ledger"] as const;
type Table = typeof TABLES[number];
type Row = Record<string, SQLInputValue>;
type Snapshot = Record<Table, Row[]>;
type Mutation = { table: Table; kind: "insert" | "update"; row: Row };
type Conflict = { table: Table; id: string; reason: string };
type Options = { target: string; sources: string[]; apply?: boolean; confirmPlan?: string; backup?: string };
const text = (value: unknown) => String(value ?? "");
const lower = (value: unknown) => text(value).trim().toLowerCase();

function readSnapshot(db: DatabaseSync): Snapshot {
  const result = {} as Snapshot;
  for (const table of TABLES) result[table] = db.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Row[];
  return result;
}

function metadata(value: SQLInputValue | undefined) {
  const parsed: unknown = JSON.parse(text(value) || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid referral metadata object.");
  return parsed as Record<string, unknown>;
}

export function planReferralLedgerReconciliation(target: Snapshot, sources: Snapshot[]) {
  const current = Object.fromEntries(TABLES.map(table => [table, new Map(target[table].map(row => [text(row.id), { ...row }]))])) as Record<Table, Map<string, Row>>;
  const mutations = new Map<string, Mutation>();
  const conflicts: Conflict[] = [];
  const canonicalCodes = new Map(target.referral_codes.map(row => [lower(row.code), row]));
  const completedOrgs = new Map<string, string>();
  for (const row of target.referral_attributions) {
    if (row.status === "signup_completed" && row.referred_org_id) completedOrgs.set(text(row.referred_org_id), text(row.id));
  }
  const conflict = (table: Table, row: Row, reason: string) => conflicts.push({ table, id: text(row.id), reason });
  const seenCodes = new Set<string>();
  for (const row of target.referral_codes) {
    if (seenCodes.has(lower(row.code))) conflict("referral_codes", row, "authoritative code is ambiguous ignoring case");
    seenCodes.add(lower(row.code));
  }
  const write = (table: Table, row: Row) => {
    const id = text(row.id);
    const prior = mutations.get(`${table}:${id}`);
    mutations.set(`${table}:${id}`, { table, kind: prior?.kind ?? (current[table].has(id) ? "update" : "insert"), row });
    current[table].set(id, row);
  };
  for (const source of sources) {
    const partnerMap = new Map<string, string>();
    const codeMap = new Map<string, string>();
    for (const incoming of source.referral_partners) {
      const sourceId = text(incoming.id);
      const matches = new Set(source.referral_codes.filter(code => code.partner_id === sourceId)
        .map(code => canonicalCodes.get(lower(code.code))?.partner_id).filter(Boolean).map(text));
      if (current.referral_partners.has(sourceId)) matches.add(sourceId);
      if (matches.size > 1) { conflict("referral_partners", incoming, "partner maps to multiple authoritative partners"); continue; }
      const canonicalId = [...matches][0] || sourceId;
      if (canonicalId !== sourceId) { conflict("referral_partners", incoming, "same code belongs to another partner ID; organization metadata reconciliation required"); continue; }
      const existing = current.referral_partners.get(canonicalId);
      if (existing && existing.type !== incoming.type) { conflict("referral_partners", incoming, "partner type differs"); continue; }
      if (existing && ["linked_org_id", "linked_user_email"].some(key => existing[key] && incoming[key] && lower(existing[key]) !== lower(incoming[key]))) { conflict("referral_partners", incoming, "partner identity differs"); continue; }
      partnerMap.set(sourceId, canonicalId);
      // Compatibility campaign configuration always wins. Node-local auto-created
      // partners must never erase its offers, status, or landing-page assignment.
      if (!existing) write("referral_partners", { ...incoming, id: canonicalId });
    }
    for (const incoming of source.referral_codes) {
      const partnerId = partnerMap.get(text(incoming.partner_id));
      if (!partnerId) { conflict("referral_codes", incoming, "unresolved partner"); continue; }
      const canonical = canonicalCodes.get(lower(incoming.code));
      if (canonical) {
        if (canonical.partner_id !== partnerId) { conflict("referral_codes", incoming, "code belongs to another partner"); continue; }
        codeMap.set(text(incoming.id), text(canonical.id));
        continue;
      }
      if (current.referral_codes.has(text(incoming.id))) { conflict("referral_codes", incoming, "code ID collides with another code"); continue; }
      const next: Row = { ...incoming, partner_id: partnerId };
      codeMap.set(text(incoming.id), text(next.id));
      canonicalCodes.set(lower(next.code), next);
      write("referral_codes", next);
    }
    for (const table of ["referral_attributions", "referral_events", "referral_reward_ledger"] as const) {
      for (const incoming of source[table]) {
        const partnerId = incoming.partner_id ? partnerMap.get(text(incoming.partner_id)) : "";
        const codeId = incoming.code_id ? codeMap.get(text(incoming.code_id)) : "";
        if ((incoming.partner_id && !partnerId) || (incoming.code_id && !codeId)) { conflict(table, incoming, "unresolved partner/code relationship"); continue; }
        if (table === "referral_attributions" && (!partnerId || !codeId)) { conflict(table, incoming, "attribution lacks partner/code"); continue; }
        const next: Row = { ...incoming, partner_id: partnerId || "", code_id: codeId || "" };
        // Keep original IDs and acquisition tokens in metadata: those are stored
        // in PostgreSQL organization records and can still be in customer URLs.
        const existing = current[table].get(text(next.id));
        if (existing && (existing.partner_id !== next.partner_id || existing.code_id !== next.code_id)) { conflict(table, next, "overlapping ID has different relationships"); continue; }
        if (table === "referral_attributions") {
          if (existing?.referred_org_id && next.referred_org_id && existing.referred_org_id !== next.referred_org_id) { conflict(table, next, "overlapping attribution belongs to another organization"); continue; }
          if (next.status === "signup_completed" && next.referred_org_id) {
            const existingId = completedOrgs.get(text(next.referred_org_id));
            if (existingId && existingId !== next.id) { conflict(table, next, "organization has a different completed attribution; manual deduplication required"); continue; }
            completedOrgs.set(text(next.referred_org_id), text(next.id));
          }
          if (existing) {
            // Upgrade the exact original landing attribution, never turn a
            // completed signup back into a view and never rewrite its identity.
            if (existing.status === "signup_completed" || next.status !== "signup_completed") continue;
            next.created_at = existing.created_at ?? "";
            const priorMetadata = metadata(existing.metadata_json);
            const incomingMetadata = metadata(next.metadata_json);
            if (priorMetadata.acquisition_bonus_token && incomingMetadata.acquisition_bonus_token && priorMetadata.acquisition_bonus_token !== incomingMetadata.acquisition_bonus_token) { conflict(table, next, "overlapping attribution has a different advertised bonus token"); continue; }
            next.metadata_json = JSON.stringify({ ...priorMetadata, ...incomingMetadata, ...(priorMetadata.acquisition_bonus_token ? { acquisition_bonus_token: priorMetadata.acquisition_bonus_token } : {}) });
          }
        } else if (table === "referral_events" && existing) {
          if (["actor_email", "actor_org_id", "event_type"].some(key => existing[key] !== next[key])) { conflict(table, next, "overlapping event has different actor/type"); continue; }
          if (Number(next.event_count) !== Number(existing.event_count)) { conflict(table, next, "overlapping event counters diverge; baseline required to avoid double counting"); continue; }
          continue;
        } else if (table === "referral_reward_ledger") {
          const attribution = current.referral_attributions.get(text(next.attribution_id));
          if (!attribution || attribution.partner_id !== next.partner_id || (next.code_id && attribution.code_id !== next.code_id)) { conflict(table, next, "reward attribution relationship missing or inconsistent"); continue; }
          if (existing) {
            if (["attribution_id", "reward_type", "amount", "status", "applied_at"].some(key => existing[key] !== next[key])) conflict(table, next, "overlapping reward differs; financial state must be reviewed");
            continue;
          }
          if ([...current.referral_reward_ledger.values()].some(row => row.attribution_id === next.attribution_id && row.reward_type === next.reward_type)) { conflict(table, next, "duplicate logical reward with another ID; manual review required"); continue; }
        }
        if (!existing || table === "referral_attributions") write(table, next);
      }
    }
  }
  const changes = [...mutations.values()];
  const digest = createHash("sha256").update(JSON.stringify(changes)).digest("hex");
  const counts = Object.fromEntries(TABLES.map(table => [table, {
    insert: changes.filter(change => change.table === table && change.kind === "insert").length,
    update: changes.filter(change => change.table === table && change.kind === "update").length
  }]));
  return { digest, counts, conflicts, changes };
}

export function reconcileReferralLedgers(options: Options) {
  const targetPath = realpathSync(options.target);
  const sourcePaths = options.sources.map(source => realpathSync(source));
  if (!sourcePaths.length || new Set(sourcePaths).size !== sourcePaths.length || sourcePaths.includes(targetPath)) throw new Error("Specify distinct source snapshots, separate from the target.");
  for (const file of [targetPath, ...sourcePaths]) if (!statSync(file).isFile()) throw new Error("All inputs must be existing SQLite files.");
  const sources = sourcePaths.map(source => {
    const db = new DatabaseSync(source, { readOnly: true });
    try { db.exec("BEGIN"); return readSnapshot(db); } finally { db.close(); }
  });
  const target = new DatabaseSync(targetPath, { readOnly: !options.apply });
  try {
    target.exec("PRAGMA busy_timeout=5000");
    if (options.apply) {
      if (!options.confirmPlan || !options.backup) throw new Error("Apply requires the reviewed --confirm-plan digest and a new --backup path.");
      const backup = path.resolve(options.backup);
      if (existsSync(backup) || sourcePaths.includes(backup) || backup === targetPath) throw new Error("Backup must be a new path, separate from all inputs.");
      const preview = planReferralLedgerReconciliation(readSnapshot(target), sources);
      if (preview.conflicts.length || preview.digest !== options.confirmPlan) throw new Error("Plan changed or contains conflicts. Rerun dry-run and review before applying.");
      target.prepare("VACUUM INTO ?").run(backup);
      target.exec("BEGIN IMMEDIATE");
    } else target.exec("BEGIN");
    const plan = planReferralLedgerReconciliation(readSnapshot(target), sources);
    if (options.apply) {
      if (plan.conflicts.length || plan.digest !== options.confirmPlan) throw new Error("Target changed while preparing backup; no changes applied. Review a fresh dry-run.");
      for (const change of plan.changes) {
        const columns = Object.keys(change.row);
        // Only actual target-schema columns may become SQL identifiers.
        const allowed = new Set(target.prepare(`PRAGMA table_info(${change.table})`).all().map(column => text(column.name)));
        if (columns.some(column => !allowed.has(column))) throw new Error("Source/target schemas differ; no changes applied.");
        const names = columns.map(column => `"${column}"`);
        const sql = change.kind === "insert"
          ? `INSERT INTO ${change.table} (${names.join(",")}) VALUES (${columns.map(() => "?").join(",")})`
          : `UPDATE ${change.table} SET ${names.map(name => `${name}=?`).join(",")} WHERE id=?`;
        const values = columns.map(column => change.row[column] ?? null);
        if (change.kind === "update") values.push(change.row.id ?? null);
        target.prepare(sql).run(...values);
      }
      if (text(target.prepare("PRAGMA quick_check").get()?.quick_check) !== "ok") throw new Error("SQLite verification failed; changes rolled back.");
    }
    target.exec(options.apply ? "COMMIT" : "ROLLBACK");
    return { applied: Boolean(options.apply), digest: plan.digest, counts: plan.counts, conflicts: plan.conflicts };
  } catch (error) {
    try { target.exec("ROLLBACK"); } catch { /* no transaction started */ }
    throw error;
  } finally { target.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const value = (name: string) => { const index = argv.indexOf(name); return index < 0 ? "" : argv[index + 1] || ""; };
  const sources = argv.flatMap((arg, index) => arg === "--source" ? [argv[index + 1] || ""] : []);
  if (!argv.includes("--target") || !sources.length) throw new Error("Usage: referral_ledger_reconcile --target CANONICAL.sqlite --source WEB-SNAPSHOT.sqlite [--source ...] [--apply --confirm-plan DIGEST --backup NEW.sqlite]");
  const result = reconcileReferralLedgers({ target: value("--target"), sources, apply: argv.includes("--apply"), confirmPlan: value("--confirm-plan"), backup: value("--backup") });
  console.log(JSON.stringify(result, null, 2));
  if (result.conflicts.length) process.exitCode = 2;
}
