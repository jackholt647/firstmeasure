import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// A project starts only through receiveLead or createProject
// (docs/architecture/opportunities.md). Every other server write to a project
// document must not be able to create one: it passes `mustExist`, an
// `expected_revision`, or is one of the two entry points.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", "dist", "tests", "scripts", ".git"]);
// The entry points, the generic project routes (which create through projects/create.ts),
// and development fixtures that seed sample data.
const ENTRY_FILES = new Set([
  "leads/receive.ts",
  "projects/create.ts",
  "platform/api.ts#upsertProjectDocumentPreservingEvents",
  "development/roofing-company.ts"
]);

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...await sourceFiles(path.join(dir, entry.name)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(path.join(dir, entry.name));
  }
  return out;
}

/** The text of a call from its opening parenthesis to the matching close. */
function callText(source: string, open: number) {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0) return source.slice(open, i + 1);
  }
  return source.slice(open);
}

/** The function a position sits in, by the nearest preceding declaration. */
function enclosingFunction(source: string, at: number) {
  const before = source.slice(0, at);
  const matches = [...before.matchAll(/(?:async\s+)?function\s+([A-Za-z0-9_]+)/g)];
  return matches.length ? matches[matches.length - 1]![1] : "";
}

export async function projectCreatingWrites() {
  const offenders: string[] = [];
  for (const file of await sourceFiles(ROOT)) {
    const relative = path.relative(ROOT, file).split(path.sep).join("/");
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/upsertDocument\(\s*[A-Za-z0-9_.]+\s*,\s*["']projects["']/g)) {
      const at = match.index!;
      const call = callText(source, at + "upsertDocument".length);
      if (/mustExist\s*:\s*true|expected_revision\s*:|contactsProjection\s*:\s*true/.test(call)) continue;
      if (ENTRY_FILES.has(relative) || ENTRY_FILES.has(`${relative}#${enclosingFunction(source, at)}`)) continue;
      offenders.push(`${relative}:${source.slice(0, at).split("\n").length}`);
    }
  }
  return offenders;
}

test("only the two entry points can create a project", async () => {
  assert.deepEqual(await projectCreatingWrites(), [], "pass { mustExist: true } or an expected_revision, or create through projects/create.ts");
});
