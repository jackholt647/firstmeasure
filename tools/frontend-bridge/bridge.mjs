#!/usr/bin/env node
// FirstMate frontend bridge (docs/architecture/frontend-bridge.md).
//
// `serve` watches a checkout for browser files that differ from what dev.1m8.ai serves, copies exactly those into
// the unpacked FirstMate Dev Bridge extension's folder, and tells the extension (over a WebSocket on 127.0.0.1)
// to redirect dev's requests for them to its own copies. The page never reaches this machine's network: Chrome
// blocks a public site from loading anything from loopback (Local Network Access), even when redirected.
// Every other command is a client of that server: it relays page commands (eval, console, reload, screenshot)
// through the extension to an open dev.1m8.ai tab. No dependencies beyond Node 20+ and git.

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROTOCOL = 1;
/** The unpacked extension's ID, fixed by the `key` in extension/manifest.json. Only it may open the live channel. */
const EXTENSION_ID = "jfaopkielgkjkgomhmgdhldpogfdjohm";
/** Sites the bridge may serve overrides to. Development only; production is never on this list. */
const SITES = ["https://dev.1m8.ai"];
const DEFAULT_PORT = 5747;
const DEFAULT_BASE = "codex/consolidated-firstmeasure-20260923";
const DEV_HASH_TTL_MS = 60_000;

const TYPES = {
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".map": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".webm": "video/webm"
};
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEXT = new Set([".js", ".mjs", ".css", ".json", ".map", ".txt", ".svg"]);

// ---------------------------------------------------------------------------------------------------------------
// Arguments

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith("--")) { args._.push(item); continue; }
    const [key, inline] = item.slice(2).split(/=(.*)/s, 2);
    if (inline !== undefined) args[key] = inline;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) args[key] = argv[++i];
    else args[key] = true;
  }
  return args;
}

const stateFile = (port) => path.join(os.tmpdir(), `firstmate-frontend-bridge-${port}.json`);

// ---------------------------------------------------------------------------------------------------------------
// Files: what differs from the base and from what dev serves

function git(root, args, encoding = "utf8") {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: root, encoding, maxBuffer: 256 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args.join(" ")}: ${String(stderr || error.message).trim()}`));
      else resolve(stdout);
    });
  });
}

const extOf = (rel) => path.extname(rel).toLowerCase();
const normalize = (rel, bytes) => TEXT.has(extOf(rel)) ? Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n")) : bytes;
const hash = (bytes) => crypto.createHash("sha1").update(bytes).digest("hex");

/** What a changed path under the repository is to the bridge. */
export function classify(repoPath) {
  if (!repoPath.startsWith("public/")) return "outside";
  const rel = repoPath.slice("public/".length);
  if (rel.startsWith("v1/") || rel.startsWith("storage/")) return "server";
  const ext = extOf(rel);
  if (ext === ".php" || ext === ".html" || ext === ".htm") return "page";
  return TYPES[ext] ? "browser" : "server";
}

export function kindOf(rel) {
  const ext = extOf(rel);
  if (ext === ".css") return "css";
  if (ext === ".js" || ext === ".mjs") return "js";
  if (ext === ".json") return "json";
  return "asset";
}

/** Parses `git diff --name-status -z` output into [{ status, path }]. */
export function parseNameStatus(text) {
  const parts = text.split("\0").filter((part) => part !== "");
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i];
    if (/^[RC]/.test(status)) { entries.push({ status: status[0], path: parts[i + 2] }); i += 2; }
    else { entries.push({ status: status[0], path: parts[i + 1] }); i += 1; }
  }
  return entries;
}

class Files {
  constructor({ root, site, baseRef }) {
    Object.assign(this, { root, site, baseRef });
    this.base = "";
    this.records = new Map();
    this.devCache = new Map();
    this.baseCache = new Map();
    /** The exact bytes each override was hashed from, so the copy matches its rev. */
    this.bytes = new Map();
  }

  async devHash(rel) {
    const cached = this.devCache.get(rel);
    if (cached && Date.now() - cached.at < DEV_HASH_TTL_MS) return cached.value;
    let value;
    try {
      const response = await fetch(`${this.site}/${rel.split("/").map(encodeURIComponent).join("/")}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
      value = response.status === 404 ? null : response.ok ? hash(normalize(rel, Buffer.from(await response.arrayBuffer()))) : undefined;
    } catch { value = undefined; }
    this.devCache.set(rel, { at: Date.now(), value });
    return value;
  }

  async baseHash(repoPath) {
    const key = `${this.base}:${repoPath}`;
    if (this.baseCache.has(key)) return this.baseCache.get(key);
    const value = await git(this.root, ["show", `${this.base}:${repoPath}`], "buffer").then((bytes) => hash(normalize(repoPath, bytes)), () => null);
    this.baseCache.set(key, value);
    return value;
  }

  async refresh() {
    const ref = (await git(this.root, ["rev-parse", "--verify", "--quiet", this.baseRef]).catch(() => "")).trim() ? this.baseRef : "HEAD";
    this.base = (await git(this.root, ["merge-base", ref, "HEAD"])).trim();
    const [diff, untracked] = await Promise.all([
      git(this.root, ["-c", "core.quotepath=off", "diff", "--name-status", "-z", "--no-renames", this.base, "--", "public"]),
      git(this.root, ["-c", "core.quotepath=off", "ls-files", "--others", "--exclude-standard", "-z", "--", "public"])
    ]);
    const changed = new Map(parseNameStatus(diff).map((entry) => [entry.path, entry.status]));
    for (const file of untracked.split("\0").filter(Boolean)) changed.set(file, "A");
    const records = new Map();
    const bytesByPath = new Map();
    const pending = [];
    for (const [repoPath, status] of changed) {
      const kind = classify(repoPath);
      if (kind === "outside") continue;
      const rel = repoPath.slice("public/".length);
      if (kind !== "browser" || status === "D") { records.set(rel, { path: rel, repoPath, role: status === "D" ? "deleted" : kind }); continue; }
      pending.push((async () => {
        let bytes;
        try { bytes = fs.readFileSync(path.join(this.root, repoPath)); } catch { return; }
        const local = hash(normalize(rel, bytes));
        bytesByPath.set(rel, bytes);
        const [dev, base] = await Promise.all([this.devHash(rel), this.baseHash(repoPath)]);
        records.set(rel, {
          path: rel, repoPath, role: "browser", kind: kindOf(rel), rev: local.slice(0, 12), size: bytes.length,
          live: dev === local,
          drift: base === null ? "new" : dev === undefined ? "unknown" : dev === base ? "same" : dev === null ? "missing-on-dev" : "dev-differs"
        });
      })());
    }
    await Promise.all(pending);
    this.records = new Map([...records.entries()].sort(([a], [b]) => a.localeCompare(b)));
    this.bytes = bytesByPath;
    return this.records;
  }

  overrides() { return [...this.records.values()].filter((record) => record.role === "browser" && !record.live); }
}

// ---------------------------------------------------------------------------------------------------------------
// The extension's folder: where overrides are copied for Chrome to serve as extension resources

const readdir = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
const isBridgeExtension = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).name === "FirstMate Dev Bridge"; } catch { return false; } };

/** Folders Chrome loaded this unpacked extension from, read from every local Chrome profile's preferences. */
export function findExtensionFolders() {
  const local = process.env.LOCALAPPDATA || "";
  const userDataDirs = process.platform === "win32"
    ? readdir(path.join(local, "Google")).filter((name) => /^chrome/i.test(name)).map((name) => path.join(local, "Google", name, "User Data")).concat(path.join(local, "Chromium", "User Data"))
    : process.platform === "darwin"
      ? readdir(path.join(os.homedir(), "Library/Application Support/Google")).filter((name) => /^chrome/i.test(name)).map((name) => path.join(os.homedir(), "Library/Application Support/Google", name))
      : readdir(path.join(os.homedir(), ".config")).filter((name) => /chrom/i.test(name)).map((name) => path.join(os.homedir(), ".config", name));
  const found = new Set();
  for (const userData of userDataDirs) {
    for (const profile of readdir(userData)) {
      for (const file of ["Secure Preferences", "Preferences"]) {
        try {
          const folder = JSON.parse(fs.readFileSync(path.join(userData, profile, file), "utf8"))?.extensions?.settings?.[EXTENSION_ID]?.path;
          if (typeof folder === "string" && path.isAbsolute(folder) && isBridgeExtension(folder)) found.add(path.resolve(folder));
        } catch {}
      }
    }
  }
  return [...found];
}

/**
 * The copy Chrome serves lives at chrome-extension://<id>/overrides/<rev>/<path>, so anything the file resolves
 * against its own address (CSS url() and @import, module imports, import(), import.meta.url) would point into the
 * extension. Those references are made absolute on dev, where the redirect rules still apply to them.
 */
export function rewriteForExtension(rel, bytes, site) {
  const ext = extOf(rel);
  if (ext !== ".css" && ext !== ".js" && ext !== ".mjs") return bytes;
  const fileUrl = `${site}/${rel}`;
  let text = bytes.toString("utf8");
  if (ext === ".css") {
    const absolute = (ref) => /^(data:|blob:|[a-z][a-z0-9+.-]*:\/\/|#|\/\/)/i.test(ref) ? ref : new URL(ref, fileUrl).href;
    text = text.replace(/url\(\s*(['"]?)([^'")]+?)\1\s*\)/g, (_match, quote, ref) => `url(${quote}${absolute(ref)}${quote})`)
      .replace(/@import\s+(['"])([^'"]+)\1/g, (_match, quote, ref) => `@import ${quote}${absolute(ref)}${quote}`);
  } else {
    // import "./x" · import x from "./x" · export … from "./x" · import("./x") · import(`./${name}.js`)
    text = text.replace(/(\bfrom\s*|(?<![.$\w])import\s*\(\s*|(?<![.$\w])import\s+)(["'`])(\.\.?\/|\/(?!\/))/g, (_match, lead, quote, prefix) => `${lead}${quote}${new URL(prefix, fileUrl).href}`)
      .replace(/\bimport\.meta\.url\b/g, JSON.stringify(fileUrl));
  }
  return Buffer.from(text, "utf8");
}

/** Makes `<folder>/overrides/<rev>/<path>` hold exactly the current overrides, removing older revisions. */
function syncOverrides(folders, records, bytes, site) {
  let written = 0;
  for (const folder of folders) {
    const dir = path.join(folder, "overrides");
    const revs = new Set(records.map((record) => record.rev));
    for (const rev of readdir(dir)) if (!revs.has(rev)) fs.rmSync(path.join(dir, rev), { recursive: true, force: true });
    for (const record of records) {
      const target = path.join(dir, record.rev, ...record.path.split("/"));
      if (fs.existsSync(target) || !bytes.has(record.path)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, rewriteForExtension(record.path, bytes.get(record.path), site));
      written++;
    }
  }
  return written;
}

// ---------------------------------------------------------------------------------------------------------------
// A minimal WebSocket server endpoint (RFC 6455, text frames only), enough for one extension connection.

function acceptWebSocket(request, socket, onMessage, onClose) {
  const accept = crypto.createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let open = true;
  const frame = (opcode, payload) => {
    if (!open) return;
    const length = payload.length;
    const header = length < 126 ? Buffer.from([0x80 | opcode, length])
      : length < 65536 ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 255])
      : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(length)); return b; })()]);
    socket.write(Buffer.concat([header, payload]));
  };
  const connection = {
    send: (message) => frame(1, Buffer.from(JSON.stringify(message))),
    close: () => { if (open) { frame(8, Buffer.alloc(0)); open = false; socket.end(); } }
  };
  socket.on("data", (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    while (buffer.length >= 2) {
      const fin = (buffer[0] & 0x80) !== 0, opcode = buffer[0] & 0x0f, masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f, offset = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      if (length > 128 * 1024 * 1024) { socket.destroy(); return; }
      const maskAt = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= buffer[maskAt + (i & 3)];
      buffer = buffer.subarray(offset + length);
      if (opcode === 8) { connection.close(); return; }
      if (opcode === 9) { frame(10, payload); continue; }
      if (opcode === 10) continue;
      fragments.push(payload);
      if (!fin) continue;
      const text = Buffer.concat(fragments).toString("utf8");
      fragments = [];
      try { onMessage(JSON.parse(text)); } catch (error) { console.error("bridge: bad message from extension:", error.message); }
    }
  });
  let ended = false;
  const closed = () => { if (!ended) { ended = true; open = false; onClose(); } };
  socket.on("close", closed);
  socket.on("error", closed);
  return connection;
}

// ---------------------------------------------------------------------------------------------------------------
// serve

async function serve(args) {
  const root = path.resolve(String(args.root || process.cwd())).split(path.sep).join("/");
  const port = Number(args.port || DEFAULT_PORT);
  const site = String(args.site || SITES[0]).replace(/\/+$/, "");
  if (!SITES.includes(site)) throw new Error(`The bridge only serves ${SITES.join(", ")}; ${site} is not a development site.`);
  if (!fs.existsSync(path.join(root, "public", "libraries"))) throw new Error(`${root} is not a FirstMate checkout (no public/libraries). Pass --root.`);
  const files = new Files({ root, site, baseRef: String(args.base || DEFAULT_BASE) });
  let folders = [];
  const locateExtension = () => {
    const before = folders.join("|");
    folders = args.extension ? String(args.extension).split(",").map((folder) => path.resolve(folder)) : findExtensionFolders();
    if (!folders.length) folders = [path.join(HERE, "extension")];
    for (const folder of folders) if (!isBridgeExtension(folder)) throw new Error(`${folder} is not the FirstMate Dev Bridge extension folder.`);
    if (folders.join("|") !== before) console.log(`  extension ${folders.join(", ")}${args.extension ? "" : " (found in Chrome's profiles, or this checkout's copy when none)"}`);
  };
  locateExtension();
  const token = crypto.randomBytes(24).toString("hex");
  const hits = new Map();
  const extensions = new Set();
  const pending = new Map();
  let paused = false;
  let sequence = 0;

  const snapshot = () => ({
    type: "state", protocol: PROTOCOL, site, port, root, base: files.base, baseRef: files.baseRef, paused,
    files: paused ? [] : files.overrides().map(({ path: rel, rev, kind, drift }) => ({ path: rel, rev, kind, drift })),
    pending_deploy: [...files.records.values()].filter((record) => record.role !== "browser").map(({ repoPath, role }) => ({ path: repoPath, role })),
    live: [...files.records.values()].filter((record) => record.live).map((record) => record.path)
  });
  const broadcast = () => { const message = snapshot(); for (const extension of extensions) extension.send(message); };

  let refreshing = null, again = false;
  const refresh = async (why) => {
    if (refreshing) { again = true; return refreshing; }
    refreshing = (async () => {
      do {
        again = false;
        const before = JSON.stringify(files.overrides().map((record) => [record.path, record.rev]));
        try { await files.refresh(); syncOverrides(folders, paused ? [] : files.overrides(), files.bytes, site); } catch (error) { console.error(`bridge: ${error.message}`); }
        const after = JSON.stringify(files.overrides().map((record) => [record.path, record.rev]));
        if (before !== after) {
          const list = files.overrides();
          console.log(`${new Date().toLocaleTimeString()} ${why}: overriding ${list.length} file${list.length === 1 ? "" : "s"}${list.length ? ": " + list.map((record) => record.path).join(", ") : ""}`);
          for (const record of list.filter((entry) => entry.drift === "dev-differs")) console.warn(`  ${record.path}: dev serves a different version than your base, so this override also replaces those differences. Bring your checkout up to date.`);
          broadcast();
        }
      } while (again);
    })().finally(() => { refreshing = null; });
    return refreshing;
  };

  const command = (name, commandArgs, timeoutMs = 30_000) => new Promise((resolve, reject) => {
    const extension = [...extensions].at(-1);
    if (!extension) { reject(Object.assign(new Error("No browser is connected. Open Chrome with the FirstMate Dev Bridge extension and a dev.1m8.ai tab."), { status: 503 })); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error(`The browser did not answer "${name}" within ${Math.round(timeoutMs / 1000)} s.`), { status: 504 })); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    extension.send({ type: "command", id, name, args: commandArgs });
  });

  const status = () => ({
    protocol: PROTOCOL, root, port, site, base: files.base, base_ref: files.baseRef, paused,
    extension: extensions.size ? { connected: true, ...[...extensions].at(-1).hello, missing: [...extensions].at(-1).missing || [] } : { connected: false },
    extension_folders: folders,
    overrides: files.overrides().map((record) => ({ ...record, hits: hits.get(record.path) || null })),
    live: [...files.records.values()].filter((record) => record.live).map((record) => record.path),
    pending_deploy: [...files.records.values()].filter((record) => record.role !== "browser").map(({ repoPath, role }) => ({ path: repoPath, role }))
  });

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    const origin = request.headers.origin;
    try {
      if (url.pathname === "/control" && request.method === "POST") {
        // Command-line clients only: a browser always sends Origin on a POST, and never knows the token.
        if (origin || request.headers["x-bridge-token"] !== token) { response.writeHead(403); response.end(); return; }
        let body = "";
        for await (const chunk of request) body += chunk;
        const { name, args: commandArgs = {} } = JSON.parse(body || "{}");
        let value;
        if (name === "status") { await refresh("status"); value = status(); }
        else if (name === "pause" || name === "resume") { paused = name === "pause"; syncOverrides(folders, paused ? [] : files.overrides(), files.bytes, site); broadcast(); value = status(); }
        else if (name === "refresh") { files.devCache.clear(); await refresh("refresh"); broadcast(); value = status(); }
        else value = await command(name, commandArgs, Number(commandArgs.timeout || 30) * 1000 + 5000);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true, value }));
        return;
      }
      if (url.pathname === "/") { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ bridge: "firstmate-frontend", protocol: PROTOCOL })); return; }
      response.writeHead(404); response.end();
    } catch (error) {
      if (!response.headersSent) response.writeHead(error.status || 500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: error.message }));
    }
  });

  server.on("upgrade", (request, socket) => {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (url.pathname !== "/ext" || request.headers.origin !== `chrome-extension://${EXTENSION_ID}` || request.headers.upgrade?.toLowerCase() !== "websocket") {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return;
    }
    const connection = acceptWebSocket(request, socket, (message) => {
      if (message.type === "hello") {
        connection.hello = { version: message.version, browser: message.browser, tabs: message.tabs };
        if (message.protocol !== PROTOCOL) console.warn(`bridge: the extension speaks protocol ${message.protocol}, this bridge ${PROTOCOL}. Load the extension packaged from this checkout.`);
        if (!args.extension) locateExtension();
        syncOverrides(folders, paused ? [] : files.overrides(), files.bytes, site);
        console.log(`${new Date().toLocaleTimeString()} extension connected (${message.browser || "Chrome"}, ${message.tabs?.length || 0} dev tab${message.tabs?.length === 1 ? "" : "s"})`);
        connection.send(snapshot());
      } else if (message.type === "hit") {
        const hit = hits.get(message.path) || { count: 0, last: 0 };
        hits.set(message.path, { count: hit.count + 1, last: Date.now() });
      } else if (message.type === "missing") {
        connection.missing = message.files;
        // Copies deleted under a running bridge (a repackage, a cleanup): write them again and resend once.
        if (message.files.length && syncOverrides(folders, paused ? [] : files.overrides(), files.bytes, site)) { connection.send(snapshot()); return; }
        if (message.files.length) console.warn(`bridge: the extension cannot see ${message.files.length} override(s) in ${folders.join(", ")}. Start the bridge with --extension <the folder you loaded in chrome://extensions>.`);
      } else if (message.type === "tabs") {
        if (connection.hello) connection.hello.tabs = message.tabs;
      } else if (message.type === "result") {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.ok) entry.resolve(message.value);
        else entry.reject(Object.assign(new Error(message.error || "The browser refused the command."), { status: 422 }));
      }
    }, () => {
      extensions.delete(connection);
      console.log(`${new Date().toLocaleTimeString()} extension disconnected`);
    });
    extensions.add(connection);
  });

  await files.refresh();
  syncOverrides(folders, files.overrides(), files.bytes, site);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  fs.writeFileSync(stateFile(port), JSON.stringify({ pid: process.pid, port, token, root, site }), { mode: 0o600 });

  const list = files.overrides();
  console.log(`FirstMate frontend bridge on http://127.0.0.1:${port}`);
  console.log(`  checkout  ${root}`);
  console.log(`  base      ${files.base.slice(0, 10)} (merge-base of HEAD and ${files.baseRef})`);
  console.log(`  site      ${site}`);
  console.log(`  overriding ${list.length} file${list.length === 1 ? "" : "s"}${list.length ? ":\n    " + list.map((record) => record.path).join("\n    ") : ""}`);
  if (list.length > 40) console.warn(`  Warning: ${list.length} browser files differ from dev. Run the bridge from your own worktree, brought up to ${files.baseRef}, so only your changes are served.`);

  const ping = setInterval(() => { for (const extension of extensions) extension.send({ type: "ping", at: Date.now() }); }, 20_000);
  let timer = null;
  const watcher = fs.watch(path.join(root, "public"), { recursive: true }, (_event, filename) => {
    const name = String(filename || "").split(path.sep).join("/");
    if (/^(v1\/(node_modules|dist|storage|output)|storage)\//.test(name) || name.includes("/.git/")) return;
    clearTimeout(timer);
    timer = setTimeout(() => refresh(`changed ${name}`), 120);
  });
  // Commits, checkouts and merges move the base without touching public/: look again now and then.
  const poll = setInterval(() => refresh("poll"), 15_000);

  const shutdown = () => {
    clearInterval(ping); clearInterval(poll); watcher.close();
    for (const extension of extensions) { extension.send({ type: "bye" }); extension.close(); }
    for (const folder of folders) fs.rmSync(path.join(folder, "overrides"), { recursive: true, force: true });
    try { if (JSON.parse(fs.readFileSync(stateFile(port), "utf8")).pid === process.pid) fs.unlinkSync(stateFile(port)); } catch {}
    server.close();
    setTimeout(() => process.exit(0), 200);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ---------------------------------------------------------------------------------------------------------------
// Client commands

async function control(args, name, commandArgs = {}) {
  const port = Number(args.port || DEFAULT_PORT);
  let state;
  try { state = JSON.parse(fs.readFileSync(stateFile(port), "utf8")); }
  catch { throw new Error(`No bridge is running on port ${port}. Start one: node tools/frontend-bridge/bridge.mjs serve --root <your checkout>`); }
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/control`, { method: "POST", headers: { "Content-Type": "application/json", "x-bridge-token": state.token }, body: JSON.stringify({ name, args: commandArgs }) });
  } catch { throw new Error(`The bridge on port ${port} is not answering. Start it again.`); }
  const body = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
  if (!body.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body.value;
}

const ago = (ms) => { const s = Math.round((Date.now() - ms) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };
const DRIFT = {
  "same": "", "new": "new file",
  "dev-differs": "WARNING: dev serves a different version than your base; the override also replaces those differences",
  "missing-on-dev": "WARNING: your base has this file but dev does not",
  "unknown": "could not read dev's copy"
};

function printStatus(value) {
  console.log(`Bridge 127.0.0.1:${value.port}${value.paused ? " (PAUSED)" : ""}  ·  ${value.root}`);
  console.log(`Base ${value.base.slice(0, 10)} (merge-base of HEAD and ${value.base_ref})  ·  site ${value.site}`);
  const extension = value.extension;
  console.log(extension.connected ? `Extension connected: ${extension.browser || "Chrome"}, ${extension.tabs?.length || 0} dev tab(s)${(extension.tabs || []).map((tab) => `\n  tab ${tab.id}${tab.active ? " (active)" : ""}: ${tab.url}`).join("")}` : "Extension NOT connected (install/enable FirstMate Dev Bridge in Chrome; it connects within 30 s).");
  console.log(`Extension folder: ${value.extension_folders.join(", ")}`);
  if (extension.missing?.length) console.log(`WARNING: the extension cannot see ${extension.missing.length} override(s) there. Restart the bridge with --extension <the folder you loaded in chrome://extensions>.`);
  console.log(`\nOverriding ${value.overrides.length} file(s) on ${value.site}:`);
  for (const record of value.overrides) {
    const drift = DRIFT[record.drift] ? `  ${DRIFT[record.drift]}` : "";
    console.log(`  /${record.path}  rev ${record.rev}  ${record.hits ? `served ${record.hits.count}x, last ${ago(record.hits.last)}` : "not requested yet"}${drift}`);
  }
  if (value.live.length) console.log(`\nAlready identical on dev (not overridden):\n  ${value.live.join("\n  ")}`);
  if (value.pending_deploy.length) console.log(`\nChanged but NOT live through the bridge (needs a dev rollout):\n${value.pending_deploy.map((entry) => `  ${entry.path}  (${entry.role})`).join("\n")}`);
}

async function readCode(args) {
  if (args.file) return fs.readFileSync(String(args.file), "utf8");
  if (args._[1] === "-" || (!args._[1] && !process.stdin.isTTY)) { let text = ""; for await (const chunk of process.stdin) text += chunk; return text; }
  return args._.slice(1).join(" ");
}

const USAGE = `FirstMate frontend bridge

  node tools/frontend-bridge/bridge.mjs serve [--root <checkout>] [--port 5747] [--base <ref>] [--extension <unpacked folder>]
  node tools/frontend-bridge/bridge.mjs status [--json]
  node tools/frontend-bridge/bridge.mjs tabs
  node tools/frontend-bridge/bridge.mjs eval "<js expression or statements>" [--tab <id>] [--frame <url part>] [--all-frames] [--timeout 30]
  node tools/frontend-bridge/bridge.mjs eval --file snippet.js
  node tools/frontend-bridge/bridge.mjs console [--level error|warn|info|log] [--limit 50] [--clear] [--tab <id>]
  node tools/frontend-bridge/bridge.mjs reload [--tab <id>]
  node tools/frontend-bridge/bridge.mjs navigate <path or https://dev.1m8.ai/...> [--tab <id>]
  node tools/frontend-bridge/bridge.mjs screenshot [--out file.png] [--tab <id>]
  node tools/frontend-bridge/bridge.mjs pause | resume | refresh

See docs/architecture/frontend-bridge.md.`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const name = args._[0];
  const tab = args.tab !== undefined ? Number(args.tab) : undefined;
  if (!name || name === "help" || args.help) { console.log(USAGE); return; }
  if (name === "serve") return serve(args);
  if (name === "status" || name === "pause" || name === "resume" || name === "refresh") {
    const value = await control(args, name);
    if (args.json) console.log(JSON.stringify(value, null, 2)); else printStatus(value);
    return;
  }
  if (name === "tabs") { console.log(JSON.stringify(await control(args, "tabs"), null, 2)); return; }
  if (name === "reload") { console.log(JSON.stringify(await control(args, "reload", { tab }))); return; }
  if (name === "navigate") { console.log(JSON.stringify(await control(args, "navigate", { tab, url: args._[1] }))); return; }
  if (name === "eval") {
    const code = await readCode(args);
    if (!code.trim()) throw new Error("Nothing to evaluate.");
    const timeout = Number(args.timeout || 30);
    const value = await control(args, "eval", { tab, frame: args.frame, allFrames: !!args["all-frames"], code, timeout });
    console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
    return;
  }
  if (name === "console") {
    const entries = await control(args, "console", { tab, level: args.level, limit: Number(args.limit || 50), clear: !!args.clear });
    if (args.json) { console.log(JSON.stringify(entries, null, 2)); return; }
    for (const entry of entries) console.log(`${new Date(entry.t).toLocaleTimeString()} ${entry.level.toUpperCase().padEnd(5)} ${entry.frame && entry.frame !== "top" ? `[${entry.frame}] ` : ""}${entry.text}`);
    if (!entries.length) console.log("(no console entries)");
    return;
  }
  if (name === "screenshot") {
    const value = await control(args, "screenshot", { tab });
    const out = path.resolve(String(args.out || path.join(os.tmpdir(), `firstmate-bridge-${Date.now()}.png`)));
    fs.writeFileSync(out, Buffer.from(String(value.dataUrl).split(",")[1], "base64"));
    console.log(out);
    return;
  }
  throw new Error(`Unknown command "${name}".\n\n${USAGE}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
