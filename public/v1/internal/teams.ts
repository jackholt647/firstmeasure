import { randomBytes } from "node:crypto";

import {
  asObject,
  listInternalDocuments,
  listInternalUsers,
  readInternalDocument,
  saveInternalUser,
  saveInternalDocument,
  type JsonObject
} from "./storage.js";

const TEAM_COLLECTION = "teams";

export type InternalTeam = {
  id: string;
  name: string;
  manager_user_ids: string[];
  archived: boolean;
  created_at: string;
  updated_at: string;
};

export function normalizeTeamId(value: unknown) {
  const raw = String(value ?? "").trim();
  return raw.toLowerCase() === "default" ? "" : raw;
}

function teamSlug(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

function managerIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item ?? "").trim().toLowerCase()).filter(Boolean))];
}

function publicTeam(document: JsonObject): InternalTeam {
  const data = asObject(document.data);
  return {
    id: String(document.id ?? data.id ?? ""),
    name: String(data.name ?? document.id ?? "").trim(),
    manager_user_ids: managerIds(data.manager_user_ids),
    archived: data.archived === true,
    created_at: String(document.created_at ?? ""),
    updated_at: String(document.updated_at ?? "")
  };
}

async function uniqueTeamId(name: string) {
  const base = teamSlug(name) || `team-${randomBytes(3).toString("hex")}`;
  if (!(await readInternalDocument(TEAM_COLLECTION, base))) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!(await readInternalDocument(TEAM_COLLECTION, candidate))) return candidate;
  }
  return `${base}-${randomBytes(4).toString("hex")}`;
}

export async function ensureLegacyInternalTeams() {
  const existing = await listInternalDocuments(TEAM_COLLECTION);
  const users = await listInternalUsers();
  const legacyIds = [...new Set(users.map((user) => normalizeTeamId(user.team_id)).filter(Boolean))];
  for (const legacyId of legacyIds) {
    let document = existing.find((candidate) => {
      const data = asObject(candidate.data);
      return String(candidate.id ?? "") === legacyId || String(data.migrated_from_legacy_team_id ?? "") === legacyId;
    });
    if (!document) {
      const id = await uniqueTeamId(legacyId);
      document = await saveInternalDocument(TEAM_COLLECTION, id, {
      name: legacyId,
      manager_user_ids: [],
      archived: false,
        migrated_from_legacy_team_id: legacyId
      });
      existing.push(document);
    }
    const canonicalId = String(document.id ?? "");
    if (canonicalId === legacyId) continue;
    for (const user of users.filter((candidate) => normalizeTeamId(candidate.team_id) === legacyId)) {
      await saveInternalUser({ ...user, team_id: canonicalId }, { changedBy: "system:team-migration" });
      user.team_id = canonicalId;
    }
  }
}

export async function listInternalTeams(options: { includeArchived?: boolean } = {}) {
  await ensureLegacyInternalTeams();
  const teams = (await listInternalDocuments(TEAM_COLLECTION)).map(publicTeam);
  return teams
    .filter((team) => options.includeArchived || !team.archived)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}

export async function readInternalTeam(teamId: string) {
  const id = normalizeTeamId(teamId);
  if (!id) return null;
  const document = await readInternalDocument(TEAM_COLLECTION, id);
  return document ? publicTeam(document) : null;
}

export async function createInternalTeam(input: JsonObject) {
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("team_name_required");
  if (name.length > 100) throw new Error("team_name_too_long");
  const id = await uniqueTeamId(name);
  const document = await saveInternalDocument(TEAM_COLLECTION, id, {
    name,
    manager_user_ids: managerIds(input.manager_user_ids),
    archived: false
  });
  return publicTeam(document);
}

export async function updateInternalTeam(teamId: string, input: JsonObject) {
  const existing = await readInternalTeam(teamId);
  if (!existing) return null;
  const name = input.name === undefined ? existing.name : String(input.name ?? "").trim();
  if (!name) throw new Error("team_name_required");
  if (name.length > 100) throw new Error("team_name_too_long");
  const document = await saveInternalDocument(TEAM_COLLECTION, existing.id, {
    name,
    manager_user_ids: input.manager_user_ids === undefined
      ? existing.manager_user_ids
      : managerIds(input.manager_user_ids),
    archived: input.archived === undefined ? existing.archived : input.archived === true
  });
  return publicTeam(document);
}
