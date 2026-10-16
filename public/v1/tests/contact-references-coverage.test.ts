import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { CONTACT_TABLES_KEPT, PROJECT_TABLES_KEPT, coveredTables } from "../contacts/references.js";

// Every SQL table that stores a contact or project id must say what a merge does
// with it: moved by an adapter (contacts/references.ts) or kept, with a reason.
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name);
    if (["node_modules", "dist", "tests"].includes(name)) return [];
    return statSync(full).isDirectory() ? sources(full) : name.endsWith(".ts") ? [full] : [];
  });
}
function tablesWith(column: string) {
  const tables = new Set<string>();
  for (const file of sources(path.resolve(import.meta.dirname, ".."))) {
    const code = readFileSync(file, "utf8");
    for (const match of code.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\s*\)/g)) if (new RegExp(`\\b${column}\\b`).test(match[2]!)) tables.add(match[1]!);
    for (const match of code.matchAll(new RegExp(`ensureSqlColumn\\(\\w+,\\s*"(\\w+)",\\s*"${column}"`, "g"))) tables.add(match[1]!);
  }
  return tables;
}

test("every table holding a contact id is moved by a merge or kept on purpose", () => {
  const covered = coveredTables("contact");
  const missing = [...tablesWith("contact_id")].filter(table => !covered.has(table) && !CONTACT_TABLES_KEPT[table]);
  assert.deepEqual(missing, [], "add these tables to a contact reference adapter or to CONTACT_TABLES_KEPT with a reason");
});

test("every table holding a project id is moved by a merge or kept on purpose", () => {
  const covered = coveredTables("project");
  const missing = [...tablesWith("project_id")].filter(table => !covered.has(table) && !PROJECT_TABLES_KEPT[table]);
  assert.deepEqual(missing, [], "add these tables to a project reference adapter or to PROJECT_TABLES_KEPT with a reason");
});
