// The platform lane (docs/architecture/dev-lanes.md): canonical -> every dev role (web, worker, legacy).
// Gates (Jack's rule: only checks that take a second or two run on every submission): a syntax parse of changed
// JavaScript and a per-file transpile of changed TypeScript; PHP is linted on the hosts after staging. Browser files
// and live overlays get the JavaScript parse only. The type check and the test suites are opt-in regression gates
// (`submit.mjs --regression`, or `submit.mjs regression` without shipping).
// Deploy: one immutable release built from the merged commit (git archive + transpiled dist + node_modules), uploaded
// to every role, activated on all of them together, rolled back together if any role is not ready.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { LANES, laneOf, run } from "../../lib/common.mjs";
import { ALWAYS, COMMANDS, AREAS, testsFor } from "./test-map.mjs";
import { buildDist as transpileDist, transpileSource } from "./transpile.mjs";
import { missingReferences } from "./references.mjs";

const HOME = process.env.DEV_PUSH_HOME || path.join(os.homedir(), "dev-push");
const CACHE = path.join(HOME, "cache");
const BUILDS = path.join(HOME, "builds", "platform");
const PUBLIC_URL = process.env.DEV_PUSH_PUBLIC_URL || "https://dev.1m8.ai";
const TEST_TIMEOUT_MS = 6 * 60_000;
const TEST_ENV = { FIRSTMEASURE_INTERNAL_API_SECRET: "ci-test-internal-service-secret", CI: "1", NODE_OPTIONS: "--max-old-space-size=3072" };
/** Where every role's PDF runtime reads the measure editor's scripts (the measure-internal lane), if present. */
/** Bump when transpile.mjs changes what it emits, so cached dists are rebuilt. */
const DIST_BUILDER = 2;
const EDITOR_RUNTIME_ROOT = "/opt/firstmeasure/lanes/measure-internal/current/public/measure/internal";

const tail = (text, max = 4000) => { const value = String(text || ""); return value.length > max ? `...${value.slice(-max)}` : value; };
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
async function sh(command, options = {}) { return run("bash", ["-c", command], options); }
const since = (at) => Date.now() - at;

/** A browser file: under public/ but not server code, PHP or a page. These get no gates beyond a parse. */
export const isBrowserFile = (file) => file.startsWith("public/") && !file.startsWith("public/v1/") && !/\.(php|html?)$/i.test(file);

/** node_modules for public/v1: `npm ci` only when package.json, package-lock.json or Node changed; else a link. */
export async function ensureModules(dir, log = () => {}) {
  const v1 = path.join(dir, "public", "v1");
  const hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(v1, "package.json"))).update(fs.readFileSync(path.join(v1, "package-lock.json"))).update(process.version).digest("hex").slice(0, 16);
  const cache = path.join(CACHE, "modules", hash);
  if (!fs.existsSync(path.join(cache, "node_modules"))) {
    log(`installing node_modules ${hash} (npm ci: package-lock.json or Node changed)`);
    const tmp = `${cache}.tmp-${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    for (const name of ["package.json", "package-lock.json"]) fs.copyFileSync(path.join(v1, name), path.join(tmp, name));
    const result = await run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: tmp, timeout: 20 * 60_000 });
    if (result.code !== 0) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error(`npm ci failed: ${tail(result.stderr || result.stdout, 1500)}`); }
    fs.renameSync(tmp, cache);
    pruneDir(path.join(CACHE, "modules"), 3);
  }
  const link = path.join(v1, "node_modules");
  const current = fs.lstatSync(link, { throwIfNoEntry: false });
  if (current && !(current.isSymbolicLink() && fs.readlinkSync(link) === path.join(cache, "node_modules"))) fs.rmSync(link, { recursive: true, force: true });
  if (!fs.lstatSync(link, { throwIfNoEntry: false })) fs.symlinkSync(path.join(cache, "node_modules"), link, "dir");
  return path.join(cache, "node_modules");
}

/** dist for a public/v1 tree (cached by that tree's git id, so a release that does not touch public/v1 reuses it). */
export async function distFor(dir, sha, log = () => {}) {
  const v1Tree = (await run("git", ["rev-parse", `${sha}:public/v1`], { cwd: dir })).stdout.trim();
  const out = path.join(CACHE, "dist", `${v1Tree}-b${DIST_BUILDER}`);
  if (fs.existsSync(path.join(out, "src", "server.js"))) return { ok: true, dist: out, cached: true };
  const tmp = `${out}.tmp-${process.pid}`;
  const started = Date.now();
  const result = transpileDist(path.join(dir, "public", "v1"), tmp, path.join(CACHE, "transpiled"));
  if (!result.ok) { fs.rmSync(tmp, { recursive: true, force: true }); return { ok: false, output: result.errors.slice(0, 40).join("\n") }; }
  fs.renameSync(tmp, out);
  log(`dist ${v1Tree.slice(0, 10)}: ${result.files} files, ${result.transpiled} transpiled, ${since(started)} ms`);
  pruneDir(path.join(CACHE, "dist"), 8);
  return { ok: true, dist: out };
}

function testCommand(dir, id) {
  const [scope, rest] = [id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1)];
  const v1 = path.join(dir, "public", "v1");
  if (scope === "root") return { cwd: dir, file: path.join(dir, rest), args: ["node", "--test", "--test-force-exit", rest] };
  if (scope === "any") return testCommand(dir, fs.existsSync(path.join(v1, rest)) ? `v1:${rest}` : `root:${rest}`);
  if (rest.startsWith("npm:")) return { cwd: v1, args: ["npm", "run", "--silent", rest.slice(4)] };
  if (rest.startsWith("cmd:")) return { cwd: v1, args: COMMANDS[rest.slice(4)] };
  if (/-postgres\.test\.ts$/.test(rest)) return { cwd: v1, file: path.join(v1, rest), args: ["node", "tests/run-embedded-postgres.mjs", rest] };
  return { cwd: v1, file: path.join(v1, rest), args: ["node", "--experimental-sqlite", "--import", "tsx", "--test", "--test-force-exit", rest] };
}

const needsBrowser = (file) => { try { return /playwright|chromium|puppeteer/.test(fs.readFileSync(file, "utf8")); } catch { return false; } };

async function pool(items, limit, work) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const index = next++; results[index] = await work(items[index]); } }));
  return results;
}

/** The incremental type check (opt-in): `tsc --noEmit` with build info kept per checkout. */
async function typeCheck(dir) {
  const info = path.join(CACHE, `tsbuildinfo-${crypto.createHash("sha1").update(dir).digest("hex").slice(0, 8)}`);
  const result = await run("node", ["node_modules/typescript/bin/tsc", "--noEmit", "--incremental", "--tsBuildInfoFile", info, "-p", "tsconfig.json"], { cwd: path.join(dir, "public", "v1"), timeout: 20 * 60_000, env: { NODE_OPTIONS: "--max-old-space-size=3584" } });
  return result.code === 0 ? null : tail(result.stdout + result.stderr, 6000);
}

export default {
  name: "platform",
  branch: LANES.platform.branch,
  batchMax: 6,
  owns: (file) => laneOf(file) === "platform",

  async gates({ dir, sha, changed, tests = [], regression = null, only, log }) {
    const failures = [], notes = [], timings = {};
    const want = (id) => !only || only.includes(id);
    const existing = changed.filter((file) => fs.existsSync(path.join(dir, file)));

    // Always, milliseconds: parse changed JavaScript; transpile changed TypeScript on its own.
    let at = Date.now();
    for (const file of existing.filter((item) => /\.(m?js|cjs)$/.test(item) && !item.includes("/node_modules/"))) {
      const id = `parse:${file}`;
      if (!want(id)) continue;
      const result = await run("node", ["--check", file], { cwd: dir, timeout: 60_000 });
      if (result.code !== 0) failures.push({ id, output: tail(result.stderr, 2000) });
    }
    timings.parse_js = since(at);
    // Always: nothing in the tree may point at a file the tree lacks (a release built from git has no host leftovers).
    if (want("references")) {
      at = Date.now();
      const missing = missingReferences(dir);
      timings.references = since(at);
      if (missing.length) failures.push({ id: "references", output: missing.map((item) => `${item.path} is missing, referenced by ${item.from}: ${item.ref}`).join("\n") });
    }
    const server = existing.filter((file) => !isBrowserFile(file));
    const ts = server.filter((file) => file.startsWith("public/v1/") && file.endsWith(".ts") && !file.endsWith(".d.ts"));
    if (ts.length) {
      at = Date.now();
      await ensureModules(dir, log);
      timings.deps = since(at);
      at = Date.now();
      const typescript = createRequire(path.join(dir, "public", "v1", "package.json"))("typescript");
      for (const file of ts) {
        const id = `transpile:${file}`;
        if (!want(id)) continue;
        const result = transpileSource(typescript, fs.readFileSync(path.join(dir, file), "utf8"), file);
        if (!result.ok) failures.push({ id, output: result.errors.join("\n") });
      }
      timings.transpile_ts = since(at);
    }

    // Suites under two seconds (ALWAYS) run whenever the change maps to them; the type check and every other suite
    // only on request (the mapped ones, or every AGENTS.md suite with "all").
    const mapped = testsFor(server, tests);
    if (regression || mapped.some((id) => ALWAYS.has(id))) {
      await ensureModules(dir, log);
      if (regression && want("typecheck") && (regression === "all" || server.some((file) => file.startsWith("public/v1/")))) {
        at = Date.now();
        const output = await typeCheck(dir);
        timings.typecheck = since(at);
        if (output) failures.push({ id: "typecheck", output });
      }
      const ids = regression === "all" ? [...new Set(AREAS.flatMap(([, list]) => list))].sort() : regression ? mapped : mapped.filter((id) => ALWAYS.has(id));
      const runnable = [];
      for (const id of ids.filter(want)) {
        const command = testCommand(dir, id);
        if (!command.args) { notes.push(`unknown gate ${id}`); continue; }
        if (command.file && !fs.existsSync(command.file)) { notes.push(`${id}: no such test`); continue; }
        if (command.file && needsBrowser(command.file) && !process.env.CHROME_PATH) { notes.push(`${id}: skipped (needs a browser, none on the router host)`); continue; }
        runnable.push([id, command]);
      }
      log(`${regression ? `regression (${regression})` : "quick suites"} ${sha.slice(0, 10)}: ${runnable.length} suite(s)`);
      const results = await pool(runnable, 2, async ([id, command]) => {
        const started = Date.now();
        const result = await run(command.args[0], command.args.slice(1), { cwd: command.cwd, timeout: TEST_TIMEOUT_MS, env: TEST_ENV });
        timings[`test:${id}`] = since(started);
        log(`  ${result.code === 0 ? "pass" : "FAIL"} ${id} (${Math.round(since(started) / 1000)} s)`);
        return result.code === 0 ? null : { id, output: tail(result.stdout + "\n" + result.stderr) };
      });
      failures.push(...results.filter(Boolean));
    } else if (regression) notes.push("regression asked, but only browser files changed: nothing to run");
    return { ok: failures.length === 0, failures, notes, timings };
  },

  /** Builds the release tree for `sha` and puts it on every role together. */
  async deploy({ dir, sha, releaseId, previous: previousRelease = null, hosts, log, buildOnly = false, stageOnly = false }) {
    const timings = {};
    let at = Date.now();
    const roles = hosts.roles;
    const before = Object.fromEntries(await Promise.all(roles.map(async (role) => [role, await hosts.status(role, "platform", sha)])));
    timings.status = since(at);
    const broken = roles.filter((role) => !before[role].ok);
    if (broken.length) return { ok: false, error: `status failed: ${broken.map((role) => `${role}: ${before[role].error}`).join("; ")}`, rolledBack: true, infrastructure: true, timings };
    // The release directory is named for the commit, or <commit>-dp where the old tooling already made one of that
    // name (the running release at the re-baseline). RELEASE_ID equals the directory name; the web standby relies on it.
    const name = roles.some((role) => before[role].probe?.[sha]?.exists && !before[role].probe[sha].router) ? `${sha}-dp` : sha;
    const build = path.join(BUILDS, name);
    if (!fs.existsSync(path.join(build, ".manifest.json"))) {
      at = Date.now();
      const modules = await ensureModules(dir, log);
      timings.deps = since(at);
      at = Date.now();
      const dist = await distFor(dir, sha, log);
      timings.dist = since(at);
      if (!dist.ok) return { ok: false, error: `transpile failed:\n${dist.output}`, rolledBack: true, timings };
      at = Date.now();
      const tmp = `${build}.tmp-${process.pid}`;
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp, { recursive: true });
      const archive = await sh(`git -C '${dir}' archive --format=tar ${sha} | tar -x -C '${tmp}'`, { timeout: 10 * 60_000 });
      if (archive.code !== 0) throw new Error(`git archive: ${archive.stderr}`);
      const v1 = path.join(tmp, "public", "v1");
      fs.rmSync(path.join(v1, "dist"), { recursive: true, force: true });
      fs.rmSync(path.join(v1, "node_modules"), { recursive: true, force: true });
      for (const [from, to] of [[dist.dist, path.join(v1, "dist")], [modules, path.join(v1, "node_modules")]]) {
        const copied = await run("cp", ["-al", from, to]);
        if (copied.code !== 0) throw new Error(`cp ${from}: ${copied.stderr}`);
      }
      fs.writeFileSync(path.join(tmp, "release.env"), `RELEASE_ID=${name}\nRELEASE_COMMIT=${sha}\nDEV_PUSH_RELEASE=${releaseId}\nFIRSTMEASURE_EDITOR_RUNTIME_ROOT=${EDITOR_RUNTIME_ROOT}\n`);
      const manifest = await treeManifest(tmp);
      manifest.release_id = releaseId;
      fs.writeFileSync(path.join(tmp, ".manifest.json"), JSON.stringify(manifest));
      fs.renameSync(tmp, build);
      pruneDir(BUILDS, 4);
      timings.build_tree = since(at);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(build, ".manifest.json"), "utf8"));
    delete manifest.files[".manifest.json"];
    if (buildOnly) return { ok: true, build, name, tree_sha256: manifest.tree_sha256, files: Object.keys(manifest.files).length, timings };

    log(`staging ${name} on ${roles.join(", ")} (${Object.keys(manifest.files).length} files, tree ${manifest.tree_sha256.slice(0, 12)})`);
    const staged = await Promise.all(roles.map(async (role) => {
      const started = Date.now();
      const result = await hosts.stage(role, { lane: "platform", sha: name, dir: build, manifest: { ...manifest, files: withoutLocal(manifest.files) }, releases: before[role].lanes.platform.releases });
      timings[`transfer:${role}`] = since(started);
      return result;
    }));
    const stageErrors = roles.filter((_, index) => !staged[index].ok);
    if (stageErrors.length) return { ok: false, error: `staging failed: ${stageErrors.map((role) => `${role}: ${JSON.stringify(staged[roles.indexOf(role)])}`).join("; ")}`, rolledBack: true, infrastructure: true, timings };
    // PHP that changed is linted on a host (the router host has no PHP); a failure stops the release before activation.
    const php = previousRelease?.sha ? (await run("git", ["diff", "--name-only", "--diff-filter=AM", previousRelease.sha, sha, "--", "*.php"], { cwd: dir })).stdout.split("\n").filter(Boolean).slice(0, 200) : [];
    if (php.length && hosts.check) {
      at = Date.now();
      const checked = await hosts.check("legacy", { lane: "platform", sha: name, paths: php });
      timings.php_lint = since(at);
      // A lint answer names files; anything else (the host refused or was unreachable) is the router's problem.
      if (!checked.ok) return checked.output ? { ok: false, error: `PHP lint failed:\n${tail(checked.output, 3000)}`, rolledBack: true, timings } : { ok: false, error: `PHP lint could not run: ${checked.error}`, rolledBack: true, infrastructure: true, timings };
    }
    if (stageOnly) return { ok: true, name, staged: Object.fromEntries(roles.map((role, index) => [role, staged[index]])), timings };

    log(`activating ${name} on ${roles.join(", ")}`);
    const previous = Object.fromEntries(roles.map((role) => [role, before[role].lanes.platform.current]));
    const activated = await Promise.all(roles.map(async (role) => {
      const started = Date.now();
      const result = await hosts.activate(role, { lane: "platform", sha: name, expect: previous[role] });
      timings[`activate:${role}`] = since(started);
      return result;
    }));
    let failed = roles.filter((_, index) => !activated[index].ok);
    if (!failed.length) {
      at = Date.now();
      const publicError = await waitPublic(name);
      timings.public_ready = since(at);
      if (publicError) { failed = ["public"]; activated.push({ ok: false, error: publicError }); }
    }
    if (failed.length) {
      const errors = failed.map((role) => `${role}: ${(activated[roles.indexOf(role)] || activated.at(-1)).error}`).join("\n");
      log(`activation failed; rolling every role back:\n${errors}`);
      const back = await Promise.all(roles.map(async (role, index) => {
        if (!activated[index].ok && activated[index].rolled_back !== false) return { role, ok: true };
        if (!previous[role] || previous[role] === name) return { role, ok: true };
        return { role, ...(await hosts.rollback(role, { lane: "platform", sha: previous[role] })) };
      }));
      const notBack = back.filter((item) => !item.ok);
      return { ok: false, error: errors + (notBack.length ? `\nROLLBACK FAILED on ${notBack.map((item) => `${item.role}: ${item.error}`).join("; ")}` : ""), rolledBack: notBack.length === 0, timings };
    }
    Promise.all(roles.map((role) => hosts.prune(role, { lane: "platform" }))).then((results) => log(`pruned old releases: ${results.map((result, index) => `${roles[index]} ${result.removed ?? result.error}`).join(", ")}`)).catch(() => {});
    return { ok: true, name, timings, roles: Object.fromEntries(roles.map((role, index) => [role, { previous: previous[role], tree_sha256: staged[index].tree_sha256, reused: Boolean(activated[index].reused) }])) };
  },

  async current({ hosts }) {
    const statuses = await Promise.all(hosts.roles.map((role) => hosts.status(role, "platform")));
    return Object.fromEntries(hosts.roles.map((role, index) => [role, statuses[index].lanes?.platform?.current || null]));
  }
};

const withoutLocal = (files) => Object.fromEntries(Object.entries(files).filter(([rel]) => rel !== ".manifest.json"));

/** Every file (sha256, size, mode) and symlink of a tree, and the digest fm-release computes. */
export async function treeManifest(root) {
  const files = {}, links = {};
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix + entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) { links[rel] = fs.readlinkSync(full); continue; }
      if (entry.isDirectory()) { walk(full, `${rel}/`); continue; }
      const stat = fs.statSync(full);
      files[rel] = [sha256(full), stat.size, stat.mode & 0o777];
    }
  };
  walk(root, "");
  delete files[".manifest.json"];
  const digest = crypto.createHash("sha256");
  for (const rel of Object.keys(files).sort()) digest.update(`f ${rel} ${files[rel][0]}\n`);
  for (const rel of Object.keys(links).sort()) digest.update(`l ${rel} ${links[rel]}\n`);
  return { files, links, tree_sha256: digest.digest("hex") };
}

function pruneDir(dir, keep) {
  try {
    const entries = fs.readdirSync(dir).filter((name) => !name.includes(".tmp-")).map((name) => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs })).sort((a, b) => b.at - a.at);
    for (const { name } of entries.slice(keep)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  } catch {}
}

/** dev.1m8.ai answers ready on the new release twice in a row. */
async function waitPublic(name, seconds = 180) {
  let good = 0, last = "";
  for (let i = 0; i < seconds / 3; i++) {
    try {
      const response = await fetch(`${PUBLIC_URL}/v1/health/ready`, { signal: AbortSignal.timeout(8000), headers: { "cache-control": "no-cache" } });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.ok && data.release_id === name) { if (++good >= 2) return null; }
      else { good = 0; last = `${response.status} release ${data.release_id || "?"}`; }
    } catch (error) { good = 0; last = error.message; }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return `${PUBLIC_URL}/v1/health/ready did not report ${name}: ${last}`;
}
