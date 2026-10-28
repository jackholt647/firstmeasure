// Dev web pool members (docs/architecture/dev-lanes.md, "New web nodes"). The dev load balancer routes to every droplet
// tagged firstmeasure-development-autoscale-r1, and the autoscale pool adds members built from its image. Every minute
// the router (1) samples dev.1m8.ai's public health and flags any instance serving a release that is not its own, and
// (2) with a read-only DigitalOcean token in ~/dev-push/do-token, lists the tagged members, adopts each new one that
// runs fm-release (deploy/digitalocean/dev-pool-user-data.sh holds it out of rotation and installs it) by staging and
// activating the current platform release on it, and drops members that are gone.
import fs from "node:fs";
import path from "node:path";

const TAG = process.env.DEV_PUSH_POOL_TAG || "firstmeasure-development-autoscale-r1";
const PUBLIC_URL = process.env.DEV_PUSH_PUBLIC_URL || "https://dev.1m8.ai";

export function makeFleet({ router, hosts, home, log = () => {} }) {
  const tokenFile = path.join(home, "do-token");
  const stateFile = path.join(router.stateDir, "fleet.json");
  const state = (() => { try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return { adopted: {} }; } })();
  for (const [role, address] of Object.entries(state.adopted || {})) hosts.addRole(role, address);
  const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 1));

  /** Tagged pool members from DigitalOcean, or null without a token. */
  async function members() {
    if (!fs.existsSync(tokenFile)) return null;
    const token = fs.readFileSync(tokenFile, "utf8").trim();
    const response = await fetch(`https://api.digitalocean.com/v2/droplets?tag_name=${encodeURIComponent(TAG)}&per_page=100`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`DigitalOcean droplets by tag: HTTP ${response.status}`);
    const data = await response.json();
    return (data.droplets || []).map((droplet) => ({
      id: String(droplet.id), name: droplet.name, status: droplet.status,
      public: droplet.networks?.v4?.find((net) => net.type === "public")?.ip_address || null
    }));
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

  async function check() {
    const lane = router.laneState.platform;
    if (!lane?.release?.name || lane.state !== "idle") return; // never judge the fleet mid-release
    const expected = lane.release.name;
    const problems = [];
    const seen = await sample();
    for (const [instance, release] of Object.entries(seen)) if (release !== expected) problems.push(`${instance} serves ${release}, not ${expected}`);

    let listed = null;
    try { listed = await members(); } catch (error) { problems.push(`pool listing failed: ${error.message}`); }
    if (listed) {
      const known = new Set(Object.values(hosts.addresses()));
      for (const member of listed.filter((item) => item.status === "active" && item.public)) {
        const address = `root@${member.public}`;
        if (known.has(address)) continue;
        const role = `web-${member.id}`;
        hosts.addRole(role, address);
        const status = await hosts.status(role, "platform");
        if (!status.ok) {
          hosts.removeRole(role);
          problems.push(`pool member ${member.name} (${member.public}) has no fm-release: its image or user data does not hand it to the router`);
          continue;
        }
        log(`adopting pool member ${member.name} (${member.public}) as ${role}`);
        const result = await router.catchUp("platform", role).catch((error) => ({ ok: false, error: error.message }));
        if (!result.ok) { hosts.removeRole(role); problems.push(`could not bring ${member.name} to ${expected}: ${String(result.error).slice(0, 300)}`); continue; }
        state.adopted[role] = address;
        save();
        log(`${member.name} serves ${expected}`);
      }
      const present = new Set(listed.map((item) => `web-${item.id}`));
      for (const role of Object.keys(state.adopted)) if (!present.has(role)) { hosts.removeRole(role); delete state.adopted[role]; save(); log(`pool member ${role} is gone`); }
    }
    const fleet = { checked_at: new Date().toISOString(), instances: seen, members: listed, problems };
    if (JSON.stringify(fleet.problems) !== JSON.stringify(router.fleet?.problems || [])) for (const problem of problems) log(`FLEET: ${problem}`);
    router.fleet = fleet;
    await router.saveStatus();
  }

  return { check, members, sample };
}
