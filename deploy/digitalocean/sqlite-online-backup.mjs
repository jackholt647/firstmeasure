#!/usr/bin/env node

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

const { DatabaseSync } = await import("node:sqlite");
if (typeof DatabaseSync !== "function") throw new Error("node:sqlite DatabaseSync is unavailable.");

const sourceDb = new DatabaseSync(source, { readOnly: true });
try {
  sourceDb.exec("PRAGMA busy_timeout = 30000");
  const quotedDestination = destination.replaceAll("'", "''");
  process.stdout.write(`Creating transactional SQLite snapshot: ${source} -> ${destination}\n`);
  sourceDb.exec(`VACUUM INTO '${quotedDestination}'`);
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
