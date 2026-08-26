import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ProviderKeyFile = {
  google?: {
    shared_api_key?: string;
    browser_api_key?: string;
    customer_browser_api_key?: string;
    internal_browser_api_key?: string;
    territory_browser_api_key?: string;
    server_api_key?: string;
    solar_api_key?: string;
    maps_static_api_key?: string;
    map_tiles_api_key?: string;
    places_api_key?: string;
  };
  gemini?: {
    api_key?: string;
  };
  azure?: {
    maps_subscription_key?: string;
  };
  application?: {
    internal_api_secret?: string;
  };
};

export type GoogleKeyPurpose = "browser" | "browser_customer" | "browser_internal" | "browser_territory" | "server" | "solar" | "maps_static" | "map_tiles" | "places";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

function findProjectRoot(startDirectory: string) {
  let current = path.resolve(startDirectory);
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(path.join(current, "public", "v1", "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return "";
}

export function resolveProviderKeysPath(moduleDirectory = MODULE_DIR, workingDirectory = process.cwd()) {
  const explicit = String(process.env.PROVIDER_KEYS_PATH ?? "").trim();
  if (explicit) return path.resolve(workingDirectory, explicit);
  const projectRoot = findProjectRoot(moduleDirectory) || findProjectRoot(workingDirectory);
  if (projectRoot) return path.join(projectRoot, "private", "provider-keys.json");
  return path.resolve(workingDirectory, "../../private/provider-keys.json");
}

const PROVIDER_KEYS_PATH = resolveProviderKeysPath();

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function loadProviderKeyFile(): ProviderKeyFile {
  try {
    const parsed = JSON.parse(readFileSync(PROVIDER_KEYS_PATH, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as ProviderKeyFile : {};
  } catch {
    return {};
  }
}

const fileKeys = loadProviderKeyFile();

export function resolveGoogleProviderKey(config: ProviderKeyFile, purpose: GoogleKeyPurpose = "server") {
  const google = config.google ?? {};
  const names: Record<GoogleKeyPurpose, keyof NonNullable<ProviderKeyFile["google"]>> = {
    browser: "browser_api_key",
    browser_customer: "customer_browser_api_key",
    browser_internal: "internal_browser_api_key",
    browser_territory: "territory_browser_api_key",
    server: "server_api_key",
    solar: "solar_api_key",
    maps_static: "maps_static_api_key",
    map_tiles: "map_tiles_api_key",
    places: "places_api_key"
  };
  return clean(google[names[purpose]])
    || (purpose.startsWith("browser") ? clean(google.browser_api_key) : clean(google.server_api_key))
    || clean(google.shared_api_key);
}

export function googleProviderKey(purpose: GoogleKeyPurpose = "server") {
  return resolveGoogleProviderKey(fileKeys, purpose);
}

export function resolveAzureMapsProviderKey(config: ProviderKeyFile) {
  return clean(config.azure?.maps_subscription_key);
}

export function geminiProviderKey() {
  return clean(fileKeys.gemini?.api_key);
}

export function azureMapsProviderKey() {
  return resolveAzureMapsProviderKey(fileKeys);
}

export function internalApiSecret() {
  return clean(fileKeys.application?.internal_api_secret);
}

export { PROVIDER_KEYS_PATH };
