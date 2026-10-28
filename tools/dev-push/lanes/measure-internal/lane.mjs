// measure-internal dev lane: ships public/measure/internal/** from one commit to
// dev in seconds (docs/architecture/dev-lanes.md).
//
// Two ways in:
// - The dev push router imports the default export (gates, deploy, current;
//   docs/architecture/dev-lanes.md "The router") and reaches hosts only through
//   its `hosts` (fm-release). The release goes to dev legacy (served) and dev web
//   (server-rendered PDFs read editor_scripts/pdf.js from it).
// - Until the router owns the lane, ship.mjs calls deploy(sha) below, which
//   ships to dev legacy over SSH with lane-host.sh.
//
// Every ship runs the quick checks (PHP lint and `node --check` of the changed
// files, seconds). The editor's regression tests (dev/*.test.cjs) run only when
// asked for, on the server, never on a laptop (runRegression).
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const LANE = {
  name: "measure-internal",
  branch: "lane/measure-internal",
  // What this lane owns. Anything else in a commit ships through `platform`.
  owns: ["public/measure/internal/", "dev/"],
  // What reaches the host. dev/ is the editor's tests and tooling: gates only.
  deploys: "public/measure/internal",
  host: "dev legacy (firstmeasure-development-compatibility)",
  probe: "audio/ding.mp3"
};

const DEFAULT_KEY = path.join(os.homedir(), ".ssh", "id_ed25519_firstmeasure_cluster_v2");
const SEND_ALL_ABOVE = 300; // changed files; past this a full payload is cheaper than a long command line

export function sshTarget() {
  const target = process.env.FM_LANE_SSH_TARGET || "root@137.184.229.145";
  const opts = process.env.FM_LANE_SSH_OPTS
    ? process.env.FM_LANE_SSH_OPTS.split(" ").filter(Boolean)
    : ["-J", "dev-sync-droplet", "-o", "BatchMode=yes", "-o", "UpdateHostKeys=no", "-o", "ConnectTimeout=15",
       ...(existsSync(DEFAULT_KEY) ? ["-i", DEFAULT_KEY] : [])];
  return { target, opts };
}

export function ownsPath(file) {
  return LANE.owns.some((prefix) => file.startsWith(prefix));
}

const skipCheck = (rel) => rel.startsWith("unused/") || rel.startsWith("editor_scripts/vendor/");

function git(args, { cwd = process.cwd(), input, encoding = "utf8", env } = {}) {
  const r = spawnSync("git", ["-c", "core.autocrlf=false", "-c", "core.eol=lf", ...args],
    { cwd, input: input === undefined ? undefined : Buffer.from(input), encoding, env: env && { ...process.env, ...env }, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr?.toString().trim()}`);
  return r.stdout;
}

export function repoRoot(cwd = process.cwd()) {
  return git(["rev-parse", "--show-toplevel"], { cwd }).trim();
}

function commitExists(sha, cwd) {
  return spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd }).status === 0;
}

// sha256 of every deployed file at the commit, from git blobs.
export function manifest(sha, cwd) {
  const tree = git(["ls-tree", "-r", "-z", sha, "--", LANE.deploys], { cwd }).split("\0").filter(Boolean);
  const entries = tree.map((line) => {
    const [meta, file] = line.split("\t");
    const [mode, type, blob] = meta.split(" ");
    if (type !== "blob" || mode === "120000") throw new Error(`unsupported tree entry ${mode} ${file}`);
    return { blob, rel: file.slice(LANE.deploys.length + 1) };
  });
  const out = git(["cat-file", "--batch"], { cwd, input: entries.map((e) => e.blob).join("\n") + "\n", encoding: "buffer" });
  const files = {};
  let at = 0;
  for (const e of entries) {
    const nl = out.indexOf(10, at);
    const size = Number(out.subarray(at, nl).toString().split(" ")[2]);
    files[e.rel] = createHash("sha256").update(out.subarray(nl + 1, nl + 1 + size)).digest("hex");
    at = nl + 1 + size + 1;
  }
  return files;
}

export function changedPaths(base, sha, cwd, pathspec = LANE.owns) {
  if (!base) return null;
  return git(["diff", "--name-only", "--no-renames", "-z", base, sha, "--", ...pathspec], { cwd })
    .split("\0").filter(Boolean);
}

/**
 * The commit that puts `source`'s editor onto the lane: `source` itself when it
 * already contains `tip` and changes only lane paths, otherwise a new commit on
 * `tip` whose lane paths are the three-way merge of `tip` and `source` (other
 * paths stay as on `tip`; they ship through platform). Null when the lane
 * already has every lane change in `source`. Throws on a conflict in a lane path.
 */
export function laneCommit(source, tip, cwd) {
  source = git(["rev-parse", `${source}^{commit}`], { cwd }).trim();
  const isAncestor = spawnSync("git", ["merge-base", "--is-ancestor", tip, source], { cwd }).status === 0;
  if (isAncestor && changedPaths(tip, source, cwd, ["."]).every(ownsPath)) return source === tip ? null : source;
  const merge = spawnSync("git", ["merge-tree", "--write-tree", "--name-only", "--no-messages", tip, source], { cwd, encoding: "utf8" });
  if (merge.status > 1 || !merge.stdout) throw new Error(`git merge-tree: ${merge.stderr.trim()}`);
  const [merged, ...conflicted] = merge.stdout.split("\n").filter(Boolean);
  const laneConflicts = [...new Set(conflicted.filter(ownsPath))];
  if (laneConflicts.length) {
    throw new Error(`${source.slice(0, 8)} conflicts with ${LANE.branch} in:\n  ${laneConflicts.join("\n  ")}\n` +
      `merge origin/${LANE.branch} into your branch, resolve, and ship again`);
  }
  const work = mkdtempSync(path.join(os.tmpdir(), "fm-lane-index-"));
  try {
    const env = { GIT_INDEX_FILE: path.join(work, "index") };
    git(["read-tree", tip], { cwd, env });
    const owned = LANE.owns.map((p) => p.replace(/\/$/, ""));
    // Index-only: never compares with, or touches, the caller's work tree.
    const drop = git(["ls-files", "-z", "--", ...owned], { cwd, env });
    if (drop) git(["update-index", "-z", "--force-remove", "--stdin"], { cwd, env, input: drop });
    for (const prefix of owned) {
      if (spawnSync("git", ["cat-file", "-e", `${merged}:${prefix}`], { cwd }).status === 0) {
        git(["read-tree", `--prefix=${prefix}/`, `${merged}:${prefix}`], { cwd, env });
      }
    }
    const tree = git(["write-tree"], { cwd, env }).trim();
    if (tree === git(["rev-parse", `${tip}^{tree}`], { cwd }).trim()) return null;
    const subjects = git(["log", "--no-merges", "--format=%h%x09%s", `${tip}..${source}`, "--", ...owned], { cwd })
      .trim().split("\n").filter(Boolean).map((line) => line.split("\t"));
    const message = `Editor from ${source.slice(0, 8)}: ${subjects[0]?.[1] || "lane paths"}\n\n` +
      `public/measure/internal and dev as merged from ${source} onto ${tip.slice(0, 8)}.\n` +
      (subjects.length ? `\n${subjects.slice(0, 20).map(([h, s]) => `- ${h} ${s}`).join("\n")}\n` : "");
    return git(["commit-tree", tree, "-p", tip, "-F", "-"], { cwd, input: message }).trim();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function ssh(remote, { input, stdinFrom, log }) {
  const { target, opts } = sshTarget();
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", ["-T", ...opts, target, remote], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; for (const l of String(d).split("\n")) if (l.trim()) log?.(`  host: ${l}`); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (stdinFrom) stdinFrom(child.stdin);
    else child.stdin.end(input ?? "");
  });
}

function hostScript() {
  return path.join(HERE, "lane-host.sh");
}

async function hostCommand(args, log) {
  const r = await ssh(`bash -s -- ${args}`, { input: readFileSync(hostScript()), log });
  return r;
}

function marker(stdout, name) {
  const line = stdout.split("\n").reverse().find((l) => l.startsWith(name + " "));
  return line ? JSON.parse(line.slice(name.length + 1)) : null;
}

export async function status({ log } = {}) {
  const r = await hostCommand("status", log);
  const s = marker(r.stdout, "LANE-STATUS");
  if (r.code !== 0 || !s) throw new Error(`lane status failed: ${r.stderr.trim()}`);
  return s;
}

// ---- gates -----------------------------------------------------------------

// Tests a change maps to: changed tests, and tests that name a changed file.
export function mappedTests(base, sha, cwd) {
  const all = git(["ls-tree", "-r", "--name-only", sha, "--", "dev"], { cwd }).split("\n")
    .filter((f) => /^dev\/[^/]+\.test\.cjs$/.test(f));
  const changed = changedPaths(base, sha, cwd);
  if (!changed) return all;
  const picked = new Set(changed.filter((f) => all.includes(f)));
  const names = [...new Set(changed.filter((f) => !all.includes(f)).map((f) => path.posix.basename(f)))];
  for (let i = 0; i < names.length; i += 50) {
    const args = ["grep", "-l", "-F", ...names.slice(i, i + 50).flatMap((n) => ["-e", n]), sha, "--", "dev/*.test.cjs"];
    const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 26 });
    for (const line of (r.stdout || "").split("\n").filter(Boolean)) picked.add(line.slice(sha.length + 1));
  }
  return [...picked].sort();
}

// Platform files the tests read (report-units.js, api.ts, ...) come from the
// same commit, so a test never sees a working copy.
function testPaths(files, sha, cwd) {
  const paths = new Set(["dev", LANE.deploys]);
  for (const file of files) {
    const text = git(["show", `${sha}:${file}`], { cwd });
    if (text.includes("libraries/")) paths.add("public/libraries");
    for (const match of text.matchAll(/public\/[A-Za-z0-9_\-./]+/g)) {
      const candidate = match[0].replace(/[./]+$/, "");
      if (candidate.startsWith(LANE.deploys) || candidate.includes("node_modules") || candidate.startsWith("public/libraries")) continue;
      if (spawnSync("git", ["cat-file", "-e", `${sha}:${candidate}`], { cwd }).status === 0) paths.add(candidate);
    }
  }
  return [...paths];
}

function extract(sha, cwd, files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `fm-lane-${sha.slice(0, 8)}-`));
  const paths = testPaths(files, sha, cwd);
  const archive = spawnSync("git", ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "archive", "--format=tar", sha, "--", ...paths],
    { cwd, maxBuffer: 2 ** 31 });
  if (archive.status !== 0) throw new Error(`git archive: ${archive.stderr}`);
  const untar = spawnSync("tar", ["-x"], { cwd: dir, input: archive.stdout, maxBuffer: 1 << 20 });
  if (untar.status !== 0) throw new Error(`tar: ${untar.stderr}`);
  const modules = path.join(cwd, "public", "v1", "node_modules");
  if (!existsSync(modules)) throw new Error(`gates need ${modules} (junction it from a checkout that has it)`);
  mkdirSync(path.join(dir, "public", "v1"), { recursive: true });
  symlinkSync(realpathSync(modules), path.join(dir, "public", "v1", "node_modules"), "junction");
  // Several editor tests name only the Windows Chrome path. Off Windows that path
  // is relative to the test's cwd, so a link there points them at the server's browser.
  const browser = linuxBrowser();
  if (browser) {
    const fake = path.join(dir, "C:", "Program Files", "Google", "Chrome", "Application");
    mkdirSync(fake, { recursive: true });
    symlinkSync(browser, path.join(fake, "chrome.exe"));
  }
  return dir;
}

function linuxBrowser() {
  if (process.platform === "win32") return null;
  return [process.env.CHROME_PATH, process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]
    .find((candidate) => candidate && existsSync(candidate)) || null;
}

function removeTree(dir) {
  // Remove the junction first so rm never walks into the real node_modules.
  const link = path.join(dir, "public", "v1", "node_modules");
  try { if (process.platform === "win32") spawnSync("cmd", ["/c", "rmdir", link]); else rmSync(link); } catch {}
  rmSync(dir, { recursive: true, force: true });
}

function runFiles(dir, files, concurrency) {
  return new Promise((resolve) => {
    const results = {};
    let next = 0;
    let running = 0;
    const start = () => {
      while (running < concurrency && next < files.length) {
        const file = files[next++];
        running++;
        const began = Date.now();
        // A parent test runner's NODE_TEST_CONTEXT would make the child report to it and exit 0.
        const { NODE_TEST_CONTEXT, ...rest } = process.env;
        const browser = linuxBrowser();
        const env = browser ? { ...rest, CHROME_PATH: browser, PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: browser } : rest;
        const child = spawn(process.execPath, ["--test", file], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (d) => { out += d; });
        child.stderr.on("data", (d) => { out += d; });
        const timer = setTimeout(() => child.kill(), 300_000);
        child.on("close", (code) => {
          clearTimeout(timer);
          results[file] = { ok: code === 0, ms: Date.now() - began, tail: code === 0 ? "" : out.slice(-2000) };
          running--;
          if (next >= files.length && running === 0) resolve(results);
          else start();
        });
      }
      if (files.length === 0) resolve(results);
    };
    start();
  });
}

// ---- quick checks (every ship) ---------------------------------------------------

function hasPhp() {
  return spawnSync("php", ["-v"], { encoding: "utf8" }).status === 0;
}

/**
 * PHP lint and `node --check` of the deployed files `sha` changes against `base`
 * (every file when there is no base). Seconds. PHP is skipped with a note when
 * php is not installed here; lane-host.sh lints on the host as well.
 */
export async function quickChecks({ sha, base, cwd, log = () => {} }) {
  const began = Date.now();
  const changed = changedPaths(base, sha, cwd, [LANE.deploys]);
  const rels = (changed ?? Object.keys(manifest(sha, cwd)).map((rel) => `${LANE.deploys}/${rel}`))
    .filter((file) => file.startsWith(`${LANE.deploys}/`) && spawnSync("git", ["cat-file", "-e", `${sha}:${file}`], { cwd }).status === 0)
    .filter((file) => !skipCheck(file.slice(LANE.deploys.length + 1)));
  const php = rels.filter((file) => file.endsWith(".php"));
  const js = rels.filter((file) => file.endsWith(".js"));
  const failures = [];
  const notes = [];
  const phpReady = php.length && hasPhp();
  if (php.length && !phpReady) notes.push(`php not installed here: ${php.length} PHP file(s) not linted`);
  const work = mkdtempSync(path.join(os.tmpdir(), "fm-lane-check-"));
  try {
    const jobs = [...(phpReady ? php : []), ...js].map((file) => () => new Promise((resolve) => {
      const blob = git(["show", `${sha}:${file}`], { cwd, encoding: "buffer" });
      const local = path.join(work, file.replace(/[\/]/g, "__"));
      writeFileSync(local, blob);
      const [cmd, args] = file.endsWith(".php") ? ["php", ["-l", local]] : [process.execPath, ["--check", local]];
      const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { out += d; });
      child.on("close", (code) => {
        if (code !== 0) failures.push({ id: `${file.endsWith(".php") ? "php-lint" : "node-check"}:${file}`, output: out.split(local).join(file).slice(-2000) });
        resolve();
      });
    }));
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(8, jobs.length) }, async () => { while (next < jobs.length) await jobs[next++](); }));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const ms = Date.now() - began;
  log(`checks: ${phpReady ? php.length : 0} PHP, ${js.length} JS file(s) in ${ms} ms${failures.length ? `; ${failures.length} failed` : ""}`);
  for (const failure of failures) log(`  FAILED ${failure.id}\n${failure.output}`);
  return { ok: failures.length === 0, failures, notes, php: phpReady ? php.length : 0, js: js.length, ms };
}

// ---- regression tests (on request, on the server) ----------------------------------

// A test that also fails on the release now live is known, not a regression.
export async function runRegression({ sha, base, cwd, tests = "mapped", log = () => {} }) {
  const began = Date.now();
  const files = tests === "all" ? mappedTests(null, sha, cwd) : mappedTests(base, sha, cwd);
  if (files.length === 0) return { tests, ran: [], failed: [], known: [], ms: 0 };
  const concurrency = Math.max(2, Math.min(12, Math.floor(os.cpus().length / 2)));
  log(`gates: ${files.length} test file(s), ${concurrency} at a time`);
  const dir = extract(sha, cwd, files);
  let results;
  try { results = await runFiles(dir, files, concurrency); } finally { removeTree(dir); }
  let failed = files.filter((f) => !results[f].ok);
  const known = [];
  if (failed.length && base && commitExists(base, cwd)) {
    // Results on a release are remembered, keyed by the test file's blob, so a
    // test that fails on canonical is checked against the base only once.
    const cacheFile = path.join(git(["rev-parse", "--git-common-dir"], { cwd }).trim(), "fm-lane-base-results.json");
    let cache = {};
    try { cache = JSON.parse(readFileSync(path.resolve(cwd, cacheFile), "utf8")); } catch {}
    const keyOf = (f) => `${base}:${spawnSync("git", ["rev-parse", `${base}:${f}`], { cwd, encoding: "utf8" }).stdout.trim()}`;
    const onBase = failed.filter((f) => git(["ls-tree", "--name-only", base, "--", f], { cwd }).trim());
    const unknown = onBase.filter((f) => !(keyOf(f) in cache));
    if (unknown.length) {
      log(`gates: ${unknown.length} failed; checking them on the live release ${base.slice(0, 8)}`);
      const baseDir = extract(base, cwd, unknown);
      let baseResults;
      try { baseResults = await runFiles(baseDir, unknown, concurrency); } finally { removeTree(baseDir); }
      for (const f of unknown) cache[keyOf(f)] = baseResults[f].ok;
      try { writeFileSync(path.resolve(cwd, cacheFile), JSON.stringify(cache)); } catch {}
    }
    for (const f of onBase) if (cache[keyOf(f)] === false) known.push(f);
    failed = failed.filter((f) => !known.includes(f));
  }
  for (const f of known) log(`gates: ${f} also fails on the live release (known, not blocking)`);
  for (const f of failed) log(`gates: FAILED ${f}\n${results[f].tail}`);
  const times = Object.fromEntries(files.map((f) => [f, results[f].ms]));
  return { tests, ran: files, failed, known, times, ms: Date.now() - began, tails: Object.fromEntries(failed.map((f) => [f, results[f].tail])) };
}
export const runGates = runRegression;

// ---- deploy ------------------------------------------------------------------

/**
 * Ship one commit's public/measure/internal to dev legacy.
 * @param {string} ref  commit (any ref git resolves)
 * @param {{cwd?: string, log?: (line: string) => void, host?: object}} [options]
 *   host: a status() result read just before, to save a round trip
 * @returns {Promise<object>} release record; throws an Error with .record when not live
 */
export async function deploy(ref, { cwd = repoRoot(), log = (l) => console.error(l), host: hostStatus } = {}) {
  const began = Date.now();
  const sha = git(["rev-parse", `${ref}^{commit}`], { cwd }).trim();
  const host = hostStatus || await status({ log });
  const base = host.current && commitExists(host.current, cwd) ? host.current : null;
  if (host.current && !base) log(`live lane release ${host.current.slice(0, 8)} is not in this repository; sending every file`);
  if (host.current === sha) {
    log(`measure-internal ${sha.slice(0, 8)} is already live`);
    return { lane: LANE.name, sha, status: "unchanged", previous: host.previous, serving: host.serving };
  }

  const gates = await quickChecks({ sha, base, cwd, log });
  if (!gates.ok) {
    const error = new Error(`lane checks failed: ${gates.failures.map((failure) => failure.id).join(", ")}`);
    error.record = { lane: LANE.name, sha, status: "rejected", reason: "checks", gates };
    throw error;
  }

  const files = manifest(sha, cwd);
  const changed = changedPaths(base, sha, cwd, [LANE.deploys]);
  const deployedChanged = changed?.filter((f) => f.startsWith(LANE.deploys + "/")).map((f) => f.slice(LANE.deploys.length + 1));
  let full = !deployedChanged || deployedChanged.length > SEND_ALL_ABOVE;
  let attempt = 0;
  for (;;) {
    attempt++;
    const present = (deployedChanged || []).filter((f) => files[f]);
    const probe = present.find((f) => !f.endsWith(".php") && !f.startsWith("unused/")) || LANE.probe;
    const sent = full ? Object.keys(files) : [...new Set([...present, probe])];
    const phpLint = (full && !base ? Object.keys(files) : present).filter((f) => f.endsWith(".php") && !f.startsWith("unused/"));
    const work = mkdtempSync(path.join(os.tmpdir(), "fm-lane-payload-"));
    try {
      writeFileSync(path.join(work, "lane-manifest.json"), JSON.stringify({ sha, base, files, sent, php_lint: phpLint, probe }));
      const archiveArgs = ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "archive", "--format=tar", "--prefix=payload/",
        `--add-file=${path.join(work, "lane-manifest.json")}`, `--add-file=${hostScript()}`, sha, "--",
        ...(full ? [LANE.deploys] : sent.map((f) => `${LANE.deploys}/${f}`))];
      log(`shipping ${sha.slice(0, 8)}: ${full ? "every file" : `${sent.length} file(s)`} over ${host.current ? host.current.slice(0, 8) : "nothing"}`);
      const remote = 'set -u; mkdir -p /opt/firstmeasure/lanes/measure-internal/incoming; ' +
        'D=$(mktemp -d /opt/firstmeasure/lanes/measure-internal/incoming/d.XXXXXX); ' +
        'tar -x -C "$D" && bash "$D/payload/lane-host.sh" deploy "$D/payload"; rc=$?; rm -rf "$D"; exit $rc';
      const r = await ssh(remote, {
        log,
        stdinFrom: (stdin) => {
          const archive = spawn("git", archiveArgs, { cwd, stdio: ["ignore", "pipe", "inherit"] });
          archive.stdout.pipe(stdin);
        }
      });
      const record = marker(r.stdout, "LANE-RECORD");
      if (r.code === 3 && r.stdout.includes("LANE-NEED-FULL") && !full && attempt === 1) {
        log("live release differs from its commit; sending every file");
        full = true;
        continue;
      }
      if (r.code !== 0 || !record || record.status !== "live" && record.status !== "unchanged") {
        const error = new Error(`lane deploy failed (exit ${r.code}): ${r.stderr.trim().split("\n").slice(-5).join(" | ")}`);
        error.record = { ...(record || { lane: LANE.name, sha, status: "failed" }), gates };
        throw error;
      }
      return { ...record, gates, changed: changed ?? "all", duration_ms: Date.now() - began };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}

export async function rollback(sha, { log = (l) => console.error(l) } = {}) {
  const r = await hostCommand(`rollback ${sha || ""}`, log);
  if (r.code !== 0) throw new Error(`rollback failed: ${r.stderr.trim()}`);
  return marker(r.stdout, "LANE-RECORD");
}

export async function install({ log = (l) => console.error(l) } = {}) {
  const r = await hostCommand("install", log);
  if (r.code !== 0) throw new Error(`install failed: ${r.stderr.trim()}`);
  return marker(r.stdout, "LANE-STATUS");
}

export async function follow({ log = (l) => console.error(l) } = {}) {
  const r = await hostCommand("follow", log);
  if (r.code !== 0) throw new Error(`follow failed: ${r.stderr.trim()}`);
  return marker(r.stdout, "LANE-STATUS");
}

export async function uninstall({ log = (l) => console.error(l) } = {}) {
  const r = await hostCommand("uninstall", log);
  if (r.code !== 0) throw new Error(`uninstall failed: ${r.stderr.trim()}`);
  return marker(r.stdout, "LANE-STATUS");
}

// ---- dev push router lane module ----------------------------------------------------

const PLATFORM_PUBLIC = "/opt/firstmeasure/current/public";
const PUBLIC_URL = process.env.DEV_PUSH_PUBLIC_URL || "https://dev.1m8.ai";
// legacy serves the editor; web and worker Node render shared PDFs from it
// (FIRSTMEASURE_EDITOR_RUNTIME_ROOT in the router's release.env).
const ROLES = ["legacy", "web", "worker"];

/**
 * The lane's release tree for `sha` in `out`: public/measure/internal from the
 * commit, every sibling of it a symlink into the platform release that is
 * current on the host, so the editor's relative includes and storage resolve as
 * they do in the platform release. Built from git only.
 */
export function buildTree(sha, cwd, out) {
  mkdirSync(out, { recursive: true });
  const archive = spawnSync("git", ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "archive", "--format=tar", sha, "--", LANE.deploys],
    { cwd, maxBuffer: 2 ** 31 });
  if (archive.status !== 0) throw new Error(`git archive: ${archive.stderr}`);
  const untar = spawnSync("tar", ["-x"], { cwd: out, input: archive.stdout, maxBuffer: 1 << 20 });
  if (untar.status !== 0) throw new Error(`tar: ${untar.stderr}`);
  const entries = (dir) => git(["ls-tree", "--name-only", sha, `${dir}/`], { cwd }).split("\n").filter(Boolean).map((p) => path.posix.basename(p));
  const top = new Set([...entries("public"), "storage"]);
  top.delete("measure");
  for (const name of top) symlinkSync(`${PLATFORM_PUBLIC}/${name}`, path.join(out, "public", name));
  for (const name of entries("public/measure")) {
    if (name !== "internal") symlinkSync(`${PLATFORM_PUBLIC}/measure/${name}`, path.join(out, "public", "measure", name));
  }
  return out;
}

// fm-release leaves the host's runtime paths out of a staged tree's check (HOST_PATHS in
// tools/dev-push/host/fm-release.py); the lane's public/storage link still travels with the tree.
const HOST_PATHS = new Set(["public/storage", "public/v1/storage", "public/v1/output"]);

/** Same shape and digest as the router's treeManifest (lanes/platform/lane.mjs) and fm-release. */
export function treeManifest(root) {
  const files = {}, links = {};
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix + entry.name;
      if (HOST_PATHS.has(rel)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) { links[rel] = readlinkSync(full); continue; }
      if (entry.isDirectory()) { walk(full, `${rel}/`); continue; }
      const stat = statSync(full);
      files[rel] = [createHash("sha256").update(readFileSync(full)).digest("hex"), stat.size, stat.mode & 0o777];
    }
  };
  walk(root, "");
  const digest = createHash("sha256");
  for (const rel of Object.keys(files).sort()) digest.update(`f ${rel} ${files[rel][0]}\n`);
  for (const rel of Object.keys(links).sort()) digest.update(`l ${rel} ${links[rel]}\n`);
  return { files, links, tree_sha256: digest.digest("hex") };
}

/** dev.1m8.ai serves `rel` with the release's bytes and lane header. */
async function servedReady(sha, rel, want, seconds = 30) {
  let last = "";
  for (let i = 0; i < seconds; i++) {
    try {
      const response = await fetch(`${PUBLIC_URL}/measure/internal/${rel}`, { signal: AbortSignal.timeout(8000), headers: { "cache-control": "no-cache" } });
      const body = Buffer.from(await response.arrayBuffer());
      const header = response.headers.get("x-firstmate-lane") || "";
      const got = createHash("sha256").update(body).digest("hex");
      if (response.ok && header === `${LANE.name} ${sha}` && got === want) return null;
      last = `${response.status} '${header}' sha256 ${got.slice(0, 12)}`;
    } catch (error) { last = error.message; }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return `${PUBLIC_URL}/measure/internal/${rel} did not serve ${sha.slice(0, 10)}: ${last}`;
}

const regressionScope = (regression, tests = []) =>
  regression === "all" || tests.includes("regression:all") ? "all" : regression === "mapped" || regression === true || tests.includes("regression") ? "mapped" : null;

const timed = async (work) => { const began = Date.now(); const value = await work(); return [value, Date.now() - began]; };

export default {
  name: LANE.name,
  branch: LANE.branch,
  batchMax: 8,
  owns: ownsPath,

  // Quick checks always (node --check here; PHP lint runs on the host in deploy
  // when this machine has no php); the editor's regression tests only when the
  // submission asks (`regression`: "mapped" | "all").
  async gates({ dir, sha, baseSha, regression = null, tests = [], only, log = () => {} }) {
    const want = (id) => !only || only.some((item) => item === id || id.startsWith(`${item}:`));
    const timings = {};
    const [checks, checksMs] = await timed(() => quickChecks({ sha, base: baseSha, cwd: dir, log }));
    timings.checks = checksMs;
    const failures = checks.failures.filter((failure) => want(failure.id));
    const notes = [...checks.notes];
    const scope = regressionScope(regression, tests);
    if (scope && want("regression")) {
      const began = Date.now();
      if (!existsSync(path.join(dir, "public", "v1", "node_modules"))) {
        const { ensureModules } = await import("../platform/lane.mjs");
        await ensureModules(dir, log);
      }
      if (!linuxBrowser() && process.platform !== "win32") notes.push("no Chromium on this host: the editor's browser tests fail here and count as known only if they also fail on the base");
      const result = await runRegression({ sha, base: baseSha, cwd: dir, tests: scope, log });
      for (const file of result.failed) failures.push({ id: `regression:${file}`, output: result.tails[file] || "" });
      if (result.known.length) notes.push(`known failures (also on ${String(baseSha).slice(0, 10)}): ${result.known.join(", ")}`);
      notes.push(`regression ${scope}: ${result.ran.length} file(s) in ${Math.round(result.ms / 1000)} s`);
      timings.regression = Date.now() - began;
      timings.regression_files = result.times;
    }
    return { ok: failures.length === 0, failures, notes, timings };
  },

  // Stages the tree on every role, lints the changed PHP inside the staged
  // release on legacy, activates legacy, web and worker, checks dev.1m8.ai
  // serves it, and puts every role back if anything fails.
  async deploy({ dir, sha, hosts, log = () => {} }) {
    const began = Date.now();
    const timings = { stage: {}, activate: {} };
    const roles = ROLES.filter((role) => hosts.roles.includes(role));
    const before = Object.fromEntries(await Promise.all(roles.map(async (role) => [role, await hosts.status(role, LANE.name)])));
    const broken = roles.filter((role) => !before[role].ok);
    if (broken.length) return { ok: false, error: `status failed: ${broken.map((role) => `${role}: ${before[role].error}`).join("; ")}`, rolledBack: true, infrastructure: true, timings };
    const previous = Object.fromEntries(roles.map((role) => [role, before[role].lanes?.[LANE.name]?.current || null]));
    const build = mkdtempSync(path.join(os.tmpdir(), `fm-lane-tree-${sha.slice(0, 8)}-`));
    try {
      let mark = Date.now();
      buildTree(sha, dir, build);
      const tree = treeManifest(build);
      timings.build = Date.now() - mark;
      log(`staging ${sha.slice(0, 10)} on ${roles.join(", ")} (${Object.keys(tree.files).length} files, tree ${tree.tree_sha256.slice(0, 12)})`);
      const staged = await Promise.all(roles.map(async (role) => {
        const [result, ms] = await timed(() => hosts.stage(role, { lane: LANE.name, sha, dir: build, manifest: tree, releases: before[role].lanes?.[LANE.name]?.releases }));
        timings.stage[role] = ms;
        return result;
      }));
      const stageErrors = roles.filter((_, index) => !staged[index].ok);
      if (stageErrors.length) return { ok: false, error: `staging failed: ${stageErrors.map((role) => `${role}: ${staged[roles.indexOf(role)].error}`).join("; ")}`, rolledBack: true, infrastructure: true, timings };

      // PHP lint where PHP runs (the router host has no php).
      const base = previous.legacy && commitExists(previous.legacy, dir) ? previous.legacy : null;
      const changed = (changedPaths(base, sha, dir, [LANE.deploys]) || Object.keys(tree.files)).filter((file) => tree.files[file]);
      const php = changed.filter((file) => file.endsWith(".php") && !skipCheck(file.slice(LANE.deploys.length + 1)));
      if (php.length && !hasPhp() && roles.includes("legacy")) {
        if (typeof hosts.check !== "function") log(`hosts.check unavailable: ${php.length} PHP file(s) not linted`);
        else {
          mark = Date.now();
          const checked = await hosts.check("legacy", { lane: LANE.name, sha, paths: php });
          timings.php_lint = Date.now() - mark;
          if (!checked.ok) return { ok: false, error: `PHP lint failed on legacy:\n${checked.error || JSON.stringify(checked.failures || checked)}`, rolledBack: true, timings };
        }
      }

      const activated = [];
      for (const role of roles) {
        const [result, ms] = await timed(() => hosts.activate(role, { lane: LANE.name, sha, expect: previous[role] }));
        timings.activate[role] = ms;
        activated.push(result);
      }
      let error = roles.filter((_, index) => !activated[index].ok).map((role) => `${role}: ${activated[roles.indexOf(role)].error}`).join("; ");
      if (!error) {
        const probe = changed.map((file) => file.slice(LANE.deploys.length + 1)).find((rel) => tree.files[`${LANE.deploys}/${rel}`] && !rel.endsWith(".php") && !skipCheck(rel)) || LANE.probe;
        mark = Date.now();
        error = await servedReady(sha, probe, tree.files[`${LANE.deploys}/${probe}`][0]) || "";
        timings.ready = Date.now() - mark;
      }
      if (error) {
        log(`not ready, rolling back: ${error}`);
        const back = await Promise.all(roles.map(async (role, index) => {
          if (!activated[index]?.ok || !previous[role] || previous[role] === sha) return { role, ok: true };
          return { role, ...(await hosts.rollback(role, { lane: LANE.name, sha: previous[role] })) };
        }));
        const notBack = back.filter((item) => !item.ok);
        timings.total = Date.now() - began;
        return { ok: false, error: error + (notBack.length ? `\nROLLBACK FAILED on ${notBack.map((item) => `${item.role}: ${item.error}`).join("; ")}` : ""), rolledBack: notBack.length === 0, timings };
      }
      Promise.all(roles.map((role) => hosts.prune(role, { lane: LANE.name }))).catch(() => {});
      timings.total = Date.now() - began;
      return { ok: true, name: sha, roles: Object.fromEntries(roles.map((role, index) => [role, { previous: previous[role], tree_sha256: staged[index].tree_sha256 || tree.tree_sha256 }])), timings };
    } finally {
      rmSync(build, { recursive: true, force: true });
    }
  },

  async current({ hosts }) {
    const roles = ROLES.filter((role) => hosts.roles.includes(role));
    const statuses = await Promise.all(roles.map((role) => hosts.status(role, LANE.name)));
    return Object.fromEntries(roles.map((role, index) => [role, statuses[index].lanes?.[LANE.name]?.current || null]));
  }
};
