// Dev web pool members (docs/architecture/dev-lanes.md, "New web nodes"). The dev load balancer routes to every droplet
// tagged firstmeasure-development-autoscale-r1, and the autoscale pool adds members built from its image. A new member
// holds itself out of rotation and registers with the router (deploy/digitalocean/dev-pool-user-data.sh,
// router/register-node.sh); every minute the router adopts each registered node (stages and activates the current
// platform release on it, which lets it join), drops members that stay unreachable, and samples dev.1m8.ai's public
// health to flag any instance serving a release that is not its own. Role "web" is the primary web node (status, live
// layer); `server.mjs primary <role|ip>` moves it after the live overlays are baked into a release.
import fs from "node:fs";
import path from "node:path";
import { run } from "../lib/common.mjs";

const PUBLIC_URL = process.env.DEV_PUSH_PUBLIC_URL || "https://dev.1m8.ai";
const GONE_AFTER_MS = 15 * 60_000;

export function makeFleet({ router, hosts, log = () => {} }) {
  const stateFile = path.join(router.stateDir, "fleet.json");
  const registrations = path.join(router.stateDir, "registrations.jsonl");
  const read = () => { try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return {}; } };
  const state = { adopted: {}, unreachable: {}, ...read() };
  const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 1));
  if (state.primary) hosts.addRole("web", state.primary);
  for (const [role, address] of Object.entries(state.adopted)) hosts.addRole(role, address);
  const hostKeys = {};

  /** The live layer's receiver and its SSH host key, for live-sync clients (they read it from the status document). */
  async function liveInfo() {
    const address = hosts.addresses().web;
    if (!address) return null;
    const ip = address.split("@").pop();
    if (!hostKeys[ip]) {
      const scan = await run("ssh-keyscan", ["-t", "ed25519", "-T", "10", ip], { timeout: 20_000 });
      const line = scan.stdout.split("\n").find((item) => item.startsWith(`${ip} ssh-ed25519 `));
      if (line) hostKeys[ip] = line.trim();
    }
    return { target: `fmlive@${ip}`, host_key: hostKeys[ip] || null };
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

  /** Returns false when it could not judge (a release in progress): the caller retries soon. */
  async function check() {
    const lane = router.laneState.platform;
    if (!lane?.release?.name || !["idle", "held"].includes(lane.state)) return false;
    const expected = lane.release.server || lane.release.name; // what /v1/health/ready reports (kept across browser-only releases)
    const problems = [];

    // Adopt registered nodes.
    const known = new Set(Object.values(hosts.addresses()));
    for (const node of registered()) {
      const address = `root@${node.public}`;
      if (known.has(address)) continue;
      // "pending-" until it serves the current release: status publishing and releases only use web roles.
      const pending = `pending-${node.id}`, role = `web-${node.id}`;
      hosts.addRole(pending, address);
      const status = await hosts.status(pending, "platform");
      if (!status.ok) { hosts.removeRole(pending); problems.push(`registered node ${node.id} (${node.public}) does not answer fm-release: ${String(status.error).slice(0, 200)}`); continue; }
      log(`adopting registered node ${node.id} (${node.public}) as ${role}`);
      const result = await router.catchUp("platform", pending).catch((error) => ({ ok: false, error: error.message }));
      hosts.removeRole(pending);
      if (!result.ok) { problems.push(`could not bring node ${node.id} to ${expected}: ${String(result.error).slice(0, 300)}`); continue; }
      hosts.addRole(role, address);
      state.adopted[role] = address;
      save();
      log(`node ${node.id} serves ${expected}`);
    }

    // Members that stay unreachable are gone (the pool destroyed them); the primary is only ever moved by hand.
    for (const role of Object.keys(state.adopted)) {
      const status = await hosts.status(role, "platform");
      if (status.ok) { delete state.unreachable[role]; continue; }
      state.unreachable[role] ||= Date.now();
      if (Date.now() - state.unreachable[role] > GONE_AFTER_MS) { hosts.removeRole(role); delete state.adopted[role]; delete state.unreachable[role]; log(`${role} unreachable for 15 min; dropped`); }
      else problems.push(`${role} does not answer`);
    }
    save();

    const seen = await sample();
    for (const [instance, release] of Object.entries(seen)) if (release !== expected) problems.push(`ALERT: ${instance} behind the load balancer serves ${release}, not ${expected}`);
    const fleet = { checked_at: new Date().toISOString(), primary: hosts.addresses().web || null, members: { ...state.adopted }, instances: seen, problems };
    if (JSON.stringify(problems) !== JSON.stringify(router.fleet?.problems || [])) for (const problem of problems) log(`FLEET: ${problem}`);
    router.fleet = fleet;
    router.live = await liveInfo().catch(() => null);
    await router.saveStatus();
    return true;
  }

  /** Makes `target` (an adopted role or an IP) the primary web node; the old primary stays a member if it answers. */
  function setPrimary(target) {
    const addresses = hosts.addresses();
    const address = addresses[target] || (target.includes("@") ? target : `root@${target}`);
    const role = Object.keys(state.adopted).find((name) => state.adopted[name] === address);
    const old = addresses.web;
    if (role) { hosts.removeRole(role); delete state.adopted[role]; }
    if (old && old !== address) { state.adopted["web-previous"] = old; hosts.addRole("web-previous", old); }
    state.primary = address;
    hosts.addRole("web", address);
    save();
    return { primary: address, previous: old };
  }

  function forget(role) {
    hosts.removeRole(role);
    delete state.adopted[role];
    delete state.unreachable[role];
    save();
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

  return { check, sample, liveInfo, setPrimary, forget, requests };
}
