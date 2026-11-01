import { randomBytes } from "node:crypto";
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * A save uploads many files at once and each upload rewrites manifest.json. A
 * plain write empties the file first, so a request reading it at that moment
 * saw no project and answered "Tutorial project not found" (FM-318). Readers
 * must only ever see a whole file, so write beside it and rename over it. A
 * folder the service cannot create files in (PHP-owned) keeps the in-place write.
 */
export async function writeJsonFileAtomic(filePath: string, data: unknown) {
  const content = `${JSON.stringify(data, null, 2)}\n`;
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, content, "utf8");
    // PHP writes these files too: the replacement keeps the mode (and ACL mask) of the file it replaces.
    const existing = await stat(filePath).catch(() => null);
    if (existing) await chmod(temporary, existing.mode & 0o777);
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    if (!isTutorialStoragePermissionError(error)) throw error;
    await writeFile(filePath, content, "utf8");
  }
}

export function isTutorialStoragePermissionError(error: unknown) {
  return ["EACCES", "EPERM"].includes(String((error as NodeJS.ErrnoException | undefined)?.code ?? ""));
}
