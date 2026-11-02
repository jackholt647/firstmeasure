#!/usr/bin/env node
// Read and set feature flags per organization (docs/architecture/feature-flags.md). The same API as the console; every
// change is in the audit log under the key's name. A platform administrator creates a key in the console: Ctrl+Shift+F
// in /measure/internal, Agent keys tab. Never print, copy or commit a key.
//
// Key: FM_FLAGS_KEY, or ~/.config/firstmate/feature-flags-key (with --prod, ~/.config/firstmate/feature-flags-key-prod).
// Origin: https://dev.1m8.ai, or https://app.1m8.ai with --prod, or FM_FLAGS_ORIGIN.
//
//   node tools/feature-flags/cli.mjs list [filter]                      every flag, how many organizations have it on
//   node tools/feature-flags/cli.mjs org <id|name|email>                one organization's flags
//   node tools/feature-flags/cli.mjs set <org id> <flag> on|off|auto [--note "why"]
//   node tools/feature-flags/cli.mjs resolve <file|->                   what a pasted list of ids, names, emails matches
//   node tools/feature-flags/cli.mjs bulk <flag> on|off|auto <file|-> [--note "why"] [--include-ambiguous]
//   node tools/feature-flags/cli.mjs coverage <flag> <percent>          how many a percentage would cover, without saving
//   node tools/feature-flags/cli.mjs percent <flag> <percent> [--note "why"]
//   node tools/feature-flags/cli.mjs kill <flag> | restore <flag>       off for everyone, and back
//   node tools/feature-flags/cli.mjs audit [--flag key] [--org id] [--limit n]
//
// `auto` clears an explicit value, so the organization follows the default and any percentage again.
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(name); if (index < 0) return undefined; const value = args[index + 1]; args.splice(index, 2); return value; };
const toggle = (name) => { const index = args.indexOf(name); if (index < 0) return false; args.splice(index, 1); return true; };
const prod = toggle("--prod");
const note = option("--note");
const origin = (process.env.FM_FLAGS_ORIGIN || (prod ? "https://app.1m8.ai" : "https://dev.1m8.ai")).replace(/\/+$/, "");
const keyFile = path.join(os.homedir(), ".config", "firstmate", prod ? "feature-flags-key-prod" : "feature-flags-key");
const key = (process.env.FM_FLAGS_KEY || (existsSync(keyFile) ? readFileSync(keyFile, "utf8") : "")).trim();

async function call(method, route, body) {
  if (!key) { console.error(`No key in ${keyFile}. A platform administrator creates one in the console (Ctrl+Shift+F in /measure/internal, Agent keys).`); process.exit(2); }
  const response = await fetch(`${origin}/v1/internal/flags${route}`, { method, headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let json; try { json = JSON.parse(text); } catch { json = { message: text.slice(0, 300) }; }
  if (!response.ok) { console.error(`${method} ${route}: ${response.status} ${json.error || ""} ${json.message || ""}`.trim()); process.exit(1); }
  return json;
}
const enc = encodeURIComponent;
const print = (value) => console.log(JSON.stringify(value, null, 2));
const stdinOrFile = (source) => readFileSync(source === "-" ? 0 : source, "utf8");
function value(word) {
  if (word === "on") return true;
  if (word === "off") return false;
  if (word === "auto") return null;
  console.error(`Expected on, off or auto, got "${word}".`);
  process.exit(2);
}
const usage = () => { console.error(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((line) => line.startsWith("//   ")).map((line) => line.slice(5)).join("\n")); process.exit(2); };

const [command, first, second, third] = args;
switch (command) {
  case "list": {
    const catalog = await call("GET", "/catalog");
    const needle = String(first || "").toLowerCase();
    console.log(`${catalog.total_orgs} organizations, counted ${new Date(catalog.computed_at).toISOString()}`);
    for (const flag of catalog.flags) {
      if (needle && !`${flag.key} ${flag.label}`.toLowerCase().includes(needle)) continue;
      const rollout = [flag.rollout?.percent ? `${flag.rollout.percent}%` : "", flag.rollout?.killed ? "off for everyone" : ""].filter(Boolean).join(" ");
      console.log(`${flag.stats ? String(flag.stats.on).padStart(7) : "setting"}  ${flag.key}${rollout ? `  [${rollout}]` : ""}`);
    }
    break;
  }
  case "org": {
    if (!first) usage();
    const { organizations } = await call("GET", `/orgs?q=${enc(first)}`);
    if (organizations.length !== 1) { print({ matches: organizations }); break; }
    const detail = await call("GET", `/orgs/${enc(organizations[0].id)}`);
    print(detail.organization);
    for (const flag of detail.flags.filter((row) => row.type === "boolean")) console.log(`${flag.effective ? "on " : "off"}  ${flag.key}  (${flag.source})`);
    break;
  }
  case "set": {
    if (!first || !second || !third) usage();
    print(await call("PUT", `/orgs/${enc(first)}/flags/${enc(second)}`, { value: value(third), ...(note ? { note } : {}) }));
    break;
  }
  case "resolve": {
    if (!first) usage();
    print(await call("POST", "/resolve", { text: stdinOrFile(first) }));
    break;
  }
  case "bulk": {
    if (!first || !second || !third) usage();
    const resolved = await call("POST", "/resolve", { text: stdinOrFile(third) });
    const includeAmbiguous = toggle("--include-ambiguous");
    const chosen = resolved.entries.filter((row) => row.status === "matched" || (includeAmbiguous && row.status === "ambiguous"));
    for (const row of resolved.entries.filter((entry) => entry.status === "unmatched")) console.error(`not found: ${row.input}`);
    if (!includeAmbiguous) for (const row of resolved.entries.filter((entry) => entry.status === "ambiguous")) console.error(`ambiguous, skipped: ${row.input} (${row.organizations.map((org) => org.id).join(", ")})`);
    const orgIds = [...new Set(chosen.flatMap((row) => row.organizations.map((org) => org.id)))];
    if (!orgIds.length) { console.error("Nothing to apply."); process.exit(1); }
    print(await call("POST", "/bulk", { flag: first, value: value(second), org_ids: orgIds, ...(note ? { note } : {}) }));
    break;
  }
  case "coverage": {
    if (!first || second === undefined) usage();
    print(await call("GET", `/catalog/${enc(first)}/coverage?percent=${enc(second)}`));
    break;
  }
  case "percent": {
    if (!first || second === undefined) usage();
    print(await call("PUT", `/catalog/${enc(first)}/rollout`, { percent: Number(second), ...(note ? { note } : {}) }));
    break;
  }
  case "kill":
  case "restore": {
    if (!first) usage();
    print(await call("PUT", `/catalog/${enc(first)}/rollout`, { killed: command === "kill", ...(note ? { note } : {}) }));
    break;
  }
  case "audit": {
    const flag = option("--flag"), org = option("--org"), limit = option("--limit");
    const query = new URLSearchParams({ ...(flag ? { flag } : {}), ...(org ? { org } : {}), ...(limit ? { limit } : {}) });
    const { entries } = await call("GET", `/audit?${query}`);
    for (const entry of entries) console.log(`${new Date(entry.at).toISOString()}  ${entry.actor}  ${entry.summary}${entry.note ? `  (${entry.note})` : ""}  [${entry.id}]`);
    break;
  }
  default:
    usage();
}
