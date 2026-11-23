#!/usr/bin/env node
// Editing a setup live (docs/architecture/guided-experiences.md, "Editing a setup live").
//
//   node tools/live-layer/hot-edit.mjs start <experience id>[/<step id>] [--note "what is changing"] [--issue GP-12]
//   node tools/live-layer/hot-edit.mjs done  <experience id>
//   node tools/live-layer/hot-edit.mjs list
//
// `start` puts a small signal file on the live layer (libraries/hot-edits/<experience id>.json): every open dev page
// showing that setup draws the working spinner beside its X within about a second. Then make the change: a step
// module or CSS saved through live-sync is swapped into the open setup in place; a config library save (the
// experience, a setup step, copy) is read again when you say `done`. `done` takes the signal off the layer, and every
// open copy of the setup reads its definition again and redraws the step it is on, with no page refresh.
//
// Any agent may start or finish any setup's signal (they share one owner, "hot-edits"); a signal older than 15
// minutes is ignored by pages. The router never bakes these files into a release (router/live.mjs). Development only.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Receiver, liveHash, receiverCommand, resolveReceiver } from "./live-sync.mjs";

const SOURCE = "hot-edits";
export const HOT_DIR = "libraries/hot-edits/";
/** The signal file's name for an experience id: the same rule as the page (guided-setup.js hotFile). */
export const hotFile = (id) => `${HOT_DIR}${String(id).replace(/[^A-Za-z0-9._-]/g, "_")}.json`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith("--")) { args._.push(item); continue; }
    const [key, inline] = item.slice(2).split(/=(.*)/s, 2);
    if (inline !== undefined) args[key] = inline;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) args[key] = argv[++i];
    else args[key] = true;
  }
  return args;
}

/** Sends the ops to every dev web node; the primary's answers are returned. */
async function send(args, ops) {
  const resolved = await resolveReceiver(args);
  const answers = await Promise.all(resolved.targets.map(async (target) => {
    const receiver = new Receiver(receiverCommand(resolved, target));
    try { return await receiver.request(ops ? { op: "batch", source: SOURCE, ops } : { op: "list" }); }
    catch (error) { return { error: error.message }; }
    finally { receiver.stop(); }
  }));
  return answers[0];
}

export function signalBytes({ id, step = "", note = "", issue = "", by = "" }) {
  return Buffer.from(JSON.stringify({ v: 1, experience: id, step, state: "working", note, issue, by, at: new Date().toISOString() }) + "\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command, target] = args._;
  if (command === "list") {
    const listed = await send(args, null);
    const files = Object.entries(listed.files || {}).filter(([rel]) => rel.startsWith(HOT_DIR));
    if (!files.length) console.log("No setup is being edited live.");
    for (const [rel, entry] of files) console.log(`${rel}  since ${new Date((entry.at || 0) * 1000).toISOString()}`);
    return;
  }
  if (!["start", "done"].includes(command) || !target) {
    console.error('usage: hot-edit.mjs start <experience id>[/<step id>] [--note "..."] [--issue GP-1] | done <experience id> | list');
    process.exitCode = 1;
    return;
  }
  const [id, step = ""] = String(target).split("/");
  const rel = hotFile(id);
  if (command === "start") {
    const data = signalBytes({ id, step, note: String(args.note || "").slice(0, 300), issue: String(args.issue || "").slice(0, 40), by: String(process.env.DEV_PUSH_AGENT || args.by || "").slice(0, 80) });
    const answer = await send(args, [{ op: "put", path: rel, sha: liveHash(rel, data), base: null, data: data.toString("base64") }]);
    const result = answer.results?.[0] || answer;
    if (!result.ok) { console.error(`hot-edit: ${result.error || "the live layer refused the signal"}`); process.exitCode = 1; return; }
    console.log(`working  ${id}${step ? `/${step}` : ""}: open copies show the spinner. Save your change (live-sync / config library), then: hot-edit.mjs done ${id}`);
    return;
  }
  const answer = await send(args, [{ op: "remove", path: rel, force: true }]);
  const result = answer.results?.[0] || answer;
  console.log(result.ok || /not[- ]live|missing|absent/.test(String(result.error)) ? `done     ${id}: open copies redraw with the new definition` : `hot-edit: ${result.error}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => { console.error(`hot-edit: ${error.message}`); process.exitCode = 1; });
}
