// Dev web pool members (docs/architecture/dev-lanes.md, "New web nodes"). The dev load balancer routes to every droplet
// tagged firstmeasure-development-autoscale-r1, and the autoscale pool adds and removes members whenever it likes, with
// nobody watching. A new member holds itself out of rotation and registers with the router
// (deploy/digitalocean/dev-pool-user-data.sh, router/register-node.sh). Every check the router:
//   - adopts each registered node: brings it to every lane's current release, which lets it join;
//   - brings any web node that fell behind (left out of a release while it did not answer) up to date;
//   - promotes a healthy member when the primary web node stops answering, and drops members that stay gone;
//   - copies the primary's live layer to every other web node, so a save is served whichever node answers;
//   - samples dev.1m8.ai's public health and flags any instance serving a release that is not its own.
// Role "web" is the primary web node (where lanes stage first, the live layer's export and the receiver live-sync
// clients without a fan-out use); `server.mjs primary <role|ip>` moves it by hand after baking the live overlays.
import fs from "node:fs";
import path from "node:path";
import { isWebRole, run } from "../lib/common.mjs";

const PUBLIC_URL = process.env.DEV_PUSH_PUBLIC_URL || "https://dev.1m8.ai";
const GONE_AFTER_MS = 15 * 60_000;
const PRIMARY_DOWN_CHECKS = 3; // consecutive failed checks (10 s apart while it fails) before a member is promoted
const LIVE_SETTLE_S = 30; // a live file a member has and the primary lacks is removed only once it is this old

const ipOf = (address) => String(address || "").split("@").pop();

/** `receiver(ip)` returns a request function for that node's live receiver (live.mjs receiverClient). */
export function makeFleet({ router, hosts, receiver = null, log = () => {} }) {
  const stateFile = path.join(router.stateDir, "fleet.json");
  const registrations = path.join(router.stateDir, "registrations.jsonl");
  const read = () => { try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return {}; } };
  const state = { adopted: {}, unreachable: {}, gone: {}, primary_failures: 0, ...read() };
  const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 1));
  if (state.primary) hosts.addRole("web", state.primary);
  for (const [role, address] of Object.entries(state.adopted)) hosts.addRole(role, address);
  hosts.down ||= new Set();
  const markDown = () => { hosts.down.clear(); for (const role of Object.keys(state.unreachable)) hosts.down.add(role); if (state.primary_failures) hosts.down.add("web"); };
  markDown();
  const hostKeys = {};

  async function hostKey(ip) {
    if (!hostKeys[ip]) {
      const scan = await run("ssh-keyscan", ["-t", "ed25519", "-T", "10", ip], { timeout: 20_000 });
      const line = scan.stdout.split("\n").find((item) => item.startsWith(`${ip} ssh-ed25519 `));
      if (line) hostKeys[ip] = line.trim();
    }
    return hostKeys[ip] || null;
  }

  /**
   * The live layer's receivers for live-sync clients (they read it from the status document): `target` is the primary,
   * `targets` every web node that answers, each with its SSH host key. A sync sends each save to all of them.
   */
  async function liveInfo() {
    const address = hosts.addresses().web;
    if (!address) return null;
    const members = Object.entries(state.adopted).filter(([role]) => isWebRole(role) && !state.unreachable[role]).map(([, member]) => member);
    const targets = [];
    for (const item of [address, ...members]) targets.push({ target: `fmlive@${ipOf(item)}`, host_key: await hostKey(ipOf(item)) });
    return { target: targets[0].target, host_key: targets[0].host_key, targets };
  }

  /** Which release each instance behind the load balancer serves: { instance_id: release_id }. */
  async function sample(times = 12) {
    const seen = {};
    for (let i = 0; i < times; i++) {
      try {
        const response = await fetch(`${PUBLIC_URL}/v1/health/ready`, { signal: AbortSignal.timeout(8000), headers: { "cache-control": "no-cache" } });
        const data = await response.json().catch(() => ({}));
        if (data.instance_id) seen[data.instance_id] = data.release_id || null;
      } catch {}
    }
    return seen;
  }

  function registered() {
    const byId = {};
    try { for (const line of fs.readFileSync(registrations, "utf8").split("\n")) { try { const entry = JSON.parse(line); byId[entry.id] = entry; } catch {} } } catch {}
    return Object.values(byId);
  }

  const idOf = (address) => registered().find((node) => `root@${node.public}` === address)?.id || null;
  const settled = (lane) => ["idle", "held", "paused", "waiting"].includes(router.laneState[lane]?.state);
  const expectedName = (lane) => { const release = router.laneState[lane]?.release; return release ? release.name || release.sha : null; };

  /** Brings `role` to every lane's current release it lacks; returns the problems. */
  async function bringUp(role, statuses = {}) {
    const problems = [];
    for (const lane of Object.keys(router.lanes)) {
      const want = expectedName(lane);
      if (!want || !settled(lane)) continue;
      const status = statuses[lane] || await hosts.status(role, lane);
      if (!status.ok) { problems.push(`${role} does not answer fm-release for ${lane}: ${String(status.error).slice(0, 200)}`); continue; }
      if (status.lanes?.[lane]?.current === want) continue;
      log(`${role} serves ${status.lanes?.[lane]?.current || "nothing"} on ${lane}, not ${want}: bringing it up`);
      const result = await router.catchUp(lane, role).catch((error) => ({ ok: false, error: error.message }));
      if (!result.ok) problems.push(`could not bring ${role} to ${lane} ${want}: ${String(result.error).slice(0, 300)}`);
    }
    return problems;
  }

  /** Makes `target` (an adopted role or an IP) the primary web node; the old primary stays a member (dropped if gone). */
  function setPrimary(target, { oldIsDown = false } = {}) {
    const addresses = hosts.addresses();
    const address = addresses[target] || (target.includes("@") ? target : `root@${target}`);
    const role = Object.keys(state.adopted).find((name) => state.adopted[name] === address);
    const old = addresses.web;
    if (role) { hosts.removeRole(role); delete state.adopted[role]; delete state.unreachable[role]; }
    if (old && old !== address) {
      const oldRole = `web-${idOf(old) || ipOf(old).replaceAll(".", "-")}`;
      state.adopted[oldRole] = old;
      hosts.addRole(oldRole, old);
      if (oldIsDown) state.unreachable[oldRole] = state.primary_down_since || Date.now();
    }
    state.primary = address;
    state.primary_failures = 0;
    delete state.primary_down_since;
    hosts.addRole("web", address);
    save();
    markDown();
    return { primary: address, previous: old };
  }

  /** Copies the primary's live files to `role`'s receiver: what it lacks or has differently, and removes what the primary no longer has. */
  async function copyLive(role, exported, primaryRequest) {
    const request = receiver(ipOf(hosts.addresses()[role]));
    const [listed] = await request([{ op: "list" }]);
    if (!listed?.ok) return `${role} live receiver: ${listed?.error || "no answer"}`;
    const theirs = listed.files || {}, ours = exported.files || {};
    const now = Math.floor(Date.now() / 1000);
    const remove = Object.keys(theirs).filter((file) => (ours[file] ? ours[file].source !== theirs[file].source : now - Number(theirs[file].at || 0) > LIVE_SETTLE_S));
    const put = Object.keys(ours).filter((file) => theirs[file]?.sha !== ours[file].sha || theirs[file]?.source !== ours[file].source);
    if (!remove.length && !put.length) return null;
    const batches = [];
    if (remove.length) batches.push({ op: "batch", source: "dev-push-router", ops: remove.map((file) => ({ op: "remove", path: file, force: true })) });
    const blobs = put.length ? await primaryRequest(put.map((file) => ({ op: "blob", sha: ours[file].sha }))) : [];
    const bySource = new Map();
    put.forEach((file, index) => {
      if (!blobs[index]?.ok) return;
      const entry = ours[file];
      const list = bySource.get(entry.source) || bySource.set(entry.source, []).get(entry.source);
      list.push({ op: "put", path: file, sha: entry.sha, base: entry.base, ...(entry.commit ? { commit: entry.commit } : {}), data: blobs[index].data });
    });
    for (const [source, ops] of bySource) batches.push({ op: "batch", source, ops });
    const answers = await request(batches);
    const refused = answers.flatMap((answer) => (answer.results || []).filter((result) => !result.ok).map((result) => `${result.path} ${result.error}`));
    log(`live layer on ${role}: ${put.length} copied, ${remove.length} removed${refused.length ? `; refused ${refused.join(", ")}` : ""}`);
    return refused.length ? `${role} refused live files: ${refused.join(", ").slice(0, 300)}` : null;
  }

  async function replicateLive(problems) {
    if (!receiver || !hosts.addresses().web || state.primary_failures) return;
    const members = Object.keys(state.adopted).filter((role) => isWebRole(role) && !state.unreachable[role]);
    if (!members.length) return;
    const primaryRequest = receiver(ipOf(hosts.addresses().web));
    const [exported] = await primaryRequest([{ op: "export" }]).catch((error) => [{ ok: false, error: error.message }]);
    if (!exported?.ok) { problems.push(`live export from the primary: ${exported?.error}`); return; }
    for (const role of members) {
      const problem = await copyLive(role, exported, primaryRequest).catch((error) => `${role} live copy: ${error.message}`);
      if (problem) problems.push(problem);
    }
  }

  /** Returns false when it could not judge or the primary is failing: the caller checks again in 10 s. */
  async function check() {
    const lane = router.laneState.platform;
    if (!lane?.release?.name || !settled("platform")) return false;
    const expected = lane.release.server || lane.release.name; // what /v1/health/ready reports (kept across browser-only releases)
    const problems = [];
    const seen = router.fleet?.instances || {};

    // Adopt registered nodes. A node the pool destroyed stays gone unless it shows up behind the load balancer again.
    const known = new Set(Object.values(hosts.addresses()));
    for (const node of registered()) {
      const address = `root@${node.public}`;
      if (known.has(address) || (state.gone[node.id] && !(`do-${node.id}` in seen))) continue;
      // "pending-" until it serves the current releases: status publishing and releases only use web roles.
      const pending = `pending-${node.id}`, role = `web-${node.id}`;
      hosts.addRole(pending, address);
      const status = await hosts.status(pending, "platform");
      if (!status.ok) {
        hosts.removeRole(pending);
        state.gone[node.id] ||= Date.now();
        problems.push(`registered node ${node.id} (${node.public}) does not answer fm-release: ${String(status.error).slice(0, 200)}`);
        continue;
      }
      delete state.gone[node.id];
      log(`adopting registered node ${node.id} (${node.public}) as ${role}`);
      const failed = await bringUp(pending, { platform: status });
      hosts.removeRole(pending);
      if (failed.length) { problems.push(...failed); continue; }
      hosts.addRole(role, address);
      state.adopted[role] = address;
      save();
      log(`node ${node.id} serves ${expected}`);
    }

    // Every web node: answering, and on every lane's current release. Members that stay unreachable are gone.
    for (const role of ["web", ...Object.keys(state.adopted)]) {
      if (!hosts.addresses()[role]) continue;
      const status = await hosts.status(role, "platform");
      if (role === "web") {
        if (status.ok) { if (state.primary_failures) log(`primary web node answers again`); state.primary_failures = 0; delete state.primary_down_since; }
        else { state.primary_failures += 1; state.primary_down_since ||= Date.now(); problems.push(`primary web node ${hosts.addresses().web} does not answer (${state.primary_failures})`); continue; }
      } else if (status.ok) delete state.unreachable[role];
      else {
        state.unreachable[role] ||= Date.now();
        if (Date.now() - state.unreachable[role] > GONE_AFTER_MS) {
          const id = role.replace(/^web-/, "");
          if (registered().some((node) => node.id === id)) state.gone[id] = Date.now();
          hosts.removeRole(role); delete state.adopted[role]; delete state.unreachable[role];
          log(`${role} unreachable for ${GONE_AFTER_MS / 60_000} min; dropped`);
        } else problems.push(`${role} does not answer`);
        continue;
      }
      problems.push(...await bringUp(role, { platform: status }));
    }

    // The primary is gone: a healthy member on the current release takes over (live layer, staging, the status receiver).
    if (state.primary_failures >= PRIMARY_DOWN_CHECKS) {
      const candidate = Object.keys(state.adopted).find((role) => isWebRole(role) && !state.unreachable[role]);
      if (candidate) {
        const moved = setPrimary(candidate, { oldIsDown: true });
        log(`primary web node ${moved.previous} stopped answering; promoted ${moved.primary}`);
      } else problems.push("the primary web node is down and no other web node answers: waiting for the pool to add one");
    }
    save();
    markDown();

    await replicateLive(problems);

    const sampled = await sample();
    for (const [instance, release] of Object.entries(sampled)) if (release !== expected) problems.push(`ALERT: ${instance} behind the load balancer serves ${release}, not ${expected}`);
    const fleet = { checked_at: new Date().toISOString(), primary: hosts.addresses().web || null, members: { ...state.adopted }, unreachable: Object.keys(state.unreachable), instances: sampled, problems };
    if (JSON.stringify(problems) !== JSON.stringify(router.fleet?.problems || [])) for (const problem of problems) log(`FLEET: ${problem}`);
    router.fleet = fleet;
    router.live = await liveInfo().catch(() => null);
    await router.saveStatus();
    return state.primary_failures === 0;
  }

  function forget(role) {
    hosts.removeRole(role);
    delete state.adopted[role];
    delete state.unreachable[role];
    save();
    markDown();
  }

  /** Requests from `server.mjs primary|bake-live|forget` (state/requests.jsonl), handled by the running router. */
  async function requests(lastExport) {
    const file = path.join(router.stateDir, "requests.jsonl");
    let pending = [];
    try { pending = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { return; }
    const keep = [];
    for (const request of pending) {
      if (request.command === "forget") { forget(request.target); log(`forgot ${request.target}`); continue; }
      if (request.command === "adopt") { // a node that could not register itself (it must run fm-release with the router's key)
        fs.appendFileSync(registrations, JSON.stringify({ id: `manual${String(request.target).replace(/\D/g, "")}`, public: request.target, private: null, from: "router", at: new Date().toISOString() }) + "\n");
        log(`registered ${request.target} by hand`);
        continue;
      }
      // Baking: the lane loop's next pass releases every live overlay (router.forceOverlays).
      const exported = lastExport?.();
      const overlays = exported ? Object.keys(exported.files || {}).length + Object.keys(exported.parked || {}).length : null;
      if (request.command === "bake-live") {
        if (overlays === 0) { log("live layer is empty; nothing to bake"); continue; }
        router.forceOverlays = true; keep.push(request); continue;
      }
      if (request.command === "primary") {
        if (overlays !== 0) { router.forceOverlays = true; keep.push(request); continue; } // move only once the layer is empty
        const moved = setPrimary(request.target);
        router.live = await liveInfo().catch(() => null);
        log(`primary web node is now ${moved.primary} (was ${moved.previous})`);
      }
    }
    fs.writeFileSync(file, keep.map((request) => JSON.stringify(request)).join("\n") + (keep.length ? "\n" : ""));
  }

  return { check, sample, liveInfo, setPrimary, forget, requests, replicateLive };
}
