import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { badRequest, notFound } from "../platform/errors.js";
import { sha256 } from "./canonical.js";
import type { Author } from "./contracts.js";
import { librarySource, snapshotDir } from "./library.js";
import { libraryStore } from "./store.js";

/**
 * Library assets: the images a default uses (tab and app marketing media, template artwork). Content-addressed by
 * sha256, so an asset never changes and is served with an immutable cache; an entry names assets by `asset:<sha256>`
 * and the browser loads them from `/v1/config-library/assets/<sha256>`. Only safe image types are taken (no SVG: it
 * can carry script). The snapshot keeps them under `snapshot/_assets/`.
 */

export const ASSET_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" };
export const MAX_ASSET_BYTES = 5 * 1024 * 1024;
export const assetUrl = (hash: string) => `/v1/config-library/assets/${hash}`;
export const ASSET_REF = /^asset:([0-9a-f]{64})$/;

/** Every `asset:<sha256>` reference anywhere in a value. */
export function assetRefs(value: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown) => {
    if (typeof node === "string") { const match = ASSET_REF.exec(node); if (match) found.add(match[1]!); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === "object") Object.values(node).forEach(walk);
  };
  walk(value);
  return [...found];
}

function sniff(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (bytes.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (bytes.subarray(4, 12).toString("latin1") === "ftypavif") return "image/avif";
  return "";
}

export async function putAsset(input: { bytes: Buffer; file_name?: string }, author: Author) {
  const { libraryWritable } = await import("./library.js");
  if (!libraryWritable()) throw badRequest("config_library_read_only", "Library assets are uploaded on the development data environment only.");
  if (!input.bytes.length || input.bytes.length > MAX_ASSET_BYTES) throw badRequest("config_library_asset_size", `An asset is 1 byte to ${MAX_ASSET_BYTES / 1024 / 1024} MB.`);
  const contentType = sniff(input.bytes);
  if (!contentType) throw badRequest("config_library_asset_type", "Only PNG, JPEG, WebP, GIF and AVIF images are taken.");
  const hash = sha256(input.bytes);
  await libraryStore().prepare("INSERT INTO config_library_assets (sha256, content_type, size_bytes, file_name, data_base64, created_by, created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(sha256) DO NOTHING")
    .run(hash, contentType, input.bytes.length, String(input.file_name || "").slice(0, 200), input.bytes.toString("base64"), author.id, new Date().toISOString());
  return { sha256: hash, ref: `asset:${hash}`, url: assetUrl(hash), content_type: contentType, size_bytes: input.bytes.length };
}

type SnapshotAsset = { sha256: string; content_type: string; file_name: string; bytes: Buffer };
export function readSnapshotAssets(dir = snapshotDir()): SnapshotAsset[] {
  const indexFile = path.join(dir, "_assets", "index.json");
  if (!existsSync(indexFile)) return [];
  const index = JSON.parse(readFileSync(indexFile, "utf8")) as Array<{ sha256: string; content_type: string; file_name: string }>;
  const found: SnapshotAsset[] = [];
  for (const item of index) {
    const file = path.join(dir, "_assets", `${item.sha256}.${ASSET_TYPES[item.content_type] || "bin"}`);
    // A missing file never stops the library loading: the asset is just not available from this snapshot.
    if (!existsSync(file)) { console.warn(`Config library snapshot asset ${item.sha256} is missing from ${dir}.`); continue; }
    const bytes = readFileSync(file);
    if (sha256(bytes) !== item.sha256) throw new Error(`Config library snapshot asset ${item.sha256} does not match its hash.`);
    found.push({ ...item, bytes });
  }
  return found;
}

export async function readAsset(hash: string) {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw notFound("config_library_asset_missing", "No such asset.");
  if (librarySource() === "store") {
    const row = await libraryStore().prepare("SELECT content_type, data_base64 FROM config_library_assets WHERE sha256=?").get(hash);
    if (row) return { content_type: String(row.content_type), bytes: Buffer.from(String(row.data_base64), "base64") };
  }
  const found = readSnapshotAssets().find((item) => item.sha256 === hash);
  if (!found) throw notFound("config_library_asset_missing", "No such asset.");
  return { content_type: found.content_type, bytes: found.bytes };
}

export async function listAssets() {
  const rows = await libraryStore().prepare("SELECT sha256, content_type, size_bytes, file_name, created_by, created_at FROM config_library_assets ORDER BY created_at DESC").all();
  return rows.map((row) => ({ sha256: String(row.sha256), ref: `asset:${row.sha256}`, url: assetUrl(String(row.sha256)), content_type: String(row.content_type), size_bytes: Number(row.size_bytes), file_name: String(row.file_name || ""), created_by: String(row.created_by || ""), created_at: String(row.created_at) }));
}
export async function storeAssets(hashes?: string[]) {
  const rows = await libraryStore().prepare("SELECT * FROM config_library_assets ORDER BY sha256").all();
  return rows.filter((row) => !hashes || hashes.includes(String(row.sha256))).map((row) => ({ sha256: String(row.sha256), content_type: String(row.content_type), file_name: String(row.file_name || ""), bytes: Buffer.from(String(row.data_base64), "base64") }));
}
