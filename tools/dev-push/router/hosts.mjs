// How the router reaches dev hosts: SSH with its own key, which each host lets run only fm-release
// (tools/dev-push/host/fm-release.py). Lane modules get this object; they hold no keys or addresses.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../lib/common.mjs";

/** Dev roles. Hosts are reached from the dev sync droplet directly. */
export const INVENTORY = {
  web: { address: "root@143.198.68.11" },
  worker: { address: "root@137.184.44.82" },
  legacy: { address: "root@137.184.229.145" }
};

export function makeHosts({ inventory: given = INVENTORY, key = path.join(os.homedir(), ".ssh", "dev_push_router_ed25519"), knownHosts = path.join(os.homedir(), "dev-push", "known_hosts"), log = () => {} } = {}) {
  const inventory = Object.fromEntries(Object.entries(given).map(([role, host]) => [role, { ...host }])); // pool members join and leave
  const sshOptions = ["-i", key, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${knownHosts}`, "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15"];
  const address = (role) => {
    const host = inventory[role];
    if (!host) throw new Error(`unknown role ${role}`);
    return host.address;
  };

  /** Runs `fm-release <args>` on a role; resolves the parsed JSON answer (ok:false answers included). */
  async function call(role, args, { input, timeoutMs = 15 * 60_000 } = {}) {
    const result = await run("ssh", [...sshOptions, address(role), ["fm-release", ...args].join(" ")], { input, timeout: timeoutMs });
    const last = String(result.stdout || "").trim().split("\n").at(-1) || "";
    try { return JSON.parse(last); } catch { return { ok: false, error: `ssh ${role} fm-release ${args[0]}: exit ${result.code}: ${(result.stderr || result.stdout || "").trim().slice(-500)}` }; }
  }

  return {
    get roles() { return Object.keys(inventory); },
    addRole(role, address) { inventory[role] = { address }; },
    removeRole(role) { delete inventory[role]; },
    addresses() { return Object.fromEntries(Object.entries(inventory).map(([role, host]) => [role, host.address])); },
    call,
    status: (role, lane = "platform", probe = null) => call(role, ["status", lane, ...(probe ? ["--probe", probe] : [])], { timeoutMs: 60_000 }),

    /** Uploads `dir` as release `sha` of `lane` (unchanged files hard-linked to the running release) and checks it against `manifest`. */
    async stage(role, { lane, sha, dir, manifest, releases }) {
      const dest = `${releases}/${sha}.staging/`;
      const linkDest = lane === "platform" ? "/opt/firstmeasure/current/" : `/opt/firstmeasure/lanes/${lane}/current/`;
      const rsync = await run("rsync", [
        "-a", "--checksum", "--delete", "--delete-excluded", "--chown=firstmeasure:firstmeasure", `--link-dest=${linkDest}`, "--exclude=/.manifest.json", "--exclude=/.dev-push-*", "--exclude=/public/storage/", "--exclude=/public/v1/storage/", "--exclude=/public/v1/output/",
        "-e", ["ssh", ...sshOptions].join(" "), `${dir.replace(/\/?$/, "/")}`, `${address(role)}:${dest}`
      ], { timeout: 30 * 60_000 });
      if (rsync.code !== 0) return { ok: false, error: `rsync to ${role}: ${rsync.stderr.trim().slice(-800)}` };
      return call(role, ["finish", lane, sha], { input: JSON.stringify(manifest), timeoutMs: 10 * 60_000 });
    },

    /**
     * Stages release `sha` from the role's verified `previous` release plus only the `changed` files of `dir` (a tar
     * over SSH; `deleted` paths are removed), then checks it against `manifest`, reading only what changed.
     */
    async assemble(role, { lane, sha, previous, dir, changed, deleted, manifest }) {
      const list = path.join(dir, ".dev-push-files");
      fs.writeFileSync(path.join(dir, `.dev-push-deleted-${role}`), deleted.join("\n"));
      fs.writeFileSync(list, "");
      const names = [...changed, `.dev-push-deleted-${role}`];
      fs.writeFileSync(`${list}-${role}`, names.join("\n"));
      const remote = ["ssh", ...sshOptions, address(role), `fm-release assemble ${lane} ${sha} ${previous}`].map((part) => `'${String(part).replace(/'/g, "'\\''")}'`).join(" ");
      // The deletion list travels inside the tar under the name fm-release reads.
      const piped = await run("bash", ["-c", `tar -c -C '${dir}' --owner=firstmeasure:0 --group=firstmeasure:0 --transform='s,^.dev-push-deleted-${role}$,.dev-push-deleted,' -T '${list}-${role}' | ${remote}`], { timeout: 30 * 60_000 });
      fs.rmSync(`${list}-${role}`, { force: true });
      fs.rmSync(path.join(dir, `.dev-push-deleted-${role}`), { force: true });
      fs.rmSync(list, { force: true });
      const last = String(piped.stdout || "").trim().split("\n").at(-1) || "";
      let answer;
      try { answer = JSON.parse(last); } catch { answer = { ok: false, error: `assemble on ${role}: exit ${piped.code}: ${(piped.stderr || piped.stdout || "").trim().slice(-500)}` }; }
      if (!answer.ok) return answer;
      return call(role, ["finish", lane, sha, "--previous", previous], { input: JSON.stringify(manifest), timeoutMs: 10 * 60_000 });
    },
    activate: (role, { lane, sha, expect = "-", waitJobs = 600, keepServer = false }) => call(role, ["activate", lane, sha, "--expect", expect || "-", "--wait-jobs", String(waitJobs), ...(keepServer ? ["--keep-server"] : [])], { timeoutMs: 20 * 60_000 }),
    check: (role, { lane, sha, paths }) => call(role, ["check", lane, sha], { input: JSON.stringify(paths), timeoutMs: 10 * 60_000 }),
    rollback: (role, { lane, sha }) => call(role, ["rollback", lane, sha], { timeoutMs: 10 * 60_000 }),
    prune: (role, { lane, keep = 10, days = 3 }) => call(role, ["prune", lane, "--keep", String(keep), "--days", String(days)], { timeoutMs: 30 * 60_000 }),
    tree: (role, lane = "platform") => call(role, ["tree", lane], { timeoutMs: 10 * 60_000 })
  };
}
