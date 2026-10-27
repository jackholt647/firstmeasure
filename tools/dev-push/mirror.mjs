#!/usr/bin/env node
// Mirrors the router's branches to GitHub (docs/architecture/dev-lanes.md). The router's repository on the dev sync
// droplet is the source of truth; GitHub is a backup copy, pushed from a PC with its own GitHub login (the droplet
// holds no GitHub credential). submit.mjs starts this in the background after every submission; run it by hand any
// time. It never forces a lane branch: if GitHub has moved on its own, that branch is skipped and logged.
//
//   node tools/dev-push/mirror.mjs [--root <checkout>] [--quiet]
import fs from "node:fs";
import path from "node:path";
import { LANES, ROUTER_REMOTE, git, parseArgs, routerUrl } from "./lib/common.mjs";

const GITHUB_REMOTE = process.env.DEV_PUSH_MIRROR_REMOTE || "origin";
const STALE_LOCK_MS = 10 * 60_000;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root || (await git(process.cwd(), ["rev-parse", "--show-toplevel"])).trim());
  const gitDir = path.resolve(root, (await git(root, ["rev-parse", "--git-common-dir"])).trim());
  const logFile = path.join(gitDir, "dev-push-mirror.log");
  const say = (line) => { fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`); if (!args.quiet) console.log(line); };
  const github = await git(root, ["remote", "get-url", GITHUB_REMOTE], { allowFail: true });
  if (github.code !== 0 || !/github\.com/.test(github.stdout)) { say(`no GitHub remote named ${GITHUB_REMOTE}; nothing mirrored`); return; }

  // One mirror at a time per repository.
  const lock = path.join(gitDir, "dev-push-mirror.lock");
  try {
    const held = fs.statSync(lock, { throwIfNoEntry: false });
    if (held && Date.now() - held.mtimeMs < STALE_LOCK_MS) return;
    fs.writeFileSync(lock, String(process.pid));
  } catch { return; }
  try {
    const url = routerUrl();
    const remote = await git(root, ["remote", "get-url", ROUTER_REMOTE], { allowFail: true });
    if (remote.code !== 0) await git(root, ["remote", "add", ROUTER_REMOTE, url]);
    const branches = Object.values(LANES).map((lane) => lane.branch);
    const fetched = await git(root, ["fetch", "--quiet", "--prune", ROUTER_REMOTE, ...branches.map((branch) => `+refs/heads/${branch}:refs/remotes/${ROUTER_REMOTE}/${branch}`), `+refs/heads/live/*:refs/remotes/${ROUTER_REMOTE}/live/*`], { allowFail: true });
    if (fetched.code !== 0) { say(`fetch from the router failed: ${fetched.stderr.trim()}`); return; }
    const specs = [];
    for (const branch of branches) {
      const sha = await git(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/${ROUTER_REMOTE}/${branch}`], { allowFail: true });
      if (sha.code === 0) specs.push(`${sha.stdout.trim()}:refs/heads/${branch}`);
    }
    const lanes = await git(root, ["push", "--quiet", "--porcelain", GITHUB_REMOTE, ...specs], { allowFail: true });
    say(lanes.code === 0 ? `mirrored ${specs.length} lane branch(es) to GitHub` : `lane branches not mirrored (GitHub moved on its own?): ${lanes.stderr.trim() || lanes.stdout.trim()}`);
    // Live shadow branches are derived; they may be replaced.
    const live = (await git(root, ["for-each-ref", "--format=%(refname:strip=3)", `refs/remotes/${ROUTER_REMOTE}/live/`])).split("\n").filter(Boolean);
    if (live.length) {
      const pushed = await git(root, ["push", "--quiet", "--force", GITHUB_REMOTE, ...live.map((name) => `refs/remotes/${ROUTER_REMOTE}/${name}:refs/heads/${name}`)], { allowFail: true });
      say(pushed.code === 0 ? `mirrored ${live.length} live branch(es)` : `live branches not mirrored: ${pushed.stderr.trim()}`);
    }
  } finally { fs.rmSync(lock, { force: true }); }
}

main().catch((error) => { console.error(`mirror: ${error.message}`); process.exit(0); });
