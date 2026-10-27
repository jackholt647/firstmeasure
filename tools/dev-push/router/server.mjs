#!/usr/bin/env node
// Entry point of the dev push router on the dev sync droplet (systemd user unit dev-push-router.service).
//
//   node tools/dev-push/router/server.mjs                 run every lane forever
//   node tools/dev-push/router/server.mjs once [<lane>]   one pass over each lane's queue, then exit
//   node tools/dev-push/router/server.mjs pause|resume <lane>
//   node tools/dev-push/router/server.mjs release [<lane>] [--force]   deploy the lane tip as it stands (re-baseline)
//   node tools/dev-push/router/server.mjs gate|build <ref> [--changed a,b]   diagnostics, no queue
//
// State lives in ~/dev-push (repo.git, state/, cache/, builds/). Settings: ~/dev-push/config.json
// { "lanes": ["platform", "measure-internal"], "intervalMs": 15000 }.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ORIGIN_URL, parseArgs, run } from "../lib/common.mjs";
import { makeHosts } from "./hosts.mjs";
import { Router } from "./router.mjs";
import { liveOverlays } from "./live.mjs";

const HOME = process.env.DEV_PUSH_HOME || path.join(os.homedir(), "dev-push");
const STATE = path.join(HOME, "state");
const KEY = path.join(os.homedir(), ".ssh", "dev_push_router_ed25519");
const here = path.dirname(fileURLToPath(import.meta.url));

function settings() {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, "config.json"), "utf8")); } catch { return {}; }
}

async function loadLanes(names) {
  const lanes = {};
  for (const name of names) {
    const file = path.join(here, "..", "lanes", name, "lane.mjs");
    if (!fs.existsSync(file)) { console.error(`lane ${name}: ${file} missing; skipped`); continue; }
    lanes[name] = (await import(pathToFileURL(file).href)).default;
  }
  return lanes;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "serve";
  fs.mkdirSync(STATE, { recursive: true });
  if (command === "pause" || command === "resume") {
    const file = path.join(STATE, "paused.json");
    const paused = new Set((() => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return []; } })());
    command === "pause" ? paused.add(args._[1]) : paused.delete(args._[1]);
    fs.writeFileSync(file, JSON.stringify([...paused]));
    console.log(`paused lanes: ${[...paused].join(", ") || "none"}`);
    return;
  }
  const config = settings();
  const names = config.lanes || ["platform", "measure-internal"];
  const lanes = await loadLanes(names);
  const hosts = makeHosts({ knownHosts: path.join(HOME, "known_hosts"), key: KEY });
  // Fetch over HTTPS (public repository); push with the router's deploy key.
  process.env.GIT_SSH_COMMAND = `ssh -i ${KEY} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${path.join(HOME, "known_hosts")}`;
  const version = (await run("git", ["rev-parse", "--short", "HEAD"], { cwd: here })).stdout.trim() || null;
  const router = new Router({
    repo: path.join(HOME, "repo.git"), remote: config.remote || ORIGIN_URL, stateDir: STATE, lanes, hosts, version,
    host: os.hostname(),
    publish: config.publish === false ? null : async (doc) => {
      const result = await hosts.call("web", ["publish"], { input: JSON.stringify(doc), timeoutMs: 60_000 });
      if (!result.ok) throw new Error(result.error);
    },
    ...(lanes.platform && config.live !== false ? liveOverlays({ hosts, home: HOME, log: (line) => console.log(`[live] ${line}`) }) : {})
  });
  await router.init();
  await router.git(["config", "remote.origin.pushurl", config.pushurl || "git@github.com:jackholt647/firstmeasure.git"]);
  if (command === "gate" || command === "build" || command === "stage") {
    // Diagnostics: run a lane's gates, build its release tree, or build and stage it on every role (no activation),
    // for any commit without touching the queue.
    const lane = args.lane || "platform";
    const ref = args._[1] || `refs/lanes/${lane}`;
    await router.fetch(lane);
    await router.git(["fetch", "--quiet", "origin", ref.startsWith("refs/") ? ref : `+refs/heads/${ref}:refs/diagnose/${lane}`], { allowFail: true });
    const sha = (await router.git(["rev-parse", ref.startsWith("refs/") ? ref : ((await router.git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFail: true })).code === 0 ? ref : `refs/diagnose/${lane}`)])).trim();
    const dir = await router.worktree(lane);
    await router.git(["reset", "--quiet", "--hard", sha], { cwd: dir });
    const started = Date.now();
    if (command === "gate") {
      const changed = String(args.changed || "").split(",").filter(Boolean);
      const result = await lanes[lane].gates({ dir, sha, baseSha: sha, changed, tests: [], log: console.log });
      console.log(JSON.stringify({ ok: result.ok, failures: result.failures.map((failure) => ({ id: failure.id, output: failure.output.slice(-1500) })), notes: result.notes, seconds: Math.round((Date.now() - started) / 1000) }, null, 1));
    } else {
      const result = command === "build"
        ? await lanes[lane].deploy({ dir, sha, releaseId: `${lane}-diagnose-${sha.slice(0, 8)}`, hosts: { roles: [], status: async () => ({ ok: true }) }, log: console.log, buildOnly: true })
        : await lanes[lane].deploy({ dir, sha, releaseId: `${lane}-diagnose-${sha.slice(0, 8)}`, hosts, log: console.log, stageOnly: true });
      console.log(JSON.stringify({ ...result, seconds: Math.round((Date.now() - started) / 1000) }, null, 1));
    }
    return;
  }
  if (command === "release") {
    console.log(JSON.stringify(await router.releaseTip(args._[1] || "platform", { force: Boolean(args.force) }), null, 1));
    return;
  }
  if (command === "once") {
    router.startedAt = new Date().toISOString();
    for (const lane of args._[1] ? [args._[1]] : Object.keys(lanes)) while (await router.processLane(lane)) { /* drain */ }
    await router.saveStatus();
    return;
  }
  await router.start({ intervalMs: config.intervalMs || 15_000 });
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
