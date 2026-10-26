#!/usr/bin/env node
// Packages tools/frontend-bridge/extension as a zip to unpack and "Load unpacked" in Chrome
// (docs/architecture/frontend-bridge.md). Usage: node tools/frontend-bridge/package.mjs [out-dir]
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8"));
const outDir = path.resolve(process.argv[2] || path.join(here, "../../output/frontend-bridge"));
const name = `firstmate-dev-bridge-${manifest.version}`;

const files = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if ((entry.name === "overrides" && dir === source) || entry.name.startsWith(".")) continue; // overrides/ is written by a running bridge
    if (entry.isDirectory()) walk(full); else files.push(full);
  }
};
walk(source);

// A plain zip (deflate, no data descriptors), all entries under one folder named after the release.
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const locals = [], centrals = [];
let offset = 0;
for (const file of files) {
  const data = fs.readFileSync(file);
  const packed = zlib.deflateRawSync(data, { level: 9 });
  const entryName = Buffer.from(`${name}/${path.relative(source, file).split(path.sep).join("/")}`);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(entryName.length, 26); local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(0, 12); central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(entryName.length, 28); central.writeUInt32LE(offset, 42);
  locals.push(local, entryName, packed);
  centrals.push(central, entryName);
  offset += local.length + entryName.length + packed.length;
}
const centralSize = centrals.reduce((sum, buf) => sum + buf.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);

fs.mkdirSync(outDir, { recursive: true });
const zipPath = path.join(outDir, `${name}.zip`);
fs.writeFileSync(zipPath, Buffer.concat([...locals, ...centrals, end]));
// The same files unpacked, ready for chrome://extensions > Load unpacked.
const unpacked = path.join(outDir, name);
fs.rmSync(unpacked, { recursive: true, force: true });
for (const file of files) {
  const target = path.join(unpacked, path.relative(source, file));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(file, target);
}
console.log(`${zipPath}\n${unpacked}`);
