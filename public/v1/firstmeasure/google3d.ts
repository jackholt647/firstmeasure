import crypto from "node:crypto";
import path from "node:path";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";

import { FirstMeasureError, badRequest, notFound } from "./errors.js";
import { projectDir } from "./storage.js";
import { env } from "../src/config/env.js";

const GOOGLE_3D_DIR_NAME = "google_3d";
const GOOGLE_3D_TILES_DIR_NAME = "tiles";
const DEFAULT_CAPTURE_RADIUS_METERS = 100;
const MIN_CAPTURE_RADIUS_METERS = 80;
const MAX_CAPTURE_RADIUS_METERS = 180;
const DEFAULT_MAX_DEPTH = 40;
const DOWNLOAD_CONCURRENCY = 6;
const FALLBACK_TILE_LIMIT = 24;

const captureLocks = new Map<string, Promise<Google3dManifest>>();

export type Google3dTileEntry = {
  file: string;
  sourcePath: string;
  geometricError: number;
  distanceMeters: number;
  depth: number;
  bytes: number;
};

export type Google3dManifest = {
  generatedAt: string;
  source: string;
  anchor: {
    name: string;
    lat: number;
    lon: number;
    radiusMeters: number;
  };
  capture: {
    maxDepth: number;
    deepestLeafCount: number;
  };
  tiles: Google3dTileEntry[];
};

type CaptureGoogle3dInput = {
  projectId: string;
  address: string;
  lat: number;
  lon: number;
  radiusMeters?: number | null;
  maxDepth?: number;
  force?: boolean;
};

type TileNode = {
  boundingVolume?: {
    box?: number[];
  };
  children?: TileNode[];
  content?: {
    uri?: string;
  };
  geometricError?: number;
};

type SelectedLeafTile = {
  url: string;
  depth: number;
  geometricError: number;
  distanceMeters: number;
};

type ProjectGoogle3dTileFile = {
  name: string;
  content: Buffer;
};

type EcefPoint = {
  x: number;
  y: number;
  z: number;
};

export function buildProjectGoogle3dManifestRoute(projectId: string) {
  return `/projects/${encodeURIComponent(projectId)}/google-3d/manifest.json`;
}

export async function projectGoogle3dCaptureExists(projectId: string) {
  try {
    await stat(projectGoogle3dManifestPath(projectId));
    return true;
  } catch {
    return false;
  }
}

export async function readProjectGoogle3dManifest(projectId: string): Promise<Google3dManifest> {
  const raw = await readFile(projectGoogle3dManifestPath(projectId), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw notFound("google_3d_manifest_not_found", `Google 3D tiles have not been captured for project '${projectId}'.`);
    }
    throw error;
  });

  return JSON.parse(raw) as Google3dManifest;
}

export async function readProjectGoogle3dTile(projectId: string, fileName: string): Promise<ProjectGoogle3dTileFile> {
  const safeName = sanitizeProjectGoogle3dTileName(fileName);
  const filePath = path.join(projectGoogle3dTilesDir(projectId), safeName);
  const content = await readFile(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw notFound("google_3d_tile_not_found", `Google 3D tile '${safeName}' was not found for project '${projectId}'.`);
    }
    throw error;
  });

  return {
    name: safeName,
    content
  };
}

export async function ensureProjectGoogle3dCapture(input: CaptureGoogle3dInput): Promise<Google3dManifest> {
  const projectId = input.projectId;
  if (!input.force) {
    const existing = await readExistingProjectGoogle3dManifest(projectId);
    if (existing) return existing;
  }

  const googleApiKey = String(env.googleMapTilesApiKey ?? "").trim();
  if (!googleApiKey) {
    throw badRequest("missing_google_api_key", "The server Google Map Tiles credential is not configured.");
  }

  if (!Number.isFinite(input.lat) || !Number.isFinite(input.lon)) {
    throw badRequest("missing_project_coordinates", "Project coordinates are required to capture Google 3D tiles.");
  }

  const existingLock = captureLocks.get(projectId);
  if (existingLock) return existingLock;

  const capturePromise = (async () => {
    const outputDir = projectGoogle3dCaptureDir(projectId);
    const tilesDir = projectGoogle3dTilesDir(projectId);
    const radiusMeters = normalizeCaptureRadius(input.radiusMeters);
    const maxDepth = Number.isFinite(input.maxDepth) && Number(input.maxDepth) > 0
      ? Math.min(60, Math.floor(Number(input.maxDepth)))
      : DEFAULT_MAX_DEPTH;

    if (input.force) {
      await rm(outputDir, { recursive: true, force: true });
    }
    await mkdir(tilesDir, { recursive: true });

    const ecefTarget = geodeticToECEF(input.lat, input.lon, 0);
    const rootUrl = makeAbsoluteGoogleTileUrl("/v1/3dtiles/root.json", googleApiKey);
    const rootTileset = await fetchJson(rootUrl) as { root?: TileNode };
    if (!rootTileset?.root) {
      throw new FirstMeasureError(
        "google_3d_root_tileset_invalid",
        502,
        "Google 3D tiles returned an invalid root tileset."
      );
    }

    const queue: Array<{ tile: TileNode; depth: number; session: string | null }> = [
      { tile: rootTileset.root, depth: 0, session: null }
    ];
    const jsonVisited = new Set([cleanUrlForHash(rootUrl)]);
    const selectedLeafTiles: SelectedLeafTile[] = [];
    const fallbackContentTiles: SelectedLeafTile[] = [];

    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      const { tile, depth, session } = next;

      if (!intersectsTarget(tile, ecefTarget, radiusMeters)) continue;

      const children = normalizeChildren(tile.children);
      let nextSession = session;
      if (tile.content?.uri) {
        const preview = new URL(makeAbsoluteGoogleTileUrl(tile.content.uri, googleApiKey, session));
        if (preview.searchParams.has("session")) {
          nextSession = preview.searchParams.get("session");
        }
      }

      if (tile.content?.uri) {
        const contentUrl = makeAbsoluteGoogleTileUrl(tile.content.uri, googleApiKey, session);
        if (contentUrl.includes(".json")) {
          const marker = cleanUrlForHash(contentUrl);
          if (!jsonVisited.has(marker)) {
            jsonVisited.add(marker);
            const externalTileset = await fetchJson(contentUrl).catch(() => null) as { root?: TileNode } | null;
            if (externalTileset?.root) {
              queue.push({ tile: externalTileset.root, depth: depth + 1, session: nextSession });
            }
          }
        } else if (!(children.length > 0 && depth < maxDepth)) {
          selectedLeafTiles.push({
            url: contentUrl,
            depth,
            geometricError: Number(tile.geometricError ?? 0),
            distanceMeters: tileDistanceMeters(tile, ecefTarget)
          });
        } else {
          fallbackContentTiles.push({
            url: contentUrl,
            depth,
            geometricError: Number(tile.geometricError ?? 0),
            distanceMeters: tileDistanceMeters(tile, ecefTarget)
          });
        }
      }

      if (children.length > 0 && depth < maxDepth) {
        for (const child of children) {
          queue.push({ tile: child, depth: depth + 1, session: nextSession });
        }
      }
    }

    const uniqueLeaves = uniqueGoogle3dTiles(selectedLeafTiles);
    const tilesToDownload = uniqueLeaves.length > 0
      ? uniqueLeaves
      : uniqueGoogle3dTiles(fallbackContentTiles)
        .filter(tile => !contentUrlLooksLikeJson(tile.url))
        .sort((a, b) => {
          if (a.depth !== b.depth) return b.depth - a.depth;
          if (a.geometricError !== b.geometricError) return a.geometricError - b.geometricError;
          return a.distanceMeters - b.distanceMeters;
        })
        .slice(0, FALLBACK_TILE_LIMIT);

    if (!tilesToDownload.length) {
      throw new FirstMeasureError(
        "google_3d_tiles_not_found",
        404,
        "Google 3D tiles could not be resolved for this property."
      );
    }

    const manifestTiles: Google3dTileEntry[] = new Array(tilesToDownload.length);
    let nextIndex = 0;

    async function downloadWorker() {
      while (nextIndex < tilesToDownload.length) {
        const myIndex = nextIndex;
        nextIndex += 1;
        const tile = tilesToDownload[myIndex];
        if (!tile) continue;
        const { buffer, contentType } = await fetchBinary(tile.url);
        const parsed = new URL(tile.url);
        const hash = crypto
          .createHash("sha1")
          .update(cleanUrlForHash(tile.url))
          .digest("hex")
          .slice(0, 16);
        const filename = `${String(myIndex + 1).padStart(4, "0")}-${hash}${extFromPath(parsed.pathname, contentType)}`;
        await writeFile(path.join(tilesDir, filename), buffer);

        manifestTiles[myIndex] = {
          file: filename,
          sourcePath: parsed.pathname,
          geometricError: tile.geometricError,
          distanceMeters: tile.distanceMeters,
          depth: tile.depth,
          bytes: buffer.length
        };
      }
    }

    await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, tilesToDownload.length) }, () => downloadWorker()));

    const manifest: Google3dManifest = {
      generatedAt: new Date().toISOString(),
      source: "Google Photorealistic 3D Tiles",
      anchor: {
        name: input.address,
        lat: input.lat,
        lon: input.lon,
        radiusMeters
      },
      capture: {
        maxDepth,
        deepestLeafCount: manifestTiles.length
      },
      tiles: manifestTiles
    };

    await writeFile(projectGoogle3dManifestPath(projectId), JSON.stringify(manifest, null, 2));
    return manifest;
  })().catch((error) => {
    if (error instanceof FirstMeasureError) {
      throw error;
    }
    throw new FirstMeasureError(
      "google_3d_capture_failed",
      502,
      error instanceof Error && error.message
        ? error.message
        : "Google 3D tile capture failed."
    );
  }).finally(() => {
    captureLocks.delete(projectId);
  });

  captureLocks.set(projectId, capturePromise);
  return capturePromise;
}

function uniqueGoogle3dTiles(tiles: SelectedLeafTile[]) {
  return Array.from(
    tiles.reduce((map, tile) => {
      const key = cleanUrlForHash(tile.url);
      if (!map.has(key)) map.set(key, tile);
      return map;
    }, new Map<string, SelectedLeafTile>()).values()
    ).sort((a, b) => {
      if (a.geometricError !== b.geometricError) return a.geometricError - b.geometricError;
      return a.distanceMeters - b.distanceMeters;
    });
}

function contentUrlLooksLikeJson(url: string) {
  return new URL(url).pathname.toLowerCase().endsWith(".json");
}

function projectGoogle3dCaptureDir(projectId: string) {
  return path.join(projectDir(projectId), GOOGLE_3D_DIR_NAME);
}

function projectGoogle3dTilesDir(projectId: string) {
  return path.join(projectGoogle3dCaptureDir(projectId), GOOGLE_3D_TILES_DIR_NAME);
}

function projectGoogle3dManifestPath(projectId: string) {
  return path.join(projectGoogle3dCaptureDir(projectId), "manifest.json");
}

async function readExistingProjectGoogle3dManifest(projectId: string) {
  try {
    return await readProjectGoogle3dManifest(projectId);
  } catch {
    return null;
  }
}

function sanitizeProjectGoogle3dTileName(fileName: string) {
  const baseName = path.basename(String(fileName ?? "").trim());
  if (!baseName || baseName === "." || baseName === "..") {
    throw badRequest("invalid_google_3d_tile_name", "A valid Google 3D tile file name is required.");
  }
  return baseName;
}

function normalizeCaptureRadius(value?: number | null) {
  if (!Number.isFinite(value) || Number(value) <= 0) {
    return DEFAULT_CAPTURE_RADIUS_METERS;
  }
  return Math.max(MIN_CAPTURE_RADIUS_METERS, Math.min(MAX_CAPTURE_RADIUS_METERS, Number(value)));
}

function geodeticToECEF(latDeg: number, lonDeg: number, hMeters = 0): EcefPoint {
  const a = 6378137.0;
  const e2 = 6.69437999014e-3;
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);
  const n = a / Math.sqrt(1 - e2 * sinLat * sinLat);
  return {
    x: (n + hMeters) * cosLat * cosLon,
    y: (n + hMeters) * cosLat * sinLon,
    z: (n * (1 - e2) + hMeters) * sinLat
  };
}

function boxToSphere(box: number[]) {
  return {
    x: box[0] ?? 0,
    y: box[1] ?? 0,
    z: box[2] ?? 0,
    r:
      Math.hypot(box[3] ?? 0, box[4] ?? 0, box[5] ?? 0) +
      Math.hypot(box[6] ?? 0, box[7] ?? 0, box[8] ?? 0) +
      Math.hypot(box[9] ?? 0, box[10] ?? 0, box[11] ?? 0)
  };
}

function intersectsTarget(tile: TileNode | undefined, ecefTarget: EcefPoint, radiusMeters: number) {
  if (!tile?.boundingVolume?.box) return true;
  const sphere = boxToSphere(tile.boundingVolume.box);
  const distance = Math.hypot(
    sphere.x - ecefTarget.x,
    sphere.y - ecefTarget.y,
    sphere.z - ecefTarget.z
  );
  return distance <= sphere.r + radiusMeters;
}

function tileDistanceMeters(tile: TileNode | undefined, ecefTarget: EcefPoint) {
  if (!tile?.boundingVolume?.box) return Number.POSITIVE_INFINITY;
  const sphere = boxToSphere(tile.boundingVolume.box);
  return Math.hypot(
    sphere.x - ecefTarget.x,
    sphere.y - ecefTarget.y,
    sphere.z - ecefTarget.z
  );
}

function makeAbsoluteGoogleTileUrl(input: string, googleApiKey: string, inheritedSession: string | null = null) {
  const base = new URL("https://tile.googleapis.com");
  const url = new URL(input, base);
  if (!url.searchParams.has("session") && inheritedSession) {
    url.searchParams.set("session", inheritedSession);
  }
  if (url.hostname === "tile.googleapis.com" && !url.searchParams.has("key")) {
    url.searchParams.set("key", googleApiKey);
  }
  return url.toString();
}

async function fetchJson(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch JSON ${url} (${response.status})`);
  }
  return response.json();
}

async function fetchBinary(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch tile ${url} (${response.status})`);
  }
  return {
    contentType: response.headers.get("content-type") || "application/octet-stream",
    buffer: Buffer.from(await response.arrayBuffer())
  };
}

function normalizeChildren(children: TileNode[] | undefined) {
  return Array.isArray(children) ? children : [];
}

function cleanUrlForHash(url: string) {
  const parsed = new URL(url);
  parsed.searchParams.delete("key");
  return `${parsed.pathname}?${parsed.searchParams.toString()}`;
}

function extFromPath(pathname: string, fallbackContentType: string) {
  const ext = path.extname(pathname);
  if (ext) return ext;
  if (fallbackContentType.includes("gltf")) return ".glb";
  if (fallbackContentType.includes("json")) return ".json";
  return ".bin";
}
