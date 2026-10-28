#!/usr/bin/env node
// Ship the measure editor to dev.1m8.ai through the measure-internal lane
// (docs/architecture/dev-lanes.md). Run it from any checkout, by path:
//
//   node <...>/tools/dev-push/lanes/measure-internal/ship.mjs [<commit>] [--regression[=all]]
//   node <...>/tools/dev-push/lanes/measure-internal/ship.mjs regression [<commit>] [--all]
//   node <...>/tools/dev-push/lanes/measure-internal/ship.mjs status
//
// Takes the editor (public/measure/internal, dev) from <commit> (default HEAD)
// on any branch, canonical included, and builds the lane commit: the lane tip
// plus only those paths, one parent (laneCommit), so none of the branch's other
// history comes along. That commit goes to the dev push router with the
// router's submit.mjs (the one beside this file), run from an empty temporary
// worktree, so the checkout needs none of the router's tools. Only the router
// activates lane releases; this script never touches a host. The router runs
// the quick checks (seconds), deploys and answers; `--regression` adds the
// editor's regression tests, once, on the server, never on this machine.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LANE, laneCommit, repoRoot } from "./lane.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTER_REMOTE = "devpush";
const ROUTER_URL = "dev-sync-droplet:/home/dev/router/firstmeasure.git";
const STATUS_URL = "https://dev.1m8.ai/__dev-push/status.json";
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

function fetchRouter(...branches) {
  if (git(["remote", "get-url", ROUTER_REMOTE], { allowFail: true }) === null) git(["remote", "add", ROUTER_REMOTE, ROUTER_URL]);
  git(["fetch", "-q", ROUTER_REMOTE, ...branches.map((b) => `+refs/heads/${b}:refs/remotes/${ROUTER_REMOTE}/${b}`)]);
}

/** The router's submit.mjs: beside this file, else the checkout's, else canonical's from the router repository. */
function submitScript() {
  for (const candidate of [path.resolve(HERE, "..", "..", "submit.mjs"), path.join(cwd, "tools", "dev-push", "submit.mjs")]) {
    if (existsSync(candidate)) return candidate;
  }
  fetchRouter(CANONICAL);
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

function ship(ref, { regression, regressionOnly = false }) {
  const sha = git(["rev-parse", `${ref}^{commit}`]);
  fetchRouter(LANE.branch);
  const tip = git(["rev-parse", `${ROUTER_REMOTE}/${LANE.branch}`]);
  const candidate = laneCommit(sha, tip, cwd);
  if (candidate && candidate !== sha) log(`lane commit ${candidate.slice(0, 8)}: the editor of ${sha.slice(0, 8)} on ${tip.slice(0, 8)}`);
  const subject = git(["log", "-1", "--format=%s", sha]);
  const slug = `editor-${subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || sha.slice(0, 8)}`;
  if (regressionOnly) return submitCommit(candidate || tip, ["regression", ...(regression === "all" ? ["--all"] : []), "--slug", slug, "--wait"]);
  if (!candidate) {
    log(`${ROUTER_REMOTE}/${LANE.branch} already has the editor of ${sha.slice(0, 8)}; nothing to ship`);
    return 0;
  }
  const extra = regression ? [regression === "all" ? "--regression=all" : "--regression"] : [];
  return submitCommit(candidate, ["--lane", LANE.name, "--slug", slug, "--wait", ...extra]);
}

async function laneStatus() {
  const response = await fetch(STATUS_URL, { headers: { "cache-control": "no-cache" } });
  const data = await response.json();
  const served = await fetch("https://dev.1m8.ai/measure/internal/audio/ding.mp3", { method: "HEAD" }).catch(() => null);
  return { ...data.lanes?.[LANE.name], served: served?.headers.get("x-firstmate-lane") || null,
    submissions: (data.submissions || []).filter((item) => item.lane === LANE.name).slice(0, 5).map(({ ref, state, release, updated_at }) => ({ ref, state, release, updated_at })) };
}

try {
  const command = positional[0];
  if (["rollback", "follow", "install", "uninstall"].includes(command)) {
    throw new Error(`ship.mjs ${command} is gone: only the dev push router changes the lane's hosts. Ship a revert instead, or ask the router.`);
  }
  if (process.env.FM_LANE_DIRECT) throw new Error("FM_LANE_DIRECT is gone: the dev push router is the only way to activate a lane release.");
  if (command === "status") console.log(JSON.stringify(await laneStatus(), null, 2));
  else if (command === "regression") process.exitCode = ship(positional[1] || "HEAD", { regression: flag("all") ? "all" : "mapped", regressionOnly: true });
  else process.exitCode = ship(command || "HEAD", { regression: flagValue("regression", "mapped") });
} catch (error) {
  log(`\n${error.message}`);
  process.exit(1);
}
