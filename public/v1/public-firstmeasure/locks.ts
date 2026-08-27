import { createHash, randomBytes } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { PlatformError } from "../platform/errors.js";
import { env } from "../src/config/env.js";
import { isFirstMeasurePostgresEnabled } from "../src/database/postgres.js";
import { acquireFirstMeasureLock } from "../firstmeasure/locks.js";

type PublicFirstMeasureLockOptions = {
  timeoutMs?: number;
  staleMs?: number;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_STALE_MS = 60 * 60_000;

function lockRoot() {
  return path.resolve(process.cwd(), env.platformStorageRoot, ".locks", "public_firstmeasure");
}

function lockPath(resource: string) {
  const digest = createHash("sha256").update(resource).digest("hex");
  return path.join(lockRoot(), digest);
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function acquirePublicFirstMeasureLock(
  resource: string,
  options: PublicFirstMeasureLockOptions = {}
) {
  if (isFirstMeasurePostgresEnabled()) {
    try {
      return await acquireFirstMeasureLock(`public-firstmeasure:${resource}`, {
        ttlMs: Math.max(30_000, options.staleMs ?? DEFAULT_STALE_MS),
        waitMs: Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        retryMs: 25
      });
    } catch (error) {
      if (String((error as Error)?.message ?? "").includes("Timed out waiting for lock")) {
        throw new PlatformError("public_firstmeasure_busy", 503, "This customer API resource is busy. Retry the request shortly.");
      }
      throw error;
    }
  }
  const root = lockRoot();
  const target = lockPath(resource);
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const staleMs = Math.max(timeoutMs * 2, options.staleMs ?? DEFAULT_STALE_MS);
  const startedAt = Date.now();
  await mkdir(root, { recursive: true });

  while (true) {
    try {
      await mkdir(target);
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await rm(target, { recursive: true, force: true });
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const contentionCodes = process.platform === "win32"
        ? new Set(["EEXIST", "EPERM", "EACCES"])
        : new Set(["EEXIST"]);
      if (!code || !contentionCodes.has(code)) throw error;

      const info = await stat(target).catch(() => null);
      if (info && Date.now() - info.mtimeMs > staleMs) {
        const confirmed = await stat(target).catch(() => null);
        if (!confirmed || Date.now() - confirmed.mtimeMs <= staleMs) continue;
        const staleTarget = `${target}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
        const claimed = await rename(target, staleTarget).then(() => true).catch(() => false);
        if (claimed) await rm(staleTarget, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new PlatformError(
          "public_firstmeasure_busy",
          503,
          "This customer API resource is busy. Retry the request shortly."
        );
      }
      await delay(10 + Math.floor(Math.random() * 25));
    }
  }
}

export async function withPublicFirstMeasureLock<T>(
  resource: string,
  operation: () => Promise<T>,
  options: PublicFirstMeasureLockOptions = {}
) {
  const release = await acquirePublicFirstMeasureLock(resource, options);
  try {
    return await operation();
  } finally {
    await release();
  }
}
