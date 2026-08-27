#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const [sourceArgument, destinationArgument] = process.argv.slice(2);
if (!sourceArgument || !destinationArgument) {
  process.stderr.write("Usage: sqlite-online-backup.mjs SOURCE.sqlite DESTINATION.sqlite\n");
  process.exit(2);
}

const source = path.resolve(sourceArgument);
const destination = path.resolve(destinationArgument);
const sourceInfo = await stat(source).catch(() => null);
if (!sourceInfo?.isFile()) throw new Error(`SQLite source is not a file: ${source}`);
await access(destination).then(
  () => { throw new Error(`Refusing to overwrite existing SQLite backup: ${destination}`); },
  () => undefined
);
await mkdir(path.dirname(destination), { recursive: true });

const sqlite = await import("node:sqlite");
const DatabaseSync = sqlite.DatabaseSync;
if (typeof DatabaseSync !== "function") throw new Error("node:sqlite DatabaseSync is unavailable.");

const sourceDb = new DatabaseSync(source, { readOnly: true });
try {
  sourceDb.exec("PRAGMA busy_timeout = 30000");
  if (typeof sqlite.backup === "function") {
    let lastProgressAt = 0;
    await sqlite.backup(sourceDb, destination, {
      rate: 4096,
      progress({ remainingPages, totalPages }) {
        const now = Date.now();
        if (now - lastProgressAt < 30_000 && remainingPages !== 0) return;
        lastProgressAt = now;
        process.stdout.write(`SQLite backup progress: ${totalPages - remainingPages}/${totalPages} pages (${source})\n`);
      }
    });
  } else {
    sourceDb.close();
    await sqliteCliBackup(source, destination);
  }
} finally {
  try { sourceDb.close(); } catch {}
}

const backupDb = new DatabaseSync(destination, { readOnly: true });
try {
  const row = backupDb.prepare("SELECT COUNT(*) AS count FROM sqlite_master").get();
  process.stdout.write(`SQLite backup complete: ${source} -> ${destination} (${String(row?.count ?? 0)} schema objects)\n`);
} finally {
  backupDb.close();
}

async function sqliteCliBackup(sourcePath, destinationPath) {
  await new Promise((resolve, reject) => {
    const child = spawn("sqlite3", [sourcePath, ".timeout 30000", `.backup ${destinationPath}`], {
      stdio: ["ignore", "inherit", "inherit"]
    });
    child.once("error", (error) => {
      reject(new Error(`node:sqlite backup() is unavailable and sqlite3 could not start: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      if (signal) reject(new Error(`sqlite3 backup terminated by ${signal}.`));
      else if (code !== 0) reject(new Error(`sqlite3 backup exited with status ${code ?? 1}.`));
      else resolve();
    });
  });
}
