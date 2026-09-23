import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let digest: string | undefined;
function canonicalSource(pathname: string): string {
  // Git archives and copied releases can differ only in line endings. Their
  // executable meaning is identical, so they must retain one action identity
  // across load-balanced nodes and durable idempotency replays.
  return readFileSync(pathname, "utf8").replaceAll("\r\n", "\n");
}

export function fingerprintBackendArtifact(root: string): string {
  const hash = createHash("sha256");
  const excluded = new Set(["node_modules", "storage", "tests", ".git", "output", "coverage", "dist"]);
  function walk(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const filename = path.join(directory,entry.name);
      if (entry.isDirectory()) { if (!excluded.has(entry.name)) walk(filename); }
      else if (/\.(?:ts|js|mjs|cjs)$/.test(entry.name) || /^(?:package(?:-lock)?\.json)$/.test(entry.name)) {
        hash.update(path.relative(root,filename).replaceAll("\\","/")); hash.update("\0"); hash.update(canonicalSource(filename)); hash.update("\0");
      }
    }
  }
  walk(root);
  // tsc output lives in dist/ while the installed dependency manifests remain one level up.
  if (path.basename(root.replace(/[\\/]$/, "")) === "dist") {
    for (const name of ["package.json", "package-lock.json"]) {
      const filename = path.resolve(root,"..",name);
      if (!existsSync(filename)) throw new Error(`Compiled action artifact is missing ${name}; dependency identity cannot be verified.`);
      hash.update(name); hash.update("\0"); hash.update(canonicalSource(filename)); hash.update("\0");
    }
  }
  return hash.digest("hex");
}
/**
 * Conservative dependency identity: all backend source/build modules and package locks.
 * A wrapper's toString() cannot fingerprint the services it imports. A deployment change
 * therefore invalidates a frozen action unless the exact old artifact is still available.
 * This hashes files once per server process, never customer data or environment secrets.
 */
export function backendImplementationDigest(): string {
  if (digest) return digest;
  const root = fileURLToPath(new URL("../../", import.meta.url));
  digest = fingerprintBackendArtifact(root);
  return digest;
}
