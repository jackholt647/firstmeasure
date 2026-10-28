#!/usr/bin/env node
// Live layer sync (docs/architecture/live-layer.md).
//
// Runs beside any checkout (the dev sync droplet's, or a PC's). Every browser file under public/ that differs from the base
// (the merge-base of HEAD and the canonical branch; committed or not, plus untracked files) is sent to the
// receiver on the development web host, which serves it ahead of the release at once; every open dev page swaps
// it in. A file that goes back to the base leaves the layer. Server code, PHP and HTML pages still need a rollout.
//
//   node tools/live-layer/live-sync.mjs [serve] [--root .] [--base <ref>] [--once]
//   node tools/live-layer/live-sync.mjs status
//   node tools/live-layer/live-sync.mjs clear [<path under public/> ...]   (none: every file this checkout put live)
//
// Several checkouts may sync at once. Each file belongs to the checkout that put it live (--source, default
// <host>:<checkout>); another checkout's save of the same file is refused until the owner's copy leaves the layer
// (`clear <path>` takes it out whoever owns it).
//
// The receiver is reached over SSH with a key that can only run it (--target, --key), or run locally for tests
// (--receiver "python3 tools/live-layer/fm-live-receive.py serve"). Without --target, every dev web node the router
// names in its status document gets each save (the pool adds and removes nodes; the list is read again every minute).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { classify, parseNameStatus } from "../frontend-bridge/bridge.mjs";

const DEFAULT_BASE = "codex/consolidated-firstmeasure-20260923";
const DEFAULT_TARGET = "fmlive@143.198.68.11";
const DEFAULT_KEY = path.join(os.homedir(), ".ssh", "fm_live_ed25519");
const TEXT = new Set([".js", ".mjs", ".css", ".json", ".map", ".txt", ".svg"]);
const REFRESH_MS = 5000;
const CHECK_MS = 15_000;

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

function git(root, args, encoding = "utf8") {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: root, encoding, maxBuffer: 256 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args.join(" ")}: ${String(stderr || error.message).trim()}`));
      else resolve(stdout);
    });
  });
}

/** sha1 of the bytes with line endings folded for text, as the receiver and the page hash them. */
export function liveHash(rel, bytes) {
  const folded = TEXT.has(path.extname(rel).toLowerCase()) ? Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n")) : bytes;
  return crypto.createHash("sha1").update(folded).digest("hex");
}

/** What the layer should hold: { rel: { sha, base, repoPath } } for browser files that differ from the base. */
export async function desiredFiles(root, baseRef) {
  const ref = (await git(root, ["rev-parse", "--verify", "--quiet", baseRef]).catch(() => "")).trim() ? baseRef : "HEAD";
  const base = (await git(root, ["merge-base", ref, "HEAD"])).trim();
  const [diff, untracked] = await Promise.all([
    git(root, ["-c", "core.quotepath=off", "diff", "--name-status", "-z", "--no-renames", base, "--", "public"]),
    git(root, ["-c", "core.quotepath=off", "ls-files", "--others", "--exclude-standard", "-z", "--", "public"])
  ]);
  const changed = new Map(parseNameStatus(diff).map((entry) => [entry.path, entry.status]));
  for (const file of untracked.split("\0").filter(Boolean)) changed.set(file, "A");
  const files = {};
  const rollout = [];
  await Promise.all([...changed].map(async ([repoPath, status]) => {
    const kind = classify(repoPath);
    if (kind === "outside") return;
    const rel = repoPath.slice("public/".length);
    if (kind !== "browser" || status === "D") { rollout.push(rel); return; }
    let bytes;
    try { bytes = fs.readFileSync(path.join(root, repoPath)); } catch { return; }
    const sha = liveHash(rel, bytes);
    const baseSha = await git(root, ["show", `${base}:${repoPath}`], "buffer").then((old) => liveHash(rel, old), () => null);
    if (sha !== baseSha) files[rel] = { sha, base: baseSha, repoPath };
  }));
  return { base, files, rollout: rollout.sort() };
}

/** The receiver as a request/response channel over its stdin and stdout. */
class Receiver {
  constructor(command) { this.command = command; this.pending = new Map(); this.id = 0; this.child = null; }
  start() {
    const [file, ...args] = this.command;
    this.child = spawn(file, args, { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
    this.child.on("exit", (code) => {
      for (const { reject } of this.pending.values()) reject(new Error(`receiver exited (${code})`));
      this.pending.clear();
      this.child = null;
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const waiting = this.pending.get(message.id);
      if (waiting) { this.pending.delete(message.id); waiting.resolve(message); }
    });
  }
  request(body) {
    if (!this.child) this.start();
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ ...body, id }) + "\n");
    });
  }
  stop() { this.child?.stdin.end(); }
}

function receiverCommand(args, target = args.target) {
  if (args.receiver) return String(args.receiver).split(" ").filter(Boolean);
  const jump = args.jump ? ["-J", String(args.jump)] : [];
  const hostKey = args.knownHosts ? ["-o", `UserKnownHostsFile=${args.knownHosts}`, "-o", "StrictHostKeyChecking=yes"] : ["-o", "StrictHostKeyChecking=accept-new"];
  return ["ssh", "-T", "-o", "BatchMode=yes", ...hostKey, "-o", "ServerAliveInterval=15", "-o", "ConnectTimeout=10", ...jump, "-i", args.key || DEFAULT_KEY, target || DEFAULT_TARGET, "serve"];
}

/**
 * Without --target, the receivers are the web nodes the dev push router names in its status document (fetched over
 * TLS, with each receiver's SSH host key, which are then the only keys accepted): `target` is the primary, `targets`
 * every web node. The old fixed address otherwise.
 */
async function resolveReceiver(args) {
  if (args.target || args.receiver) return { ...args, targets: [args.target || DEFAULT_TARGET] };
  try {
    const response = await fetch(process.env.DEV_PUSH_STATUS_URL || "https://dev.1m8.ai/__dev-push/status.json", { signal: AbortSignal.timeout(8000) });
    const live = (await response.json())?.live;
    const listed = (live?.targets?.length ? live.targets : [live]).filter((item) => item?.target && item?.host_key);
    if (listed.length) {
      const knownHosts = path.join(os.homedir(), ".ssh", "fm-live-known-hosts");
      fs.mkdirSync(path.dirname(knownHosts), { recursive: true });
      fs.writeFileSync(knownHosts, listed.map((item) => `${item.host_key}\n`).join(""));
      return { ...args, target: listed[0].target, targets: listed.map((item) => item.target), knownHosts, discovered: true };
    }
  } catch {}
  return { ...args, targets: [DEFAULT_TARGET] };
}

/** Who this sync is to the receiver: the files it owns there. */
const sourceOf = (args, root) => String(args.source || `${os.hostname()}:${root.replaceAll("\\", "/")}`);

/** Sends what changed since the receiver's manifest. Files it refused or the release already has are not resent until they change. */
export async function reconcile(root, baseRef, receiver, memo, log = console.log, source = "default") {
  const { base: commit, files, rollout } = await desiredFiles(root, baseRef);
  const current = (await receiver.request({ op: "list" })).files || {};
  const ops = [];
  for (const [rel, entry] of Object.entries(files)) {
    const key = `${rel}\0${entry.sha}\0${entry.base}`;
    if (current[rel]?.sha === entry.sha || (memo.has(key) && !(memo.get(key).until < Date.now()))) continue;
    const data = fs.readFileSync(path.join(root, entry.repoPath));
    if (liveHash(rel, data) !== entry.sha) continue; // written again since it was hashed; the next pass sends it
    ops.push({ op: "put", path: rel, sha: entry.sha, base: entry.base, commit, data: data.toString("base64"), key });
  }
  for (const [rel, entry] of Object.entries(current)) if (!files[rel] && entry.source === source) ops.push({ op: "remove", path: rel });
  const results = [];
  if (ops.length) {
    const started = Date.now();
    const response = await receiver.request({ op: "batch", source, ops: ops.map(({ key, ...op }) => op) });
    for (const [index, result] of (response.results || []).entries()) {
      const op = ops[index];
      results.push(result);
      const seen = memo.has(op.key);
      // Another checkout's file is asked for again every 30 s, in case its owner cleared it.
      if (result.error === "owned-by-other") memo.set(op.key, { ...result, until: Date.now() + 30_000 });
      else if (!result.ok || result.state === "released") memo.set(op.key, result);
      if (result.error === "owned-by-other") { if (!seen) log(`REFUSED  ${result.path}: ${result.owner} has its own copy live. Ask them, or take it out with \`live-sync.mjs clear ${result.path}\`.`); continue; }
      if (result.ok) log(`${result.state.padEnd(8)} ${result.path}  (${Date.now() - started} ms)`);
      else if (result.error === "dev-differs") log(`REFUSED  ${result.path}: dev's release changed this file since your base. Update the checkout (git pull / merge the canonical branch) and save again.`);
      else log(`REFUSED  ${result.path}: ${result.error}`);
    }
  }
  return { results, rollout };
}

async function serve(args) {
  args = await resolveReceiver(args);
  const root = path.resolve(args.root || ".");
  const baseRef = args.base || DEFAULT_BASE;
  const source = sourceOf(args, root);
  // One receiver per web node; the first is the primary and the only one whose answers are printed (the others
  // print only what they refuse). A node that does not answer is retried every pass and catches up when it does.
  const receivers = new Map();
  const connect = (targets) => {
    for (const [target, item] of receivers) if (!targets.includes(target)) { item.receiver.stop(); receivers.delete(target); }
    for (const target of targets) if (!receivers.has(target)) receivers.set(target, { receiver: new Receiver(receiverCommand(args, target)), memo: new Map() });
  };
  connect(args.targets);
  let running = false, again = false, lastRollout = "";
  const lastError = new Map();
  const run = async () => {
    if (running) { again = true; return; }
    running = true;
    try {
      const passes = [...receivers].map(async ([target, { receiver, memo }], index) => {
        const quiet = (line) => { if (line.startsWith("REFUSED")) console.log(`[${target}] ${line}`); };
        try {
          const result = await reconcile(root, baseRef, receiver, memo, index === 0 ? console.log : quiet, source);
          if (lastError.get(target)) { console.log(`live-sync: ${target} answers again`); lastError.delete(target); }
          return result;
        } catch (error) {
          if (lastError.get(target) !== error.message) console.error(`live-sync: ${target}: ${error.message}`);
          lastError.set(target, error.message);
          return null;
        }
      });
      const { rollout = [] } = (await Promise.all(passes)).find(Boolean) || {};
      const listed = rollout.join(", ");
      if (listed && listed !== lastRollout) console.log(`needs a rollout (not live): ${listed}`);
      lastRollout = listed;
    } catch (error) { console.error(`live-sync: ${error.message}`); }
    finally { running = false; if (again) { again = false; setTimeout(run, 10); } }
  };
  await run();
  if (args.once) { for (const { receiver } of receivers.values()) receiver.stop(); return; }
  if (args.discovered) setInterval(async () => {
    const next = await resolveReceiver({ ...args, target: undefined, discovered: undefined });
    if (next.discovered && next.targets.join(" ") !== [...receivers.keys()].join(" ")) {
      console.log(`live-sync: web nodes now ${next.targets.join(", ")}`);
      connect(next.targets);
      run();
    }
  }, 60_000);
  let timer = null;
  fs.watch(path.join(root, "public"), { recursive: true }, (_event, name) => {
    const file = String(name || "").replaceAll("\\", "/");
    if (/^(v1|storage)\//.test(file) || file.includes("node_modules/")) return;
    clearTimeout(timer);
    timer = setTimeout(run, 40);
  });
  setInterval(run, REFRESH_MS);
  setInterval(() => [...receivers.values()].forEach(({ receiver }, index) => receiver.request({ op: "check" }).then((result) => {
    if (index !== 0) return;
    for (const [rel, reason] of Object.entries(result.retired || {})) {
      if (reason === "parked") console.log(`parked   ${rel}: the release changed this file under your edit; the router merges your version into the next release`);
      else console.log(`${reason.padEnd(8)} ${rel} left the layer (${reason === "released" ? "the release has it now" : "the release changed it under this edit"})`);
    }
  }).catch(() => {})), CHECK_MS);
  console.log(`live-sync: ${root} -> ${[...receivers.keys()].join(", ")} as ${source} (base ${baseRef}). Saves under public/ are live on dev.1m8.ai.`);
  process.on("SIGINT", () => { for (const { receiver } of receivers.values()) receiver.stop(); process.exit(0); });
}

async function status(args) {
  args = await resolveReceiver(args);
  const root = path.resolve(args.root || ".");
  const receiver = new Receiver(receiverCommand(args));
  const [listed, desired] = await Promise.all([receiver.request({ op: "list" }), desiredFiles(root, args.base || DEFAULT_BASE)]);
  receiver.stop();
  const files = listed.files || {};
  const source = sourceOf(args, root);
  console.log(`Live on dev.1m8.ai (gen ${listed.gen}): ${Object.keys(files).length} file(s). This checkout is ${source}.`);
  for (const [rel, entry] of Object.entries(files).sort()) {
    const mine = desired.files[rel];
    const owner = entry.source === source ? "" : `  from ${entry.source || "unknown"}`;
    console.log(`  ${rel}  ${entry.sha.slice(0, 12)}${owner}${mine && entry.source === source && mine.sha !== entry.sha ? "  (this checkout has newer bytes; is live-sync running?)" : ""}`);
  }
  const parked = Object.entries(listed.parked || {}).filter(([, entry]) => entry.source === source).sort();
  for (const [rel, entry] of parked) console.log(`  parked: ${rel}  ${entry.sha.slice(0, 12)} (the release changed it under this edit; the router merges this version into the next release)`);
  for (const rel of Object.keys(desired.files).filter((rel) => !files[rel] && !listed.parked?.[rel]).sort()) console.log(`  not live: ${rel} (released already, refused, or live-sync not running)`);
  if (desired.rollout.length) console.log(`Needs a rollout: ${desired.rollout.join(", ")}`);
}

async function clear(args) {
  if (!args.targets) args = await resolveReceiver(args);
  if (args.targets.length > 1) {
    // Every web node: the primary's answers are printed; the router copies the primary's layer to the rest anyway.
    await Promise.all(args.targets.slice(1).map((target) => clear({ ...args, target, targets: [target], quiet: true }).catch(() => {})));
    args = { ...args, targets: [args.target] };
  }
  const log = args.quiet ? () => {} : console.log;
  const root = path.resolve(args.root || ".");
  const receiver = new Receiver(receiverCommand(args));
  const source = sourceOf(args, root);
  const named = args._.slice(1).map((rel) => rel.replace(/^\/?(public\/)?/, ""));
  const listed = await receiver.request({ op: "list" });
  const files = listed.files || {};
  const paths = named.length ? named : Object.keys(files).filter((rel) => files[rel].source === source);
  // This checkout's parked saves go too (a named path's forced remove takes its parked save with it).
  const parked = named.length ? [] : Object.keys(listed.parked || {}).filter((rel) => listed.parked[rel].source === source && !paths.includes(rel));
  const response = await receiver.request({ op: "batch", source, ops: paths.map((rel) => ({ op: "remove", path: rel, force: Boolean(named.length) })) });
  const unparked = [];
  for (const rel of parked) unparked.push(await receiver.request({ op: "unpark", path: rel }));
  receiver.stop();
  for (const result of [...(response.results || []), ...unparked]) log(`${result.ok ? result.state : `REFUSED (${result.error})`}  ${result.path}`);
  if (!paths.length && !parked.length) log("Nothing of this checkout's is live.");
  if (args._.length === 1 && !named.length) log("A running live-sync puts this checkout's changed files back within 5 s; stop it first to keep them out.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = parseArgs(process.argv.slice(2));
  (args._[0] === "status" ? status(args) : args._[0] === "clear" ? clear(args) : serve(args)).catch((error) => { console.error(error.message); process.exit(1); });
}
