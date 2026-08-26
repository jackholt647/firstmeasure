import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { env } from "../src/config/env.js";
import { resolveFirstMeasureStorageRoot } from "./storage.js";

type AppleKeyStore = {
  key: string;
  updated_at_utc: string | null;
  tile_version: number;
};

const DEFAULT_APPLE_MAPS_TILE_VERSION = 10401;

function appleKeyPath() {
  return path.join(resolveFirstMeasureStorageRoot(), "apple_key.json");
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

function uniquePaths(paths: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawPath of paths) {
    if (!rawPath) continue;
    const resolved = path.resolve(rawPath);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function possiblePublicRoots() {
  return uniquePaths([
    process.cwd(),
    path.resolve(process.cwd(), ".."),
    path.resolve(MODULE_DIR, ".."),
    path.resolve(MODULE_DIR, "..", ".."),
    path.resolve(MODULE_DIR, "..", "..", "..")
  ]);
}

function legacyAppleKeyPaths() {
  const configuredPath = process.env.FIRSTMEASURE_LEGACY_APPLE_KEY_PATH?.trim();
  const paths = [configuredPath || null];

  for (const publicRoot of possiblePublicRoots()) {
    paths.push(
      path.join(publicRoot, "storage", "measure", "internal", "config", "apple_key.json"),
      path.join(publicRoot, "measure-dev", "internal", "storage", "config", "apple_key.json"),
      path.join(publicRoot, "measure", "internal", "storage", "config", "apple_key.json"),
      path.join(publicRoot, "measure-dev", "internal", "apple_key.json"),
      path.join(publicRoot, "measure", "internal", "apple_key.json")
    );
  }

  return uniquePaths(paths);
}

function appleKeyReadPaths() {
  return uniquePaths([
    appleKeyPath(),
    ...legacyAppleKeyPaths(),
    path.resolve(process.cwd(), env.internalStorageRoot, "state", "config", "apple_key.json"),
    ...possiblePublicRoots().map((publicRoot) =>
      path.join(publicRoot, "v1", env.internalStorageRoot, "state", "config", "apple_key.json")
    )
  ]);
}

function appleKeyLogPath() {
  return path.join(resolveFirstMeasureStorageRoot(), "logs", "apple_key_ingest.ndjson");
}

export async function readAppleKeyStore(): Promise<AppleKeyStore> {
  let fallback: AppleKeyStore | null = null;
  let freshest: { store: AppleKeyStore; ts: number } | null = null;

  for (const candidatePath of appleKeyReadPaths()) {
    const store = await readAppleKeyStoreAt(candidatePath);
    if (!store.key) continue;

    fallback ??= store;
    const ts = Date.parse(store.updated_at_utc ?? "");
    if (Number.isFinite(ts) && (!freshest || ts > freshest.ts)) {
      freshest = { store, ts };
    }
  }

  if (freshest) return freshest.store;
  if (fallback) return fallback;

  return {
    key: "",
    updated_at_utc: null,
    tile_version: DEFAULT_APPLE_MAPS_TILE_VERSION
  };
}

export async function getAppleKeyInfo() {
  const store = await readAppleKeyStore();
  return {
    has_key: store.key.length > 0,
    key_preview: store.key ? `${store.key.slice(0, 6)}...${store.key.slice(-4)}` : null,
    updated_at_utc: store.updated_at_utc,
    tile_version: store.tile_version
  };
}

export async function setAppleKey(input: { key?: string; url?: string; tile_version?: number; actor?: Record<string, unknown> }) {
  const current = await readAppleKeyStore();
  const hasNewKey = Boolean(String(input.key ?? "").trim() || String(input.url ?? "").trim());
  const extracted = hasNewKey ? extractAppleKey(input.key, input.url) : current.key;
  if (!extracted) throw new Error("missing_apple_key");
  const nowUtc = new Date().toISOString();
  const store: AppleKeyStore = {
    key: extracted,
    updated_at_utc: hasNewKey ? nowUtc : current.updated_at_utc,
    tile_version: normalizeTileVersion(input.tile_version ?? current.tile_version)
  };

  await writeAppleKeyStore(appleKeyPath(), store);
  await mirrorAppleKeyStoreToLegacyPaths(store);
  await appendAppleKeyAudit({
    ts_utc: nowUtc,
    actor: input.actor ?? null,
    from_url: Boolean(input.url),
    tile_version: store.tile_version,
    key_changed: hasNewKey,
    key_preview: `${extracted.slice(0, 6)}...${extracted.slice(-4)}`
  });

  return getAppleKeyInfo();
}

async function readAppleKeyStoreAt(filePath: string): Promise<AppleKeyStore> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<AppleKeyStore> & {
      data?: Partial<AppleKeyStore>;
    };
    const source = parsed.data && typeof parsed.data === "object" ? parsed.data : parsed;
    return {
      key: typeof source.key === "string" ? source.key.trim() : "",
      updated_at_utc: typeof source.updated_at_utc === "string" ? source.updated_at_utc : null,
      tile_version: normalizeTileVersion(source.tile_version)
    };
  } catch {
    return {
      key: "",
      updated_at_utc: null,
      tile_version: DEFAULT_APPLE_MAPS_TILE_VERSION
    };
  }
}

function normalizeTileVersion(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 999999999
    ? parsed
    : DEFAULT_APPLE_MAPS_TILE_VERSION;
}

async function writeAppleKeyStore(filePath: string, store: AppleKeyStore) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(store, null, 2));
}

async function mirrorAppleKeyStoreToLegacyPaths(store: AppleKeyStore) {
  await Promise.all(
    legacyAppleKeyPaths().map(async (candidatePath) => {
      if (!(await pathExists(candidatePath))) return;
      await writeAppleKeyStore(candidatePath, store).catch(() => undefined);
    })
  );
}

async function pathExists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function extractAppleKey(rawKey?: string, rawUrl?: string) {
  const direct = String(rawKey ?? "").trim();
  if (direct) {
    validateAppleKey(direct);
    return direct;
  }

  const sourceUrl = String(rawUrl ?? "").trim();
  if (!sourceUrl) {
    throw new Error("missing_apple_key");
  }

  const query = new URL(sourceUrl).search.replace(/^\?/, "");
  const parts = query.split("&").filter(Boolean);
  const lastPart = parts[parts.length - 1] ?? "";
  const [lastName, ...lastValueParts] = lastPart.split("=");
  const fromParam = lastName === "accessKey" ? decodeURIComponent(lastValueParts.join("=")) : "";
  const key = fromParam.trim();
  validateAppleKey(key);
  return key;
}

function validateAppleKey(key: string) {
  if (!key || key.length < 8 || key.length > 512) {
    throw new Error("invalid_apple_key_length");
  }
  if (!/^[A-Za-z0-9\-\._~%+=:/]+$/.test(key)) {
    throw new Error("invalid_apple_key_characters");
  }
}

async function appendAppleKeyAudit(entry: Record<string, unknown>) {
  const logPath = appleKeyLogPath();
  await mkdir(path.dirname(logPath), { recursive: true });
  await writeFile(logPath, `${JSON.stringify(entry)}\n`, {
    flag: "a"
  });
}
