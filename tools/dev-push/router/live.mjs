// Live layer bake-down (docs/architecture/dev-lanes.md, docs/architecture/live-layer.md). Before every platform batch
// the router reads the live receiver on dev web, turns each owner's overlays into commits on refs/heads/live/<owner>
// (parented on the release the edits were made against), and the batch merges them like submissions. After the
// release the receiver is told which overlays it now has, so they retire as `released` instead of being dropped.
// A real conflict goes to a reviewing model; if that fails the overlay stays parked and is reported, never lost.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run, slugify } from "../lib/common.mjs";

const RECEIVER = process.env.DEV_PUSH_LIVE_TARGET || "fmlive@143.198.68.11";
const CLAUDE = process.env.DEV_PUSH_REVIEWER || path.join(os.homedir(), ".local", "bin", "claude");
const IDENTITY = { GIT_AUTHOR_NAME: "dev-push live layer", GIT_AUTHOR_EMAIL: "dev-push@1m8.ai", GIT_COMMITTER_NAME: "dev-push live layer", GIT_COMMITTER_EMAIL: "dev-push@1m8.ai" };

/** One SSH session to the receiver per call: sends the ops as JSON lines, returns the answers in order. */
export function receiverClient({ key = path.join(os.homedir(), ".ssh", "dev_push_router_ed25519"), knownHosts, target = RECEIVER, command } = {}) {
  return async function request(ops) {
    const lines = ops.map((op, index) => JSON.stringify({ ...op, id: index + 1 })).join("\n") + "\n";
    // `target` may be a function: the receiver lives on whichever node is the primary web node.
    const argv = command || ["ssh", "-T", "-i", key, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=accept-new", ...(knownHosts ? ["-o", `UserKnownHostsFile=${knownHosts}`] : []), "-o", "ConnectTimeout=15", typeof target === "function" ? target() : target, "serve"];
    const result = await run(argv[0], argv.slice(1), { input: lines, timeout: 120_000 });
    const answers = new Map();
    for (const line of String(result.stdout).split("\n")) { try { const message = JSON.parse(line); answers.set(message.id, message); } catch {} }
    if (!answers.size) throw new Error(`live receiver: ${result.stderr.trim() || `exit ${result.code}`}`);
    return ops.map((_, index) => answers.get(index + 1) || { ok: false, error: "no answer" });
  };
}

export function liveOverlays({ home, log = () => {}, target = RECEIVER, request = receiverClient({ knownHosts: path.join(home, "known_hosts"), target }), reviewer = CLAUDE } = {}) {
  const pushed = new Map(); // ref -> sha last pushed
  let lastExport = null;

  async function commitFile(git, parent, file, bytes, message, date) {
    const env = { ...IDENTITY, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
    const index = path.join(home, "state", `live-index-${process.pid}`);
    try {
      await git(["read-tree", parent], { env: { GIT_INDEX_FILE: index } });
      const blob = (await git(["hash-object", "-w", "--stdin"], { input: bytes, encoding: "utf8" })).trim();
      const listed = (await git(["ls-tree", parent, "--", file])).trim();
      const mode = listed ? listed.split(" ")[0] : "100644";
      await git(["update-index", "--add", "--cacheinfo", `${mode},${blob},${file}`], { env: { GIT_INDEX_FILE: index } });
      const tree = (await git(["write-tree"], { env: { GIT_INDEX_FILE: index } })).trim();
      return (await git(["commit-tree", tree, "-p", parent, "-m", message], { env })).trim();
    } finally { fs.rmSync(index, { force: true }); }
  }

  async function exists(git, sha) { return Boolean(sha) && (await git(["cat-file", "-e", `${sha}^{commit}`], { allowFail: true })).code === 0; }

  return {
    /** live/<owner> commits to merge into the next platform batch: [{ ref, sha, owner, parked, files }]. */
    async overlays(tip, router) {
      const git = (args, options = {}) => router.git(args, options);
      const [exported] = await request([{ op: "export" }]);
      if (!exported.ok) throw new Error(`live export: ${exported.error}`);
      lastExport = exported;
      const entries = [
        ...Object.entries(exported.files || {}).map(([file, entry]) => ({ file, ...entry, parked: false })),
        ...Object.entries(exported.parked || {}).map(([file, entry]) => ({ file, ...entry, parked: true }))
      ];
      if (!entries.length) return [];
      const owners = new Map();
      for (const entry of entries) (owners.get(entry.source || "unknown") || owners.set(entry.source || "unknown", []).get(entry.source || "unknown")).push(entry);
      const result = [];
      for (const [owner, list] of owners) {
        list.sort((a, b) => String(a.at).localeCompare(String(b.at)));
        let head = null;
        const files = {};
        for (const entry of list) {
          // A live entry's base is the running release's copy (the receiver guarantees it), so it sits on that release;
          // a parked one sits on the release it was edited against.
          const candidates = entry.parked ? [entry.release, entry.commit] : [exported.release, entry.release];
          let base = null;
          for (const candidate of candidates) if (await exists(git, candidate)) { base = candidate; break; }
          base ||= tip;
          if (!head) head = base;
          else if ((await git(["merge-base", "--is-ancestor", base, head], { allowFail: true })).code !== 0) {
            const merged = await git(["merge-tree", "--write-tree", head, base], { allowFail: true });
            if (merged.code === 0) head = (await git(["commit-tree", merged.stdout.split("\n")[0].trim(), "-p", head, "-p", base, "-m", `live: follow release ${base.slice(0, 10)}`], { env: { ...IDENTITY, GIT_AUTHOR_DATE: entry.at, GIT_COMMITTER_DATE: entry.at } })).trim();
          }
          const [blob] = await request([{ op: "blob", sha: entry.sha }]);
          if (!blob.ok) { log(`no bytes for ${entry.file} ${entry.sha} (${blob.error}); skipped`); continue; }
          head = await commitFile(git, head, `public/${entry.file}`, Buffer.from(blob.data, "base64"), `live: public/${entry.file}\n\nSaved by ${owner} on dev at ${entry.at}${entry.parked ? " (parked: the release changed this file under the edit)" : ""}.`, entry.at);
          files[entry.file] = entry.sha;
        }
        if (!head || !Object.keys(files).length) continue;
        const ref = `live/${slugify(owner, 64) || "unknown"}`;
        if (pushed.get(ref) !== head) {
          const push = await git(["push", "--quiet", "--force", "origin", `${head}:refs/heads/${ref}`], { allowFail: true });
          if (push.code === 0) { pushed.set(ref, head); log(`${ref} -> ${head.slice(0, 10)} (${Object.keys(files).length} file(s))`); }
          else log(`push ${ref} failed (kept locally): ${push.stderr.trim().slice(0, 300)}`);
          await git(["update-ref", `refs/live/${ref.slice(5)}`, head]);
        }
        result.push({ ref, sha: head, owner, parked: list.some((entry) => entry.parked), files });
      }
      return result;
    },

    /** Tells the receiver which overlay bytes the release now carries. */
    async afterRelease({ release, overlays }) {
      if (!overlays.length) return;
      const files = Object.assign({}, ...overlays.map((overlay) => overlay.files));
      const [answer] = await request([{ op: "merged", release: release.sha, files }]);
      log(`release ${release.id} carries ${Object.keys(files).length} live file(s): ${answer.ok ? "receiver updated" : answer.error}`);
    },

    async overlayProblems(problems) {
      const file = path.join(home, "state", "live-problems.json");
      const record = problems.map(({ overlay, files, gate }) => ({ ref: overlay.ref, owner: overlay.owner, sha: overlay.sha, files, gate: gate?.map((item) => item.id), at: new Date().toISOString() }));
      fs.writeFileSync(file, JSON.stringify(record, null, 1));
      log(`${problems.length} overlay(s) could not be merged; still parked or live, listed in ${file}`);
    },

    /** A reviewing model resolves a conflicted overlay merge in `dir`; true when it left a clean, committed merge. */
    async resolveConflict({ dir, overlay, log: say }) {
      if (!fs.existsSync(reviewer)) return false;
      const conflicted = (await run("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: dir })).stdout.split("\n").filter(Boolean);
      if (!conflicted.length || conflicted.length > 6) return false;
      say(`reviewing conflict of ${overlay.ref} in ${conflicted.join(", ")}`);
      const prompt = [
        `You are resolving a git merge conflict in ${dir}. The branch being merged (${overlay.ref}) holds browser-file edits someone made live on dev (the "theirs" side);`,
        "the other side is the reviewed code about to be released. Resolve the conflict markers in these files so that BOTH intents survive:",
        conflicted.map((file) => `- ${file}`).join("\n"),
        "Edit only those files, only inside the conflicted regions. Do not run git commands that change history. When unsure, prefer the released side and keep the live edit's behaviour where it does not contradict it.",
        "Finish when no <<<<<<< ======= >>>>>>> markers remain."
      ].join("\n");
      const result = await run(reviewer, ["-p", prompt, "--permission-mode", "acceptEdits", "--allowedTools", "Read,Edit,Grep"], { cwd: dir, timeout: 10 * 60_000 });
      if (result.code !== 0) { say(`reviewer failed: ${result.stderr.trim().slice(0, 300)}`); return false; }
      for (const file of conflicted) {
        const text = fs.readFileSync(path.join(dir, file), "utf8");
        if (/^(<{7}|={7}|>{7})( |$)/m.test(text)) { say(`reviewer left markers in ${file}`); return false; }
        const check = file.endsWith(".js") || file.endsWith(".mjs") ? await run("node", ["--check", file], { cwd: dir }) : { code: 0 };
        if (check.code !== 0) { say(`reviewed ${file} does not parse`); return false; }
      }
      await run("git", ["add", "--", ...conflicted], { cwd: dir });
      const commit = await run("git", ["commit", "--no-edit", "-m", `Merge ${overlay.ref} (live layer, conflict resolved by reviewer)`], { cwd: dir, env: IDENTITY });
      return commit.code === 0;
    },

    lastExport: () => lastExport
  };
}
