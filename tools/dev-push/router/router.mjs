// The dev push router (docs/architecture/dev-lanes.md). One process on the dev sync droplet; every lane runs its own
// loop: take queued submissions in order, merge them onto the lane tip, run the lane's gates (bisecting a failed
// batch), build and activate one release on every role of the lane, fast-forward the lane branch, record the release
// outside canonical and retire the queue refs. Conflicts and gate failures go back to the submitter in the status
// document. Nothing here knows about hosts: a lane module (lanes/<lane>/lane.mjs) owns gates and deploy.
import fs from "node:fs";
import path from "node:path";
import { git, laneOf, parseManifest, parseQueueRef, TERMINAL } from "../lib/common.mjs";

const IDENTITY = { GIT_AUTHOR_NAME: "dev-push router", GIT_AUTHOR_EMAIL: "dev-push@1m8.ai", GIT_COMMITTER_NAME: "dev-push router", GIT_COMMITTER_EMAIL: "dev-push@1m8.ai" };
const KEEP_SUBMISSIONS = 200;
const KEEP_RELEASES = 50;
const trim = (text, max = 6000) => { const value = String(text || "").trim(); return value.length > max ? `${value.slice(0, max / 2)}\n...\n${value.slice(-max / 2)}` : value; };
const stamp = (date = new Date()) => date.toISOString().replace(/[-:T]/g, "").slice(0, 14);

export class Router {
  /**
   * @param {object} options
   * @param {string} options.repo     bare clone the router works in (created if missing)
   * @param {string} options.remote   origin URL or path (pushes go here)
   * @param {string} options.stateDir status.json, submissions.json, releases/, router.log
   * @param {object} options.lanes    { name: laneModule }
   * @param {Function} [options.ssh]  passed to lane modules
   * @param {Function} [options.publish] (statusDoc) => Promise, e.g. copy to dev web
   * @param {Function} [options.overlays] platform only: () => Promise<[{ ref, sha, owner }]> live/<owner> commits to merge
   * @param {Function} [options.afterRelease] ({ lane, release, overlays }) => Promise, e.g. tell the live layer what was merged
   */
  constructor(options) {
    this.options = options;
    this.repo = options.repo;
    this.remote = options.remote;
    this.stateDir = options.stateDir;
    this.lanes = options.lanes;
    this.ssh = options.ssh;
    this.paused = new Set();
    this.laneState = {};
    this.stopped = false;
    fs.mkdirSync(path.join(this.stateDir, "releases"), { recursive: true });
    this.submissions = this.readJson("submissions.json", {});
    this.releases = this.readJson("releases.json", []);
    this.gateCache = new Map(); // `${sha}\0${gate}` -> passed?
    this.failedOverlays = new Set(); // `${ref}@${sha}@${tip}`: overlays that could not be merged onto that tip
    for (const name of Object.keys(this.lanes)) this.laneState[name] = { state: "idle", batch: [], release: null, tip: null, note: null };
  }

  readJson(name, fallback) { try { return JSON.parse(fs.readFileSync(path.join(this.stateDir, name), "utf8")); } catch { return fallback; } }
  writeJson(name, value) {
    const file = path.join(this.stateDir, name);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 1));
    fs.renameSync(`${file}.tmp`, file);
  }

  log(lane, line) {
    const text = `${new Date().toISOString()} [${lane}] ${line}`;
    fs.appendFileSync(path.join(this.stateDir, "router.log"), `${text}\n`);
    if (!this.options.quiet) console.log(text);
  }

  git(args, options = {}) { return git(options.cwd || this.repo, args, { ...options, env: { ...IDENTITY, ...options.env } }); }

  async init() {
    if (!fs.existsSync(path.join(this.repo, "HEAD"))) {
      fs.mkdirSync(this.repo, { recursive: true });
      await git(this.repo, ["init", "--bare", "--quiet"]);
      await git(this.repo, ["remote", "add", "origin", this.remote]);
    }
    await this.git(["config", "core.autocrlf", "false"]);
    await this.git(["config", "gc.auto", "0"]);
    await this.git(["config", "merge.renames", "true"]);
    await this.git(["config", "merge.conflictStyle", "diff3"]);
  }

  // ---------------------------------------------------------------- status

  statusDoc() {
    const lanes = {};
    for (const [name, lane] of Object.entries(this.lanes)) {
      const state = this.laneState[name];
      lanes[name] = { branch: lane.branch, tip: state.tip, state: this.paused.has(name) ? "paused" : state.state, batch: state.batch, release: state.release, note: state.note };
    }
    const submissions = Object.values(this.submissions).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, KEEP_SUBMISSIONS);
    return {
      v: 1, updated_at: new Date().toISOString(),
      router: { host: this.options.host || "dev-sync-droplet", version: this.options.version || null, started_at: this.startedAt || null, paused: this.paused.size === Object.keys(this.lanes).length },
      lanes, submissions, releases: this.releases.slice(0, KEEP_RELEASES)
    };
  }

  async saveStatus() {
    const all = Object.values(this.submissions).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    this.submissions = Object.fromEntries(all.slice(0, 1000).map((entry) => [entry.submission, entry]));
    this.writeJson("submissions.json", this.submissions);
    this.writeJson("releases.json", this.releases.slice(0, 500));
    const doc = this.statusDoc();
    this.writeJson("status.json", doc);
    if (this.options.publish) {
      clearTimeout(this.publishTimer);
      this.publishTimer = setTimeout(() => this.options.publish(this.statusDoc()).catch((error) => this.log("router", `status publish failed: ${error.message}`)), 500);
    }
  }

  setLane(lane, patch) { Object.assign(this.laneState[lane], patch); return this.saveStatus(); }

  update(entries, patch) {
    const now = new Date().toISOString();
    for (const entry of [].concat(entries)) Object.assign(this.submissions[entry.submission], patch, { updated_at: now });
    return this.saveStatus();
  }

  // ---------------------------------------------------------------- queue

  async fetch(lane) {
    const branch = this.lanes[lane].branch;
    const specs = [`+refs/heads/queue/${lane}/*:refs/queue/${lane}/*`];
    const tip = await this.git(["ls-remote", "origin", `refs/heads/${branch}`]);
    if (tip.trim()) specs.push(`+refs/heads/${branch}:refs/lanes/${lane}`);
    else if (lane !== "platform") specs.push(`+refs/heads/${this.lanes.platform?.branch}:refs/lanes/${lane}`); // a new lane starts from canonical
    await this.git(["fetch", "--quiet", "--prune", "--no-tags", "origin", ...specs]);
    return (await this.git(["rev-parse", `refs/lanes/${lane}`])).trim();
  }

  /** Queued submissions of a lane in submission order, registering new ones. */
  async pending(lane) {
    const out = await this.git(["for-each-ref", "--format=%(refname)%00%(objectname)%00%(committerdate:iso-strict)", `refs/queue/${lane}/`]);
    const found = [];
    for (const line of out.split("\n").filter(Boolean)) {
      const [refname, sha, date] = line.split("\0");
      const parsed = parseQueueRef(refname.replace(/^refs\/queue\//, "queue/"));
      if (!parsed) continue;
      let entry = this.submissions[sha];
      if (!entry) {
        const message = await this.git(["log", "-1", "--format=%B", sha]);
        const parents = (await this.git(["log", "-1", "--format=%P", sha])).trim().split(" ").filter(Boolean);
        const manifest = parseManifest(message) || {};
        entry = this.submissions[sha] = {
          ref: parsed.ref, lane, agent: manifest.agent || parsed.name, title: manifest.title || parsed.name, tests: manifest.tests || [],
          session: manifest.session || null, submission: sha, work: parents.length === 1 && manifest.v ? parents[0] : sha,
          submitted_at: manifest.submitted_at || date, updated_at: new Date().toISOString(), state: "queued"
        };
        // A newer submission on the same ref supersedes a queued older one.
        for (const other of Object.values(this.submissions)) if (other !== entry && other.ref === entry.ref && other.state === "queued") Object.assign(other, { state: "superseded", updated_at: entry.updated_at });
        this.log(lane, `queued ${parsed.ref} ${sha.slice(0, 10)} "${entry.title}"`);
        await this.saveStatus();
      }
      if (TERMINAL.has(entry.state)) { await this.retire(entry); continue; } // a ref left behind by a failed retire
      found.push(entry);
    }
    return found.sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)));
  }

  /** Deletes the queue ref on origin unless it was resubmitted meanwhile. */
  async retire(entry) {
    const ref = `refs/heads/${entry.ref}`;
    const result = await this.git(["push", "--quiet", `--force-with-lease=${ref}:${entry.submission}`, "origin", `:${ref}`], { allowFail: true });
    if (result.code === 0 || /remote ref does not exist|unable to delete/.test(result.stderr)) await this.git(["update-ref", "-d", `refs/queue/${entry.ref.slice("queue/".length)}`], { allowFail: true });
    else if (!/stale info|rejected/.test(result.stderr)) this.log(entry.lane, `retire ${entry.ref} failed: ${result.stderr.trim()}`);
  }

  async reject(entry, reason, details) {
    this.log(entry.lane, `rejected ${entry.ref} (${reason})`);
    await this.update(entry, { state: "rejected", reason, details: trim(details) });
    await this.retire(entry);
  }

  // ---------------------------------------------------------------- merging

  async worktree(lane) {
    const dir = path.join(this.stateDir, "work", lane);
    if (!fs.existsSync(path.join(dir, ".git"))) {
      await this.git(["worktree", "prune"]);
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      await this.git(["worktree", "add", "--detach", "--force", dir, `refs/lanes/${lane}`]);
    }
    return dir;
  }

  /** Files the work changes relative to where it left the lane. */
  async changedBy(sha, tip) {
    const base = (await this.git(["merge-base", tip, sha], { allowFail: true })).stdout?.trim();
    if (!base) return null;
    return (await this.git(["-c", "core.quotepath=off", "diff", "--name-only", "--no-renames", "-z", base, sha])).split("\0").filter(Boolean);
  }

  /**
   * Merges entries (and overlay commits) onto `tip` in `dir`. Returns { sha, merged, conflicts: [{ entry, files }] }.
   * Overlays that conflict are returned separately; they never block a submission.
   */
  async mergeOnto(dir, tip, entries, overlays = []) {
    await this.git(["reset", "--quiet", "--hard", tip], { cwd: dir });
    await this.git(["clean", "-fdq", "-e", "node_modules", "-e", "**/node_modules"], { cwd: dir });
    const merged = [], conflicts = [], overlayConflicts = [], overlaysMerged = [];
    for (const entry of entries) {
      const result = await this.git(["merge", "--no-ff", "--no-edit", "-m", `Merge ${entry.ref}: ${entry.title}`, entry.work], { cwd: dir, allowFail: true });
      if (result.code === 0) { merged.push(entry); continue; }
      const files = (await this.git(["diff", "--name-only", "--diff-filter=U"], { cwd: dir, allowFail: true })).stdout?.split("\n").filter(Boolean) || [];
      await this.git(["merge", "--abort"], { cwd: dir, allowFail: true });
      conflicts.push({ entry, files, output: result.stdout + result.stderr });
    }
    for (const overlay of overlays) {
      const result = await this.git(["merge", "--no-ff", "--no-edit", "-m", `Merge ${overlay.ref} (live layer)`, overlay.sha], { cwd: dir, allowFail: true });
      if (result.code === 0) { overlaysMerged.push(overlay); continue; }
      const resolved = this.options.resolveConflict ? await this.options.resolveConflict({ dir, overlay, log: (line) => this.log("platform", line) }).catch((error) => { this.log("platform", `conflict review failed: ${error.message}`); return false; }) : false;
      if (resolved) { overlaysMerged.push({ ...overlay, reviewed: true }); continue; }
      const files = (await this.git(["diff", "--name-only", "--diff-filter=U"], { cwd: dir, allowFail: true })).stdout?.split("\n").filter(Boolean) || [];
      await this.git(["merge", "--abort"], { cwd: dir, allowFail: true });
      overlayConflicts.push({ overlay, files });
    }
    const sha = (await this.git(["rev-parse", "HEAD"], { cwd: dir })).trim();
    return { sha, merged, conflicts, overlaysMerged, overlayConflicts };
  }

  // ---------------------------------------------------------------- gates

  async runGates(lane, dir, sha, tip, entries, only) {
    const changed = [...new Set((await Promise.all(entries.map((entry) => this.changedBy(entry.work, tip)))).flat().filter(Boolean))];
    const tests = [...new Set(entries.flatMap((entry) => entry.tests || []))];
    const result = await this.lanes[lane].gates({ dir, sha, baseSha: tip, changed, tests, only, log: (line) => this.log(lane, line) });
    return { ok: Boolean(result.ok), failures: result.failures || (result.ok ? [] : [{ id: result.gate || "gate", output: result.output || "" }]), changed, tests };
  }

  /** Failures that the lane tip itself also has are not the submission's fault. */
  async preexisting(lane, dir, tip, entries, failures) {
    const ids = failures.map((failure) => failure.id);
    const key = `${tip}\0${ids.join(",")}`;
    if (!this.gateCache.has(key)) {
      await this.git(["reset", "--quiet", "--hard", tip], { cwd: dir });
      const result = await this.runGates(lane, dir, tip, tip, entries, ids);
      this.gateCache.set(key, new Set(result.failures.map((failure) => failure.id)));
    }
    const onTip = this.gateCache.get(key);
    return failures.filter((failure) => !onTip.has(failure.id));
  }

  /** Largest passing prefix-preserving subset of `entries`; rejects the ones that fail on their own. */
  async bisect(lane, dir, tip, entries, accepted = [], knownBad = false) {
    if (!entries.length) return [];
    const all = [...accepted, ...entries];
    if (!knownBad) {
      const { sha, conflicts } = await this.mergeOnto(dir, tip, all);
      if (!conflicts.length) {
        const gate = await this.runGates(lane, dir, sha, tip, all);
        if (gate.ok) return entries;
        if (entries.length === 1) {
          const own = await this.preexisting(lane, dir, tip, all, gate.failures);
          if (!own.length) return entries;
          await this.reject(entries[0], "gate-failed", own.map((failure) => `## ${failure.id}\n${trim(failure.output, 4000)}`).join("\n\n"));
          return [];
        }
      }
    }
    if (entries.length === 1) return this.bisect(lane, dir, tip, entries, accepted, false);
    const middle = Math.ceil(entries.length / 2);
    const left = await this.bisect(lane, dir, tip, entries.slice(0, middle), accepted);
    const right = await this.bisect(lane, dir, tip, entries.slice(middle), [...accepted, ...left]);
    return [...left, ...right];
  }

  // ---------------------------------------------------------------- one batch

  async processLane(lane) {
    const module = this.lanes[lane];
    // A release that went live but whose lane push failed must reach the branch before anything else is merged,
    // or the next release would be built without it.
    const unpushed = this.readJson("unpushed.json", {})[lane];
    if (unpushed) {
      const push = await this.git(["push", "--quiet", "origin", `${unpushed}:refs/heads/${module.branch}`], { allowFail: true });
      if (push.code !== 0) {
        await this.setLane(lane, { state: "paused", note: `release ${unpushed.slice(0, 10)} is live but ${module.branch} could not be advanced: ${trim(push.stderr, 300)}` });
        return false;
      }
      const record = this.readJson("unpushed.json", {}); delete record[lane]; this.writeJson("unpushed.json", record);
      this.log(lane, `${module.branch} advanced to ${unpushed.slice(0, 10)} (retried push)`);
    }
    const tip = await this.fetch(lane);
    await this.setLane(lane, { tip });
    const queue = await this.pending(lane);
    // Live overlays ride along with every platform batch; on their own they trigger a release only once parked
    // (a release changed their file, so dev no longer serves them). One that failed on this tip waits for a new tip.
    let overlays = [];
    if (lane === "platform" && this.options.overlays) {
      try { overlays = (await this.options.overlays(tip, this)).filter((overlay) => !this.failedOverlays.has(`${overlay.ref}@${overlay.sha}@${tip}`)); }
      catch (error) { this.log(lane, `live overlays unavailable: ${error.message}`); }
    }
    if (!queue.length && !overlays.some((overlay) => overlay.parked)) return false;
    const batch = queue.slice(0, module.batchMax || 8);
    const dir = await this.worktree(lane);

    // Lane ownership and nothing-to-do checks before anything is merged.
    const candidates = [];
    for (const entry of batch) {
      const files = await this.changedBy(entry.work, tip);
      if (!files) { await this.reject(entry, "unrelated-history", `${entry.work} shares no history with ${module.branch}.`); continue; }
      const added = (await this.git(["-c", "core.quotepath=off", "diff", "--name-only", "--diff-filter=A", "--no-renames", (await this.git(["merge-base", tip, entry.work])).trim(), entry.work])).split("\n").filter(Boolean);
      const records = added.filter((file) => /^deploy\/digitalocean\/development-[^/]+\.md$/.test(file));
      if (records.length) { await this.reject(entry, "policy", `Dev rollout records are no longer committed (the router records releases):\n${records.join("\n")}\nDrop them from your branch and submit again.`); continue; }
      const outside = files.filter((file) => laneOf(file) !== lane);
      if (outside.length) { await this.reject(entry, "out-of-lane", `Lane ${lane} does not own:\n${outside.join("\n")}\nSubmit those files on their own lane.`); continue; }
      if ((await this.git(["merge-base", "--is-ancestor", entry.work, tip], { allowFail: true })).code === 0) {
        await this.update(entry, { state: "live", release: this.laneState[lane].release?.id || null, details: `Already in ${module.branch}.` });
        await this.retire(entry);
        continue;
      }
      candidates.push(entry);
    }
    if (!candidates.length && !overlays.some((overlay) => overlay.parked)) return true;

    await this.setLane(lane, { state: "merging", batch: candidates.map((entry) => entry.ref) });
    await this.update(candidates, { state: "merging" });
    let { conflicts } = await this.mergeOnto(dir, tip, candidates);
    for (const { entry, files } of conflicts) {
      await this.reject(entry, "conflict", `Conflicts with ${module.branch} ${tip.slice(0, 10)} (or with work merged ahead of it in this batch) in:\n${files.join("\n")}\n\nRebase onto the lane tip and submit again:\n  git fetch origin && git rebase origin/${module.branch}\n  node tools/dev-push/submit.mjs --lane ${lane}`);
    }
    let accepted = candidates.filter((entry) => !conflicts.some((conflict) => conflict.entry === entry));

    if (accepted.length) {
      await this.setLane(lane, { state: "testing" });
      await this.update(accepted, { state: "testing" });
      const { sha } = await this.mergeOnto(dir, tip, accepted);
      const gate = await this.runGates(lane, dir, sha, tip, accepted);
      if (!gate.ok) {
        this.log(lane, `batch of ${accepted.length} failed ${gate.failures.map((failure) => failure.id).join(", ")}; bisecting`);
        accepted = await this.bisect(lane, dir, tip, accepted, [], accepted.length > 1);
      }
    }

    // Final tree: accepted work plus live overlays (platform), merged once more so the release is exactly what was gated.
    const final = await this.mergeOnto(dir, tip, accepted, overlays);
    if (final.overlaysMerged.length) {
      const gate = await this.runGates(lane, dir, final.sha, tip, accepted);
      if (!gate.ok) {
        const own = await this.preexisting(lane, dir, tip, accepted, gate.failures);
        if (own.length) {
          this.log(lane, `live overlays fail the gates (${own.map((failure) => failure.id).join(", ")}); releasing without them`);
          final.overlayConflicts.push(...final.overlaysMerged.map((overlay) => ({ overlay, files: [], gate: own })));
          Object.assign(final, await this.mergeOnto(dir, tip, accepted), { overlaysMerged: [] });
        }
      }
    }
    for (const { overlay } of final.overlayConflicts) this.failedOverlays.add(`${overlay.ref}@${overlay.sha}@${tip}`);
    if (!accepted.length && !final.overlaysMerged.length) {
      await this.setLane(lane, { state: "idle", batch: [], note: final.overlayConflicts.length ? `${final.overlayConflicts.length} live overlay(s) need review` : null });
      if (this.options.overlayProblems && final.overlayConflicts.length) await this.options.overlayProblems(final.overlayConflicts);
      return candidates.length > 0;
    }

    // The lane branch must not have moved since the merge, or the release would not be a fast-forward of it.
    const now = await this.fetch(lane);
    if (now !== tip) {
      this.log(lane, `${module.branch} moved ${tip.slice(0, 10)} -> ${now.slice(0, 10)} during the batch; starting over`);
      await this.update(accepted, { state: "queued" });
      await this.setLane(lane, { state: "idle", batch: [] });
      return true;
    }

    const releaseId = `${lane}-${stamp()}-${final.sha.slice(0, 8)}`;
    await this.setLane(lane, { state: "rolling-out" });
    await this.update(accepted, { state: "rolling-out", release: releaseId });
    this.log(lane, `deploying ${releaseId} (${accepted.length} submission(s), ${final.overlaysMerged.length} overlay(s))`);
    let deployed;
    try {
      deployed = await module.deploy({ dir, sha: final.sha, releaseId, previous: this.laneState[lane].release, hosts: this.options.hosts, ssh: this.ssh, log: (line) => this.log(lane, line) });
    } catch (error) { deployed = { ok: false, error: error.stack || error.message, rolledBack: false }; }
    if (!deployed.ok) {
      this.log(lane, `deploy ${releaseId} failed: ${deployed.error}`);
      if (accepted.length === 1 && deployed.rolledBack) {
        await this.reject(accepted[0], "deploy-failed", `The release built from your merge did not come up on dev and was rolled back:\n${deployed.error}`);
      } else {
        // Infrastructure or a batch: stop the lane for a person to look; nothing is lost, the queue stays.
        await this.update(accepted, { state: "queued", release: null });
        this.paused.add(lane);
        this.writeJson("paused.json", [...this.paused]);
        await this.setLane(lane, { state: "paused", batch: [], note: `deploy ${releaseId} failed${deployed.rolledBack ? " (rolled back)" : " (NOT rolled back)"}: ${trim(deployed.error, 400)}` });
      }
      return true;
    }

    const push = await this.git(["push", "--quiet", "origin", `${final.sha}:refs/heads/${module.branch}`], { allowFail: true });
    if (push.code !== 0) {
      // Dev now runs work the branch lacks: hold the lane until the push succeeds (retried at the top of every pass).
      this.log(lane, `WARNING: ${releaseId} is live but ${module.branch} could not be fast-forwarded: ${push.stderr.trim()}`);
      this.writeJson("unpushed.json", { ...this.readJson("unpushed.json", {}), [lane]: final.sha });
    } else await this.git(["update-ref", `refs/lanes/${lane}`, final.sha]);
    const release = {
      id: releaseId, lane, sha: final.sha, at: new Date().toISOString(), base: tip, branch_pushed: push.code === 0,
      submissions: accepted.map((entry) => entry.ref), works: accepted.map((entry) => entry.work),
      overlays: final.overlaysMerged.map((overlay) => overlay.ref), roles: deployed.roles || {}
    };
    this.releases.unshift(release);
    fs.writeFileSync(path.join(this.stateDir, "releases", `${releaseId}.json`), JSON.stringify(release, null, 1));
    await this.update(accepted, { state: "live", release: releaseId, details: null });
    await this.setLane(lane, { state: "idle", batch: [], tip: push.code === 0 ? final.sha : tip, release: { id: releaseId, sha: final.sha, at: release.at }, note: final.overlayConflicts.length ? `${final.overlayConflicts.length} live overlay(s) need review` : null });
    for (const entry of accepted) await this.retire(entry);
    if (this.options.afterRelease) await this.options.afterRelease({ lane, release, overlays: final.overlaysMerged }).catch((error) => this.log(lane, `afterRelease: ${error.message}`));
    if (this.options.overlayProblems && final.overlayConflicts.length) await this.options.overlayProblems(final.overlayConflicts).catch(() => {});
    this.log(lane, `live ${releaseId}`);
    return true;
  }

  /** Releases the lane tip as it stands (the re-baseline, or redeploying after a host was rebuilt). */
  async releaseTip(lane, { force = false } = {}) {
    const module = this.lanes[lane];
    const tip = await this.fetch(lane);
    const dir = await this.worktree(lane);
    await this.git(["reset", "--quiet", "--hard", tip], { cwd: dir });
    const gate = await this.runGates(lane, dir, tip, tip, []);
    if (!gate.ok && !force) throw new Error(`${module.branch} ${tip.slice(0, 10)} fails ${gate.failures.map((failure) => failure.id).join(", ")}; pass --force to release it anyway`);
    const releaseId = `${lane}-${stamp()}-${tip.slice(0, 8)}`;
    await this.setLane(lane, { state: "rolling-out", tip });
    this.log(lane, `releasing the lane tip ${tip.slice(0, 10)} as ${releaseId}`);
    const deployed = await module.deploy({ dir, sha: tip, releaseId, previous: this.laneState[lane].release, hosts: this.options.hosts, ssh: this.ssh, log: (line) => this.log(lane, line) });
    if (!deployed.ok) { await this.setLane(lane, { state: "idle", note: `release of the tip failed: ${trim(deployed.error, 400)}` }); throw new Error(deployed.error); }
    const release = { id: releaseId, lane, sha: tip, at: new Date().toISOString(), base: tip, branch_pushed: true, submissions: [], works: [], overlays: [], roles: deployed.roles || {} };
    this.releases.unshift(release);
    fs.writeFileSync(path.join(this.stateDir, "releases", `${releaseId}.json`), JSON.stringify(release, null, 1));
    await this.setLane(lane, { state: "idle", release: { id: releaseId, sha: tip, at: release.at }, note: null });
    this.log(lane, `live ${releaseId}`);
    return release;
  }

  // ---------------------------------------------------------------- loops

  async laneLoop(lane, intervalMs) {
    while (!this.stopped) {
      let busy = false;
      this.paused = new Set(this.readJson("paused.json", []));
      if (!this.paused.has(lane)) {
        try { busy = await this.processLane(lane); }
        catch (error) {
          this.log(lane, `error: ${error.stack || error.message}`);
          await this.setLane(lane, { state: "idle", batch: [], note: `router error: ${trim(error.message, 300)}` }).catch(() => {});
        }
      }
      if (!busy) await new Promise((resolve) => { this.wake = resolve; setTimeout(resolve, intervalMs); });
    }
  }

  async start({ intervalMs = 15_000 } = {}) {
    this.startedAt = new Date().toISOString();
    await this.init();
    await this.saveStatus();
    return Promise.all(Object.keys(this.lanes).map((lane) => this.laneLoop(lane, intervalMs)));
  }
}
