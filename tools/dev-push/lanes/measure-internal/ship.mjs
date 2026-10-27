#!/usr/bin/env node
// Ship the measure editor to dev.1m8.ai through the measure-internal lane
// (docs/architecture/dev-lanes.md). Until the dev push router takes over:
//
//   node tools/dev-push/lanes/measure-internal/ship.mjs [<commit>] [--tests=mapped|full|none]
//   node tools/dev-push/lanes/measure-internal/ship.mjs status|rollback [<sha>]|install|uninstall
//
// Takes the editor (public/measure/internal, dev) from <commit> (default HEAD),
// from any branch: a commit on origin/lane/measure-internal that changes only
// lane paths is shipped as is; otherwise its lane paths are merged onto the
// lane tip as a new commit (other paths ship through platform). The result is
// deployed, then lane/measure-internal on origin is fast-forwarded to it.
import { spawnSync } from "node:child_process";
import { LANE, deploy, laneCommit, repoRoot, rollback, status, install, uninstall } from "./lane.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const flagValue = (name, fallback) => flag(name)?.split("=")[1] ?? fallback;
const positional = args.filter((a) => !a.startsWith("--"));
const log = (line) => console.error(line);
const cwd = repoRoot();

function git(gitArgs, { allowFail = false } = {}) {
  const r = spawnSync("git", gitArgs, { cwd, encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${gitArgs.join(" ")}: ${r.stderr.trim()}`);
  return r.status === 0 ? r.stdout.trim() : null;
}
const isAncestor = (a, b) => spawnSync("git", ["merge-base", "--is-ancestor", a, b], { cwd }).status === 0;

async function ship(ref) {
  const began = Date.now();
  const sha = git(["rev-parse", `${ref}^{commit}`]);
  git(["fetch", "-q", "origin", `+refs/heads/${LANE.branch}:refs/remotes/origin/${LANE.branch}`]);
  const tip = git(["rev-parse", `origin/${LANE.branch}`]);
  const candidate = laneCommit(sha, tip, cwd);
  if (!candidate) log(`origin/${LANE.branch} already has the editor of ${sha.slice(0, 8)}`);
  else if (candidate !== sha) log(`lane commit ${candidate.slice(0, 8)}: the editor of ${sha.slice(0, 8)} on ${tip.slice(0, 8)}`);
  const target = candidate || tip;
  const host = await status({ log });
  if (host.current && git(["cat-file", "-t", host.current], { allowFail: true }) && !isAncestor(host.current, target)) {
    throw new Error(`the live lane release ${host.current.slice(0, 8)} is not on origin/${LANE.branch}; ` +
      `ship.mjs rollback <sha> to a lane commit, or ask the lane owner`);
  }

  const record = await deploy(target, { cwd, tests: flagValue("tests", "mapped"), log, host });
  if (target !== tip) {
    const push = spawnSync("git", ["push", "-q", `--force-with-lease=refs/heads/${LANE.branch}:${tip}`, "origin", `${target}:refs/heads/${LANE.branch}`],
      { cwd, encoding: "utf8" });
    if (push.status !== 0) {
      log(`push to ${LANE.branch} refused (${push.stderr.trim()}); rolling the host back`);
      if (record.status === "live") await rollback(record.previous || undefined, { log });
      throw new Error(`origin/${LANE.branch} moved while shipping; ship again`);
    }
  }
  const seconds = ((Date.now() - began) / 1000).toFixed(1);
  if (record.serving === "lane") log(`measure-internal ${target.slice(0, 8)} is live on dev.1m8.ai/measure/internal/ (${seconds} s)`);
  else log(`measure-internal ${target.slice(0, 8)} is built, but dev serves the platform copy (lane uninstalled; ship.mjs install) (${seconds} s)`);
  return record;
}

try {
  const command = positional[0];
  let result;
  if (command === "status") result = await status({ log });
  else if (command === "rollback") result = await rollback(positional[1], { log });
  else if (command === "install") result = await install({ log });
  else if (command === "uninstall") result = await uninstall({ log });
  else result = await ship(command || "HEAD");
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  log(`\n${error.message}`);
  if (error.record) console.log(JSON.stringify(error.record, null, 2));
  process.exit(1);
}
