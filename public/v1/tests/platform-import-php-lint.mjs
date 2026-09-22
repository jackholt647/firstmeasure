import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const platformRoot = path.resolve(__dirname, "../../platform");
const appsRoot = path.resolve(__dirname, "../../apps");
const portalRoot = path.resolve(__dirname, "../../portal");

function findPhpFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) files.push(...findPhpFiles(fullPath));
    else if (entry.endsWith(".php")) files.push(fullPath);
  }
  return files;
}

const phpFiles = [platformRoot, appsRoot, portalRoot]
  .filter((root) => existsSync(root))
  .flatMap((root) => findPhpFiles(root));
for (const file of phpFiles) {
  const result = spawnSync("php", ["-l", file], { encoding: "utf8" });
  if (result.error) {
    process.stderr.write(`PHP lint failed: unable to run php (${result.error.message}).\n`);
    process.exit(1);
  }
  if (result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status || 1);
  }
}

console.log(`PHP lint passed for ${phpFiles.length} platform/app files.`);
