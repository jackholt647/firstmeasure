#!/usr/bin/env node
// The one way to ship code to dev.1m8.ai (docs/architecture/dev-lanes.md).
//
//   node tools/dev-push/submit.mjs [--lane platform|measure-internal] [--title "..."] [--slug s] [--regression[=all]] [--wait]
//   node tools/dev-push/submit.mjs regression [--all] [--wait]       run the regression suites on the server; ships nothing
//   node tools/dev-push/submit.mjs --gates-only [--regression] [--wait]   only the checks (quick, or with the suites); ships nothing
//   node tools/dev-push/submit.mjs status [--lane L] [--mine] [--json]
//   node tools/dev-push/submit.mjs wait [<slug>|<queue ref>]
//   node tools/dev-push/submit.mjs withdraw [<slug>]
//
// Commit first. submit pushes HEAD, wrapped in a submission commit that carries the manifest (same tree, one
// parent = HEAD), to refs/heads/queue/<lane>/<agent>-<slug> in the router's repository on the dev sync droplet
// (remote `devpush`, added to the checkout on first use). The router merges HEAD onto the lane tip, runs the fast
// checks, builds one release, activates it on every role of the lane and fast-forwards the lane branch. It answers
// in the status document; --wait blocks until `live` or `rejected`. Then a background push mirrors the router's
// branches to GitHub (never waited for).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LANES, ROUTER_REMOTE, STATUS_FILE, STATUS_SSH, STATUS_URL, TERMINAL, agentId, formatManifest, git, laneOf, parseArgs, queueRef, routerUrl, run, slugify } from "./lib/common.mjs";

const REMOTE = ROUTER_REMOTE;
const WAIT_MS = Number(process.env.DEV_PUSH_WAIT_MINUTES || 90) * 60_000;
const here = path.dirname(fileURLToPath(import.meta.url));

const REGRESSION_HELP = "Regression suites are opt-in: add --regression (or run `submit.mjs regression`) only when you suspect a bug, when Jack asks, or after ~20+ minutes of work. They run once, on the server; do not run them locally first.";

/** Points the checkout's `devpush` remote at the router's repository. */
async function ensureRemote(root) {
  const url = routerUrl();
  const current = await git(root, ["remote", "get-url", REMOTE], { allowFail: true });
  if (current.code !== 0) await git(root, ["remote", "add", REMOTE, url]);
  else if (current.stdout.trim() !== url) await git(root, ["remote", "set-url", REMOTE, url]);
}

async function laneTip(root, lane) {
  const branch = LANES[lane].branch;
  const fetched = await git(root, ["fetch", "--quiet", REMOTE, `+refs/heads/${branch}:refs/remotes/${REMOTE}/${branch}`], { allowFail: true });
  const local = await git(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/${REMOTE}/${branch}`], { allowFail: true });
  if (fetched.code === 0 && local.code === 0) return { branch, sha: local.stdout.trim() };
  if (lane !== "platform") return { ...(await laneTip(root, "platform")), branch }; // a new lane branch starts from canonical
  throw new Error(`Cannot read ${branch} from the router (${routerUrl()}): ${fetched.stderr.trim()}`);
}

/** Paths HEAD changes relative to where it left the lane. */
async function changedPaths(root, tip) {
  const base = (await git(root, ["merge-base", tip, "HEAD"])).trim();
  const out = await git(root, ["-c", "core.quotepath=off", "diff", "--name-only", "--no-renames", "-z", base, "HEAD"]);
  return { base, files: out.split("\0").filter(Boolean) };
}

/** Mirrors the router's branches to GitHub in the background; a failure is logged, never waited for. */
function mirrorInBackground(root) {
  if (process.env.DEV_PUSH_NO_MIRROR) return;
  const child = spawn(process.execPath, [path.join(here, "mirror.mjs"), "--root", root, "--quiet"], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

async function submit(args, { regressionOnly = false } = {}) {
  const root = (await git(process.cwd(), ["rev-parse", "--show-toplevel"])).trim();
  await ensureRemote(root);
  const head = (await git(root, ["rev-parse", "HEAD"])).trim();
  const dirty = (await git(root, ["status", "--porcelain", "--untracked-files=no"])).trim();
  if (dirty) console.log(`note: uncommitted changes are not submitted (only HEAD ${head.slice(0, 10)} is):\n${dirty.split("\n").slice(0, 10).join("\n")}`);

  const platformTip = await laneTip(root, "platform");
  const { files } = await changedPaths(root, platformTip.sha);
  const lanes = [...new Set(files.map(laneOf))];
  let lane = args.lane ? String(args.lane) : lanes.length === 1 ? lanes[0] : lanes.length ? null : "platform";
  if (!LANES[lane || "platform"]) throw new Error(`Unknown lane ${lane}. Lanes: ${Object.keys(LANES).join(", ")}. Config is data (config library) and browser-file tuning is the live layer; neither is submitted.`);
  if (!lane) {
    const byLane = {};
    for (const file of files) (byLane[laneOf(file)] ||= []).push(file);
    throw new Error(`HEAD changes files of more than one lane; submit each lane's commits separately:\n${Object.entries(byLane).map(([name, list]) => `  ${name}: ${list.slice(0, 8).join(", ")}${list.length > 8 ? ` (+${list.length - 8})` : ""}`).join("\n")}`);
  }
  const outside = files.filter((file) => laneOf(file) !== lane);
  if (outside.length) throw new Error(`Lane ${lane} does not own: ${outside.slice(0, 12).join(", ")}${outside.length > 12 ? ` (+${outside.length - 12})` : ""}. Submit those on their own lane.`);
  const tip = lane === "platform" ? platformTip : await laneTip(root, lane);
  if (!files.length && !regressionOnly) throw new Error(`HEAD ${head.slice(0, 10)} has nothing that ${tip.branch} lacks.`);

  const branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  // The newest commit of your own that the lane lacks names the submission (not "Merge ... into ...").
  const subject = ((await git(root, ["log", "-1", "--no-merges", "--format=%s", `${tip.sha}..HEAD`])).trim() || (await git(root, ["log", "-1", "--format=%s", "HEAD"])).trim());
  const slug = slugify(args.slug || (branch !== "HEAD" ? branch.split("/").pop() : "") || subject) || head.slice(0, 8);
  const agent = agentId();
  const queueLane = regressionOnly ? "regression" : lane;
  // --tests regression[:all] is the measure lane's ship.mjs spelling of --regression[=all].
  const asked = args.regression || (String(args.tests || "").startsWith("regression") ? (String(args.tests).endsWith(":all") ? "all" : true) : null);
  const regression = asked ? (args.all || asked === "all" ? "all" : "mapped") : regressionOnly && !args["gates-only"] ? (args.all ? "all" : "mapped") : null;
  const ref = queueRef(queueLane, agent, slug);
  const manifest = {
    v: 1, lane: queueLane, target: lane, agent, slug,
    title: String(args.title || subject).slice(0, 200),
    regression,
    session: process.env.CLAUDE_CODE_HOST_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_THREAD_ID || null,
    host: os.hostname(), branch, work: head, lane_tip: tip.sha, files: files.length,
    submitted_at: new Date().toISOString()
  };
  const identity = { GIT_AUTHOR_NAME: "dev-push", GIT_AUTHOR_EMAIL: "dev-push@1m8.ai", GIT_COMMITTER_NAME: "dev-push", GIT_COMMITTER_EMAIL: "dev-push@1m8.ai" };
  const submission = (await git(root, ["commit-tree", `${head}^{tree}`, "-p", head, "-F", "-"], { input: formatManifest(manifest), env: identity })).trim();
  const pushed = await git(root, ["push", "--force", "--quiet", REMOTE, `${submission}:${ref}`], { allowFail: true });
  if (pushed.code !== 0) throw new Error(`push to the router (${routerUrl()}) ${ref} failed: ${pushed.stderr.trim()}`);
  console.log(`queued  ${ref.replace("refs/heads/", "")}  (${files.length} file(s), ${head.slice(0, 10)} on ${tip.branch} ${tip.sha.slice(0, 10)}${regression ? `, regression: ${regression}` : ""})`);
  if (regressionOnly) console.log("This runs the regression suites on the server and ships nothing.");
  else if (!regression) console.log(REGRESSION_HELP);
  console.log(`status: node tools/dev-push/submit.mjs status --mine   wait: node tools/dev-push/submit.mjs wait ${slug}`);
  mirrorInBackground(root);
  if (args.wait) return wait({ submission, ref: ref.replace("refs/heads/", ""), lane });
  return 0;
}

/** The router's status document: on the droplet itself the file, else dev web over HTTPS, else the droplet over SSH. */
export async function readStatus() {
  const local = path.join(os.homedir(), STATUS_FILE);
  if (process.env.DEV_PUSH_STATUS_FILE || fs.existsSync(local)) return JSON.parse(fs.readFileSync(process.env.DEV_PUSH_STATUS_FILE || local, "utf8"));
  try {
    const response = await fetch(process.env.DEV_PUSH_STATUS_URL || STATUS_URL, { signal: AbortSignal.timeout(10_000), headers: { "cache-control": "no-cache" } });
    if (response.ok) return await response.json();
  } catch {}
  const result = await run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", STATUS_SSH, `cat ~/${STATUS_FILE}`], { timeout: 30_000 });
  if (result.code !== 0) throw new Error(`router status unreachable (${STATUS_URL}, ssh ${STATUS_SSH}): ${result.stderr.trim()}`);
  return JSON.parse(result.stdout);
}

function describe(entry) {
  const what = entry.state === "live" ? `live ${entry.release || ""}` : entry.state === "rejected" ? `rejected (${entry.reason || "?"})` : entry.state;
  return `${what.padEnd(28)} ${entry.ref}  ${entry.title || ""}`;
}

const formatMs = (ms) => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`);

async function wait({ submission, ref, lane }) {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < WAIT_MS) {
    let status = null;
    try { status = await readStatus(); } catch (error) { if (last !== error.message) console.log(`waiting: ${error.message}`); last = error.message; }
    const entry = status?.submissions?.find((item) => (submission ? item.submission === submission : item.ref === ref));
    if (entry) {
      const line = describe(entry);
      if (line !== last) console.log(`${new Date().toISOString().slice(11, 19)}  ${line}`);
      last = line;
      if (TERMINAL.has(entry.state)) {
        if (entry.details) console.log(entry.details);
        if (entry.timings) console.log(`timings: ${Object.entries(entry.timings).map(([stage, ms]) => `${stage} ${formatMs(ms)}`).join(", ")}`);
        if (entry.state === "rejected") {
          const branch = LANES[entry.target || lane || entry.lane]?.branch || LANES.platform.branch;
          console.log(entry.reason === "conflict"
            ? `Next: git fetch ${REMOTE} && git rebase ${REMOTE}/${branch}, resolve, then submit again (same slug replaces this entry).`
            : `Next: fix what the output above names, commit, and submit again (same slug replaces this entry).`);
        }
        return entry.state === "live" || entry.state === "passed" ? 0 : 1;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  console.log(`still not finished after ${WAIT_MS / 60_000} min; check \`submit.mjs status\``);
  return 2;
}

async function status(args) {
  const doc = await readStatus();
  if (args.json) { console.log(JSON.stringify(doc, null, 2)); return 0; }
  const me = agentId();
  console.log(`router on ${doc.router?.host || "?"}${doc.router?.paused ? " (PAUSED)" : ""}, updated ${doc.updated_at}`);
  for (const [name, lane] of Object.entries(doc.lanes || {})) {
    if (args.lane && args.lane !== name) continue;
    console.log(`  ${name.padEnd(17)} ${String(lane.state).padEnd(12)} ${lane.branch} ${String(lane.tip || "").slice(0, 10)}  live: ${lane.release?.id || "?"}${lane.note ? `  NOTE: ${lane.note}` : ""}`);
  }
  const rows = (doc.submissions || []).filter((item) => (!args.lane || item.lane === args.lane) && (!args.mine || item.agent === me));
  for (const item of rows.slice(0, Number(args.limit || 25))) console.log(`  ${describe(item)}`);
  return 0;
}

async function resolveRef(root, given) {
  const agent = agentId();
  if (given && given.startsWith("queue/")) return given;
  await ensureRemote(root);
  const out = await git(root, ["ls-remote", REMOTE, `refs/heads/queue/*/${agent}-*`]);
  const refs = out.split("\n").filter(Boolean).map((line) => line.split("\t")[1].replace("refs/heads/", ""));
  const match = given ? refs.filter((ref) => ref.endsWith(`/${agent}-${slugify(given)}`)) : refs;
  if (match.length === 1) return match[0];
  if (!match.length && given) {
    // Already processed (its ref is retired): find it in the status document.
    const doc = await readStatus().catch(() => null);
    const done = doc?.submissions?.find((item) => item.agent === agent && item.ref.endsWith(`/${agent}-${slugify(given)}`));
    if (done) return done.ref;
  }
  throw new Error(match.length ? `Several of your submissions are queued: ${match.join(", ")}` : `No queued submission of ${agent}${given ? ` named ${given}` : ""}.`);
}

async function withdraw(args) {
  const root = (await git(process.cwd(), ["rev-parse", "--show-toplevel"])).trim();
  const ref = await resolveRef(root, args._[1]);
  await git(root, ["push", "--quiet", REMOTE, "--delete", `refs/heads/${ref}`]);
  console.log(`withdrawn ${ref} (a batch already under way finishes with it)`);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const job = command === "status" ? status(args)
    : command === "wait" ? (async () => wait({ ref: await resolveRef((await git(process.cwd(), ["rev-parse", "--show-toplevel"])).trim(), args._[1]) }))()
    : command === "withdraw" ? withdraw(args)
    : command === "regression" ? submit(args, { regressionOnly: true })
    : submit(args, { regressionOnly: Boolean(args["gates-only"]) }); // --gates-only: check the merged commit, ship nothing
  job.then((code) => process.exit(code || 0), (error) => { console.error(`submit: ${error.message}`); process.exit(1); });
}
