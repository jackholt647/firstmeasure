#!/usr/bin/env node
// Edit the platform config library on dev (docs/architecture/config-library.md). Defaults are data: change them
// here, not in code. Every write is a new revision on dev.1m8.ai, read by every dev process within a second.
//
// Key: a config library access key (fmck_...) a platform administrator created (dev console, or POST
// /v1/config-library/keys). Put it in FM_CONFIG_LIBRARY_KEY or in ~/.config/firstmate/config-library-key.
// Never print or commit it. Origin: FM_DEV_ORIGIN (default https://dev.1m8.ai).
//
//   node tools/config-library/cli.mjs kinds
//   node tools/config-library/cli.mjs list <kind> [query]
//   node tools/config-library/cli.mjs get <kind> <id> [--out file.json]       (prints {revision, data})
//   node tools/config-library/cli.mjs check <kind> <id> <file.json>            (save-time checks, nothing saved)
//   node tools/config-library/cli.mjs put <kind> <id> <file.json> [--note "why"] [--revision N]
//   node tools/config-library/cli.mjs history <kind> <id>
//   node tools/config-library/cli.mjs revert <kind> <id> <revision> [--note "why"]
//   node tools/config-library/cli.mjs delete <kind> <id> [--note "why"]
//   node tools/config-library/cli.mjs changes [kind]
//   node tools/config-library/cli.mjs upload <image file>                      (prints asset:<sha256> to use in an entry)
//
// `put` takes the file's `data` (or the whole file when it has no `data`) and, unless --revision is given, the
// revision `get` wrote into the file, so an edit made meanwhile by someone else is refused, not overwritten.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => { const index = args.indexOf(name); if (index < 0) return undefined; const value = args[index + 1]; args.splice(index, 2); return value; };
const origin = (process.env.FM_DEV_ORIGIN || "https://dev.1m8.ai").replace(/\/+$/, "");
const keyFile = path.join(os.homedir(), ".config", "firstmate", "config-library-key");
const key = (process.env.FM_CONFIG_LIBRARY_KEY || (existsSync(keyFile) ? readFileSync(keyFile, "utf8") : "")).trim();

async function call(method, route, body) {
  if (!key) { console.error(`No key: set FM_CONFIG_LIBRARY_KEY or write it to ${keyFile}. A platform administrator creates one in the dev console.`); process.exit(2); }
  const response = await fetch(`${origin}/v1/config-library${route}`, { method, headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let json; try { json = JSON.parse(text); } catch { json = { message: text }; }
  if (!response.ok) {
    console.error(`${method} ${route}: ${response.status} ${json.error || ""} ${json.message || ""}`.trim());
    for (const error of json.details?.errors || []) console.error(`  - ${error}`);
    if (json.details?.revision !== undefined) console.error(`  current revision: ${json.details.revision}`);
    process.exit(1);
  }
  return json;
}
const enc = encodeURIComponent;
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const print = (value) => console.log(JSON.stringify(value, null, 2));

const [command, kind, id, extra] = args;
const note = flag("--note");
const out = flag("--out");
const revisionFlag = flag("--revision");
switch (command) {
  case "kinds": {
    const { kinds, source } = await call("GET", "/kinds");
    console.log(`source: ${source}`);
    for (const item of kinds) console.log(`${item.kind.padEnd(28)} ${String(item.count).padStart(4)}  ${item.append_only ? "append-only " : ""}${item.title}`);
    break;
  }
  case "list": {
    const { entries } = await call("GET", `/entries?kind=${enc(kind || "")}&q=${enc(id || "")}`);
    for (const entry of entries) console.log(`${entry.kind}/${entry.id}  r${entry.revision}  ${entry.title}  (${entry.updated_by}, ${entry.updated_at})`);
    break;
  }
  case "get": {
    const { entry } = await call("GET", `/entries/${enc(kind)}/${enc(id)}`);
    const value = { kind: entry.kind, id: entry.id, revision: entry.revision, data: entry.data };
    if (out) { writeFileSync(out, JSON.stringify(value, null, 2) + "\n"); console.log(`Wrote ${out} (revision ${entry.revision}).`); } else print(value);
    break;
  }
  case "check": {
    const file = readJson(extra);
    const result = await call("POST", "/check", { kind, id, data: file.data ?? file });
    console.log(result.ok ? "OK" : result.errors.map((error) => `- ${error}`).join("\n"));
    process.exit(result.ok ? 0 : 1);
  }
  case "put": {
    const file = readJson(extra);
    const expected = revisionFlag !== undefined ? Number(revisionFlag) : file.revision;
    const result = await call("PUT", `/entries/${enc(kind)}/${enc(id)}`, { data: file.data ?? file, ...(expected !== undefined ? { expected_revision: Number(expected) } : {}), ...(note ? { note } : {}) });
    console.log(result.changed ? `Saved ${kind}/${id} as revision ${result.entry.revision}. Live on dev within a second.` : `No change: ${kind}/${id} is already that (revision ${result.entry.revision}).`);
    break;
  }
  case "history": {
    const { revisions } = await call("GET", `/entries/${enc(kind)}/${enc(id)}/revisions`);
    for (const revision of revisions) console.log(`r${revision.revision}  ${revision.action.padEnd(7)} ${revision.updated_at}  ${revision.updated_by}${revision.note ? `  "${revision.note}"` : ""}`);
    break;
  }
  case "revert": {
    const result = await call("POST", `/entries/${enc(kind)}/${enc(id)}/revert`, { revision: Number(extra), ...(note ? { note } : {}) });
    console.log(result.entry ? `${kind}/${id} is back to revision ${extra}'s content, as revision ${result.entry.revision}.` : `${kind}/${id} is deleted again (revision ${extra} was a delete).`);
    break;
  }
  case "delete": {
    await call("DELETE", `/entries/${enc(kind)}/${enc(id)}${note ? `?note=${enc(note)}` : ""}`);
    console.log(`Deleted ${kind}/${id} (a revision; revert brings it back).`);
    break;
  }
  case "changes": {
    const { changes } = await call("GET", `/changes?limit=30${kind ? `&kind=${enc(kind)}` : ""}`);
    for (const change of changes) console.log(`${change.at}  ${change.kind}/${change.id} r${change.revision} ${change.action}  ${change.author}${change.note ? `  "${change.note}"` : ""}`);
    break;
  }
  case "upload": {
    const file = kind;
    const { asset } = await call("POST", "/assets", { file_name: path.basename(file), data_base64: readFileSync(file).toString("base64") });
    console.log(`${asset.ref}  (${asset.content_type}, ${asset.size_bytes} bytes, ${origin}${asset.url})`);
    break;
  }
  default:
    console.error(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((line) => line.startsWith("//")).map((line) => line.slice(3)).join("\n"));
    process.exit(command ? 2 : 0);
}
