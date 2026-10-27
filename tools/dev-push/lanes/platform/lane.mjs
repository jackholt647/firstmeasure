// The platform lane (docs/architecture/dev-lanes.md): canonical -> every dev role (web, worker, legacy).
// Gates: a full TypeScript build of public/v1 (type check + the dist that ships) and the tests the changed paths map
// to (test-map.mjs). Deploy: one immutable release built from the merged commit (git archive + dist + node_modules),
// uploaded to every role, activated on all of them together, rolled back together if any role is not ready.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LANES, laneOf, run } from "../../lib/common.mjs";
import { COMMANDS, testsFor } from "./test-map.mjs";

const HOME = process.env.DEV_PUSH_HOME || path.join(os.homedir(), "dev-push");
const CACHE = path.join(HOME, "cache");
const BUILDS = path.join(HOME, "builds", "platform");
const PUBLIC_URL = process.env.DEV_PUSH_PUBLIC_URL || "https://dev.1m8.ai";
const TEST_TIMEOUT_MS = 6 * 60_000;
const MAX_TESTS = 40;
const TEST_ENV = { FIRSTMEASURE_INTERNAL_API_SECRET: "ci-test-internal-service-secret", CI: "1", NODE_OPTIONS: "--max-old-space-size=3072" };

const tail = (text, max = 4000) => { const value = String(text || ""); return value.length > max ? `...${value.slice(-max)}` : value; };
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

async function sh(command, options = {}) { return run("bash", ["-c", command], options); }

/** node_modules for public/v1, installed once per package-lock and linked into checkouts and releases. */
export async function ensureModules(dir, log = () => {}) {
  const v1 = path.join(dir, "public", "v1");
  const hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(v1, "package.json"))).update(fs.readFileSync(path.join(v1, "package-lock.json"))).digest("hex").slice(0, 16);
  const cache = path.join(CACHE, "modules", hash);
  if (!fs.existsSync(path.join(cache, "node_modules"))) {
    log(`installing node_modules ${hash} (npm ci)`);
    const tmp = `${cache}.tmp-${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    for (const name of ["package.json", "package-lock.json"]) fs.copyFileSync(path.join(v1, name), path.join(tmp, name));
    const result = await run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: tmp, timeout: 20 * 60_000 });
    if (result.code !== 0) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error(`npm ci failed: ${tail(result.stderr || result.stdout, 1500)}`); }
    fs.renameSync(tmp, cache);
  }
  const link = path.join(v1, "node_modules");
  const current = fs.existsSync(link) || fs.lstatSync(link, { throwIfNoEntry: false }) ? fs.lstatSync(link) : null;
  if (current && !(current.isSymbolicLink() && fs.readlinkSync(link) === path.join(cache, "node_modules"))) fs.rmSync(link, { recursive: true, force: true });
  if (!fs.lstatSync(link, { throwIfNoEntry: false })) fs.symlinkSync(path.join(cache, "node_modules"), link, "dir");
  return path.join(cache, "node_modules");
}

/** Type-checks and builds public/v1 into a dist cached per git tree. Returns { ok, dist, output }. */
export async function buildDist(dir, treeSha, log = () => {}) {
  const out = path.join(CACHE, "dist", treeSha);
  if (fs.existsSync(path.join(out, "src", "server.js"))) return { ok: true, dist: out, cached: true };
  const tmp = `${out}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  log(`tsc build ${treeSha.slice(0, 10)}`);
  const result = await run("node", ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json", "--outDir", tmp], { cwd: path.join(dir, "public", "v1"), timeout: 20 * 60_000, env: { NODE_OPTIONS: "--max-old-space-size=3584" } });
  if (result.code !== 0) { fs.rmSync(tmp, { recursive: true, force: true }); return { ok: false, output: tail(result.stdout + result.stderr, 6000) }; }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.renameSync(tmp, out);
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

/** Runs commands with limited parallelism. */
async function pool(items, limit, work) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const index = next++; results[index] = await work(items[index]); } }));
  return results;
}

export default {
  name: "platform",
  branch: LANES.platform.branch,
  batchMax: 6,
  owns: (file) => laneOf(file) === "platform",

  async gates({ dir, sha, changed, tests = [], only, log }) {
    const failures = [];
    const notes = [];
    const want = (id) => !only || only.includes(id);
    await ensureModules(dir, log);
    const treeSha = (await run("git", ["rev-parse", `${sha}^{tree}`], { cwd: dir })).stdout.trim();
    if (want("tsc")) {
      const build = await buildDist(dir, treeSha, log);
      if (!build.ok) failures.push({ id: "tsc", output: build.output });
    }
    // Browser scripts must at least parse.
    for (const file of changed.filter((item) => /^public\/(?!v1\/).*\.(m?js)$/.test(item) && fs.existsSync(path.join(dir, item)))) {
      const id = `node-check:${file}`;
      if (!want(id)) continue;
      const result = await run("node", ["--check", file], { cwd: dir, timeout: 60_000 });
      if (result.code !== 0) failures.push({ id, output: tail(result.stderr, 2000) });
    }
    let ids = testsFor(changed, tests).filter(want);
    if (ids.length > MAX_TESTS) { notes.push(`${ids.length - MAX_TESTS} mapped test(s) not run (cap ${MAX_TESTS}): ${ids.slice(MAX_TESTS).join(", ")}`); ids = ids.slice(0, MAX_TESTS); }
    const runnable = [];
    for (const id of ids) {
      const command = testCommand(dir, id);
      if (!command.args) { notes.push(`unknown gate ${id}`); continue; }
      if (command.file && !fs.existsSync(command.file)) { notes.push(`${id}: no such test`); continue; }
      if (command.file && needsBrowser(command.file) && !process.env.CHROME_PATH) { notes.push(`${id}: skipped (needs a browser; run it yourself before submitting)`); continue; }
      runnable.push([id, command]);
    }
    log(`gates ${sha.slice(0, 10)}: tsc + ${runnable.length} test(s)${notes.length ? `; ${notes.length} note(s)` : ""}`);
    const results = await pool(runnable, 2, async ([id, command]) => {
      const started = Date.now();
      const result = await run(command.args[0], command.args.slice(1), { cwd: command.cwd, timeout: TEST_TIMEOUT_MS, env: TEST_ENV });
      log(`  ${result.code === 0 ? "pass" : "FAIL"} ${id} (${Math.round((Date.now() - started) / 1000)} s)`);
      return result.code === 0 ? null : { id, output: tail(result.stdout + "\n" + result.stderr) };
    });
    failures.push(...results.filter(Boolean));
    return { ok: failures.length === 0, failures, notes };
  },

  /** Builds the release tree for `sha` and puts it on every role together. */
  async deploy({ dir, sha, releaseId, hosts, log }) {
    const treeSha = (await run("git", ["rev-parse", `${sha}^{tree}`], { cwd: dir })).stdout.trim();
    const build = path.join(BUILDS, sha);
    if (!fs.existsSync(path.join(build, ".manifest.json"))) {
      const modules = await ensureModules(dir, log);
      const dist = await buildDist(dir, treeSha, log);
      if (!dist.ok) return { ok: false, error: `build failed:\n${dist.output}`, rolledBack: true };
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
      fs.writeFileSync(path.join(tmp, "release.env"), `RELEASE_ID=${sha}\nRELEASE_COMMIT=${sha}\nDEV_PUSH_RELEASE=${releaseId}\n`);
      const manifest = await treeManifest(tmp);
      manifest.release_id = releaseId;
      fs.writeFileSync(path.join(tmp, ".manifest.json"), JSON.stringify(manifest));
      fs.renameSync(tmp, build);
      pruneDir(BUILDS, 4);
      pruneDir(path.join(CACHE, "dist"), 6);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(build, ".manifest.json"), "utf8"));
    delete manifest.files[".manifest.json"];

    const roles = hosts.roles;
    const before = Object.fromEntries(await Promise.all(roles.map(async (role) => [role, await hosts.status(role, "platform")])));
    const broken = roles.filter((role) => !before[role].ok);
    if (broken.length) return { ok: false, error: `status failed: ${broken.map((role) => `${role}: ${before[role].error}`).join("; ")}`, rolledBack: true, infrastructure: true };
    log(`staging ${sha.slice(0, 10)} on ${roles.join(", ")} (${Object.keys(manifest.files).length} files, tree ${manifest.tree_sha256.slice(0, 12)})`);
    const staged = await Promise.all(roles.map((role) => hosts.stage(role, { lane: "platform", sha, dir: build, manifest: { ...manifest, files: withoutLocal(manifest.files) }, releases: before[role].lanes.platform.releases })));
    const stageErrors = roles.filter((_, index) => !staged[index].ok);
    if (stageErrors.length) return { ok: false, error: `staging failed: ${stageErrors.map((role) => `${role}: ${JSON.stringify(staged[roles.indexOf(role)])}`).join("; ")}`, rolledBack: true, infrastructure: true };

    log(`activating ${sha.slice(0, 10)} on ${roles.join(", ")}`);
    const previous = Object.fromEntries(roles.map((role) => [role, before[role].lanes.platform.current]));
    const activated = await Promise.all(roles.map((role) => hosts.activate(role, { lane: "platform", sha, expect: previous[role] })));
    let failed = roles.filter((_, index) => !activated[index].ok);
    if (!failed.length) {
      const publicError = await waitPublic(sha);
      if (publicError) { failed = ["public"]; activated.push({ ok: false, error: publicError }); }
    }
    if (failed.length) {
      const errors = failed.map((role) => `${role}: ${(activated[roles.indexOf(role)] || activated.at(-1)).error}`).join("\n");
      log(`activation failed; rolling every role back:\n${errors}`);
      const back = await Promise.all(roles.map(async (role, index) => {
        if (!activated[index].ok && activated[index].rolled_back !== false) return { role, ok: true };
        if (!previous[role] || previous[role] === sha) return { role, ok: true };
        return { role, ...(await hosts.rollback(role, { lane: "platform", sha: previous[role] })) };
      }));
      const notBack = back.filter((item) => !item.ok);
      return { ok: false, error: errors + (notBack.length ? `\nROLLBACK FAILED on ${notBack.map((item) => `${item.role}: ${item.error}`).join("; ")}` : ""), rolledBack: notBack.length === 0 };
    }
    Promise.all(roles.map((role) => hosts.prune(role, { lane: "platform" }))).then((results) => log(`pruned old releases: ${results.map((result, index) => `${roles[index]} ${result.removed ?? result.error}`).join(", ")}`)).catch(() => {});
    return { ok: true, roles: Object.fromEntries(roles.map((role, index) => [role, { previous: previous[role], tree_sha256: staged[index].tree_sha256, reused: Boolean(activated[index].reused) }])) };
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
async function waitPublic(sha, seconds = 180) {
  let good = 0, last = "";
  for (let i = 0; i < seconds / 3; i++) {
    try {
      const response = await fetch(`${PUBLIC_URL}/v1/health/ready`, { signal: AbortSignal.timeout(8000), headers: { "cache-control": "no-cache" } });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.ok && data.release_id === sha) { if (++good >= 2) return null; }
      else { good = 0; last = `${response.status} release ${data.release_id || "?"}`; }
    } catch (error) { good = 0; last = error.message; }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return `${PUBLIC_URL}/v1/health/ready did not report ${sha.slice(0, 10)}: ${last}`;
}
