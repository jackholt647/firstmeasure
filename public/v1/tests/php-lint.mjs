import { existsSync } from "node:fs";
import { opendir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const v1Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.resolve(v1Root, "..");
const phpCommand = process.platform === "win32" ? "php.exe" : "php";
const version = spawnSync(phpCommand, ["--version"], { encoding: "utf8" });
if (version.error || version.status !== 0) {
  process.stderr.write("PHP CLI is required to lint the production PHP surface.\n");
  process.exit(1);
}

const files = [];
const stack = [publicRoot];
while (stack.length) {
  const directory = stack.pop();
  if (!directory || !existsSync(directory)) continue;
  const handle = await opendir(directory);
  for await (const entry of handle) {
    if (["node_modules", "dist", "storage", "output", "unused"].includes(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) stack.push(entryPath);
    else if (entry.isFile() && entry.name.endsWith(".php")) files.push(entryPath);
  }
}

const failures = [];
for (const file of files) {
  const result = spawnSync(phpCommand, ["-l", file], { encoding: "utf8" });
  if (result.status !== 0) failures.push(`${path.relative(publicRoot, file)}: ${(result.stderr || result.stdout || "lint failed").trim()}`);
}

if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`PHP lint passed for ${files.length} files.\n`);
