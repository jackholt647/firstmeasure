#!/usr/bin/env node
// Ship the measure editor to dev.1m8.ai through the measure-internal lane
// (docs/architecture/dev-lanes.md).
//
//   node tools/dev-push/lanes/measure-internal/ship.mjs [<commit>] [--regression[=all]]
//   node tools/dev-push/lanes/measure-internal/ship.mjs regression [<commit>] [--all]
//   node tools/dev-push/lanes/measure-internal/ship.mjs status|rollback [<sha>]|follow|install|uninstall
//
// Takes the editor (public/measure/internal, dev) from <commit> (default HEAD)
// on any branch, canonical included, and builds the lane commit: the lane tip
// plus only those paths, one parent (laneCommit), so none of the branch's other
// history comes along. That commit goes to the dev push router with its own
// submit.mjs, run from an empty temporary worktree, so this works from a
// checkout that does not have the router's tools yet. The router runs the
// quick checks (seconds), deploys, and answers; `--regression` adds the
// editor's regression tests, once, on the server; never on this machine.
//
// FM_LANE_DIRECT=1 ships without the router (lane-host.sh over SSH): for
// emergencies only, since the router owns the lane's hosts.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LANE, deploy, follow, laneCommit, repoRoot, rollback, status, install, uninstall } from "./lane.mjs";

const ROUTER_REMOTE = "devpush";
const ROUTER_URL = "dev-sync-droplet:/home/dev/router/firstmeasure.git";
const CANONICAL = "codex/consolidated-firstmeasure-20260923";

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const flagValue = (name, fallback) => (flag(name)?.includes("=") ? flag(name).split("=")[1] : flag(name) ? fallback : undefined);
const positional = args.filter((a) => !a.startsWith("--"));
const log = (line) => console.error(line);
const cwd = repoRoot();

function git(gitArgs, { allowFail = false, at = cwd, input } = {}) {
  const r = spawnSync("git", gitArgs, { cwd: at, encoding: "utf8", input, maxBuffer: 1 << 26 });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${gitArgs.join(" ")}: ${r.stderr.trim()}`);
  return r.status === 0 ? r.stdout.trim() : null;
}
const isAncestor = (a, b) => spawnSync("git", ["merge-base", "--is-ancestor", a, b], { cwd }).status === 0;

function fetchRouter(...branches) {
  if (git(["remote", "get-url", ROUTER_REMOTE], { allowFail: true }) === null) git(["remote", "add", ROUTER_REMOTE, ROUTER_URL]);
  git(["fetch", "-q", ROUTER_REMOTE, ...branches.map((b) => `+refs/heads/${b}:refs/remotes/${ROUTER_REMOTE}/${b}`)]);
}

/** The router's submit.mjs: this checkout's, or canonical's from the router repository. */
function submitScript() {
  const own = path.join(cwd, "tools", "dev-push", "submit.mjs");
  if (existsSync(own)) return own;
  const tip = git(["rev-parse", `${ROUTER_REMOTE}/${CANONICAL}`]);
  const dir = path.join(os.tmpdir(), "fm-lane-router-tools", tip.slice(0, 12));
  const script = path.join(dir, "tools", "dev-push", "submit.mjs");
  if (!existsSync(script)) {
    mkdirSync(dir, { recursive: true });
    const archive = spawnSync("git", ["archive", "--format=tar", tip, "tools/dev-push"], { cwd, maxBuffer: 1 << 28 });
    const untar = spawnSync("tar", ["-x"], { cwd: dir, input: archive.stdout });
    if (archive.status !== 0 || untar.status !== 0 || !existsSync(script)) throw new Error(`could not read the router's submit.mjs from ${tip.slice(0, 10)}`);
  }
  return script;
}

/** Runs the router's submit.mjs with HEAD = `commit`, in a temporary worktree with no files. */
function submitCommit(commit, submitArgs) {
  const script = submitScript();
  const dir = mkdtempSync(path.join(os.tmpdir(), "fm-lane-submit-"));
  rmSync(dir, { recursive: true, force: true });
  git(["worktree", "add", "-q", "--detach", "--no-checkout", dir, commit]);
  try {
    // An index that matches HEAD with every file marked skip-worktree: clean status, nothing on disk.
    git(["read-tree", "HEAD"], { at: dir });
    const files = git(["ls-files", "-z"], { at: dir });
    if (files) git(["update-index", "-z", "--skip-worktree", "--stdin"], { at: dir, input: files });
    const r = spawnSync(process.execPath, [script, ...submitArgs], { cwd: dir, stdio: "inherit" });
    return r.status ?? 1;
  } finally {
    git(["worktree", "remove", "--force", dir], { allowFail: true });
    git(["worktree", "prune"], { allowFail: true });
  }
}

function laneTarget(ref) {
  const sha = git(["rev-parse", `${ref}^{commit}`]);
  fetchRouter(LANE.branch, CANONICAL);
  const tip = git(["rev-parse", `${ROUTER_REMOTE}/${LANE.branch}`]);
  const candidate = laneCommit(sha, tip, cwd);
  if (candidate && candidate !== sha) log(`lane commit ${candidate.slice(0, 8)}: the editor of ${sha.slice(0, 8)} on ${tip.slice(0, 8)}`);
  return { sha, tip, candidate };
}

function viaRouter(ref, { regression, regressionOnly = false }) {
  const { sha, tip, candidate } = laneTarget(ref);
  const subject = git(["log", "-1", "--format=%s", sha]);
  const slug = `editor-${subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || sha.slice(0, 8)}`;
  const suite = regression === "all" ? ["--all"] : [];
  if (regressionOnly) return submitCommit(candidate || tip, ["regression", ...suite, "--slug", slug, "--wait"]);
  if (!candidate) {
    log(`${ROUTER_REMOTE}/${LANE.branch} already has the editor of ${sha.slice(0, 8)}; nothing to ship`);
    return 0;
  }
  const extra = regression ? [regression === "all" ? "--regression=all" : "--regression"] : [];
  return submitCommit(candidate, ["--lane", LANE.name, "--slug", slug, "--wait", ...extra]);
}

// Emergency path without the router (FM_LANE_DIRECT=1).
async function direct(ref) {
  const began = Date.now();
  const { tip, candidate } = laneTarget(ref);
  const target = candidate || tip;
  const host = await status({ log });
  if (host.current && git(["cat-file", "-t", host.current], { allowFail: true }) && !isAncestor(host.current, target)) {
    throw new Error(`the live lane release ${host.current.slice(0, 8)} is not on ${ROUTER_REMOTE}/${LANE.branch}`);
  }
  const record = await deploy(target, { cwd, log, host });
  if (target !== tip) {
    const push = spawnSync("git", ["push", "-q", `--force-with-lease=refs/heads/${LANE.branch}:${tip}`, ROUTER_REMOTE, `${target}:refs/heads/${LANE.branch}`], { cwd, encoding: "utf8" });
    if (push.status !== 0) {
      log(`push to ${LANE.branch} refused (${push.stderr.trim()}); rolling the host back`);
      if (record.status === "live") await rollback(record.previous || undefined, { log });
      throw new Error(`${LANE.branch} moved while shipping; ship again`);
    }
  }
  log(`measure-internal ${target.slice(0, 8)} is live on dev.1m8.ai/measure/internal/ (${((Date.now() - began) / 1000).toFixed(1)} s)`);
  return record;
}

try {
  const command = positional[0];
  let result = null;
  let code = 0;
  if (command === "status") result = await status({ log });
  else if (command === "rollback") result = await rollback(positional[1], { log });
  else if (command === "follow") result = await follow({ log });
  else if (command === "install") result = await install({ log });
  else if (command === "uninstall") result = await uninstall({ log });
  else if (command === "regression") code = viaRouter(positional[1] || "HEAD", { regression: flag("all") ? "all" : "mapped", regressionOnly: true });
  else if (process.env.FM_LANE_DIRECT) result = await direct(command || "HEAD");
  else code = viaRouter(command || "HEAD", { regression: flagValue("regression", "mapped") });
  if (result) console.log(JSON.stringify(result, null, 2));
  process.exitCode = code;
} catch (error) {
  log(`\n${error.message}`);
  if (error.record) console.log(JSON.stringify(error.record, null, 2));
  process.exit(1);
}
