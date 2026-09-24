import { randomUUID } from "node:crypto";
import { getAgentsDatabase } from "../agents/storage.js";
import { readPlatformConfiguration, mutatePlatformConfiguration } from "../platform/storage.js";

const GLOBAL_CONFIG = "global_assistant_instructions";
const MAX_MEMORIES = 50;

export async function globalAssistantInstructions() {
  const record = await readPlatformConfiguration(GLOBAL_CONFIG);
  return String(record?.instructions ?? "").slice(0, 8000);
}

export async function saveGlobalAssistantInstructions(instructions: string, actor: string) {
  const value = String(instructions ?? "").trim().slice(0, 8000);
  await mutatePlatformConfiguration(GLOBAL_CONFIG, () => ({ instructions: value, updated_at: new Date().toISOString(), updated_by: actor }));
  return value;
}

export async function readAssistantOrganizationInstructions(orgId: string): Promise<string | null> {
  const row = await getAgentsDatabase().prepare(
    "SELECT instructions FROM assistant_organization_instructions WHERE organization_id=?"
  ).get(orgId);
  return row ? String(row.instructions ?? "") : null;
}

export async function saveAssistantOrganizationInstructions(orgId: string, instructions: string) {
  const value = String(instructions ?? "").trim().slice(0, 4000);
  await getAgentsDatabase().prepare(`INSERT INTO assistant_organization_instructions (organization_id,instructions,updated_at)
    VALUES (?,?,?) ON CONFLICT (organization_id) DO UPDATE SET instructions=excluded.instructions,updated_at=excluded.updated_at`)
    .run(orgId, value, new Date().toISOString());
  return value;
}

export async function readAssistantProfile(orgId: string, userId: string) {
  const row = await getAgentsDatabase().prepare(
    "SELECT instructions, memory_enabled FROM assistant_profiles WHERE organization_id=? AND user_id=?"
  ).get(orgId, userId);
  return { instructions: String(row?.instructions ?? ""), memory_enabled: row?.memory_enabled === undefined || Number(row.memory_enabled) !== 0 };
}

export async function saveAssistantProfile(orgId: string, userId: string, input: { instructions: string; memory_enabled: boolean }) {
  const instructions = String(input.instructions ?? "").trim().slice(0, 4000);
  const memoryEnabled = input.memory_enabled ? 1 : 0;
  await getAgentsDatabase().prepare(`INSERT INTO assistant_profiles (organization_id,user_id,instructions,memory_enabled,updated_at)
    VALUES (?,?,?,?,?) ON CONFLICT (organization_id,user_id) DO UPDATE SET
    instructions=excluded.instructions,memory_enabled=excluded.memory_enabled,updated_at=excluded.updated_at`)
    .run(orgId, userId, instructions, memoryEnabled, new Date().toISOString());
  return { instructions, memory_enabled: !!memoryEnabled };
}

export async function listAssistantMemories(orgId: string, userId: string) {
  return (await getAgentsDatabase().prepare(
    "SELECT id,content,created_at,updated_at FROM assistant_memories WHERE organization_id=? AND user_id=? ORDER BY created_at ASC LIMIT ?"
  ).all(orgId, userId, MAX_MEMORIES));
}

export async function saveAssistantMemory(orgId: string, userId: string, content: string, memoryId = "") {
  const value = String(content ?? "").trim();
  if (!value || value.length > 500) throw new Error("Memory must be between 1 and 500 characters.");
  const db = getAgentsDatabase();
  const now = new Date().toISOString();
  if (memoryId) {
    const result = await db.prepare("UPDATE assistant_memories SET content=?,updated_at=? WHERE id=? AND organization_id=? AND user_id=?")
      .run(value, now, memoryId, orgId, userId);
    if (!Number(result.changes)) throw new Error("Memory was not found.");
    return memoryId;
  }
  const count = await db.prepare("SELECT COUNT(*) AS total FROM assistant_memories WHERE organization_id=? AND user_id=?").get(orgId, userId);
  if (Number(count?.total ?? 0) >= MAX_MEMORIES) throw new Error("Memory is full. Remove an entry before adding another.");
  const id = `memory_${randomUUID().replace(/-/g, "")}`;
  await db.prepare("INSERT INTO assistant_memories (id,organization_id,user_id,content,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(id, orgId, userId, value, now, now);
  return id;
}

export async function deleteAssistantMemory(orgId: string, userId: string, id: string) {
  const result = await getAgentsDatabase().prepare("DELETE FROM assistant_memories WHERE organization_id=? AND user_id=? AND id=?")
    .run(orgId, userId, id);
  return Number(result.changes) > 0;
}

export async function clearAssistantMemories(orgId: string, userId: string) {
  await getAgentsDatabase().prepare("DELETE FROM assistant_memories WHERE organization_id=? AND user_id=?")
    .run(orgId, userId);
}
