// Shared by submit.mjs and the router (docs/architecture/dev-lanes.md): lanes, queue ref names, manifests.
import fs from "node:fs";
import os from "node:os";
import { execFile } from "node:child_process";

export const GITHUB_URL = "https://github.com/jackholt647/firstmeasure.git"; // backup mirror, pushed from PCs (mirror.mjs)
/** The router's repository on the dev sync droplet: the source of truth for canonical, the lane branches and the queue. */
export const ROUTER_REPO_PATH = "/home/dev/router/firstmeasure.git";
export const ROUTER_REPO_SSH = `dev-sync-droplet:${ROUTER_REPO_PATH}`;
export const ROUTER_REMOTE = "devpush"; // the remote name submit.mjs keeps in every checkout
/** Where a checkout reaches the router's repository: DEV_PUSH_URL, the path on the droplet itself, else SSH. */
export const routerUrl = () => process.env.DEV_PUSH_URL || (fs.existsSync(ROUTER_REPO_PATH) ? ROUTER_REPO_PATH : ROUTER_REPO_SSH);
export const STATUS_URL = "https://dev.1m8.ai/__dev-push/status.json";
export const STATUS_SSH = "dev-sync-droplet";
export const STATUS_FILE = "dev-push/state/status.json"; // under the router account's home on the droplet
export const MANIFEST_SUBJECT = "dev-push: ";

const laneBuilt = (name) => (process.env.DEV_PUSH_LANES ? process.env.DEV_PUSH_LANES.split(",").includes(name) : fs.existsSync(new URL(`../lanes/${name}/lane.mjs`, import.meta.url)));

/** Code lanes the router serves. `owns` decides which lane a changed path belongs to; platform owns the rest. */
export const LANES = {
  platform: { branch: "codex/consolidated-firstmeasure-20260923", owns: () => true },
  // A lane owns its paths once its module is in the checkout; until then platform carries them.
  "measure-internal": { branch: "lane/measure-internal", owns: (file) => (file.startsWith("public/measure/internal/") || file.startsWith("dev/")) && laneBuilt("measure-internal") }
};

/** The most specific lane that owns a path (anything not claimed by another lane is platform). */
export function laneOf(file) {
  for (const [name, lane] of Object.entries(LANES)) if (name !== "platform" && lane.owns(file)) return name;
  return "platform";
}

export const slugify = (text, max = 48) => String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "");

/** Who is submitting: the Claude or Codex session, else user@host. Stable per session so a resubmission replaces its entry. */
export function agentId(env = process.env) {
  if (env.DEV_PUSH_AGENT) return slugify(env.DEV_PUSH_AGENT, 32);
  const claude = env.CLAUDE_CODE_HOST_SESSION_ID || env.CLAUDE_CODE_SESSION_ID;
  if (claude) return `claude-${claude.replace(/^local_/, "").slice(0, 8)}`;
  const codex = env.CODEX_THREAD_ID || env.CODEX_SESSION_ID;
  if (codex) return `codex-${codex.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase()}`;
  return slugify(`${os.userInfo().username}-${os.hostname()}`, 32) || "agent";
}

export const queueRef = (lane, agent, slug) => `refs/heads/queue/${lane}/${agent}-${slug}`;

/** `queue/<lane>/<name>` (as listed under refs/heads) -> { lane, name }. */
export function parseQueueRef(ref) {
  const match = /^(?:refs\/heads\/|refs\/remotes\/origin\/)?queue\/([^/]+)\/(.+)$/.exec(ref);
  return match ? { lane: match[1], name: match[2], ref: `queue/${match[1]}/${match[2]}` } : null;
}

export function formatManifest(manifest) {
  return `${MANIFEST_SUBJECT}${manifest.title}\n\n${JSON.stringify(manifest, null, 1)}\n`;
}

/** The manifest from a submission commit's message, or null when the commit is not a submission. */
export function parseManifest(message) {
  if (!String(message).startsWith(MANIFEST_SUBJECT)) return null;
  const start = message.indexOf("{");
  if (start < 0) return null;
  try { return JSON.parse(message.slice(start)); } catch { return null; }
}

export function run(file, args, { cwd, env, input, encoding = "utf8", maxBuffer = 256 * 1024 * 1024, timeout = 0 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(file, args, { cwd, env: env ? { ...process.env, ...env } : process.env, encoding, maxBuffer, timeout, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr: String(stderr || (error && !stderr ? error.message : "")) });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

export async function git(cwd, args, options = {}) {
  const result = await run("git", args, { cwd, ...options });
  if (result.code !== 0 && !options.allowFail) throw new Error(`git ${args.join(" ")}: ${result.stderr.trim() || `exit ${result.code}`}`);
  return options.allowFail ? result : result.stdout;
}

export function parseArgs(argv) {
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

export const TERMINAL = new Set(["live", "rejected", "superseded", "withdrawn", "passed", "failed"]);
