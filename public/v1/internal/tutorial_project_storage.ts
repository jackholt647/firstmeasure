import { randomBytes } from "node:crypto";
import { access, chmod, cp, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

const TUTORIAL_PROJECT_FILES = ["manifest.json", "answer_key.json", "metadata.json", "pdf_state.json"];

export type TutorialPathWritable = (target: string) => Promise<boolean>;

export async function makeTutorialProjectPhpWritable(dir: string) {
  // Tutorial grading/completion still runs in PHP. These files are created by
  // Node, so explicitly permit the PHP worker to update this isolated instance.
  await Promise.all([
    chmod(dir, 0o777).catch(() => undefined),
    chmod(path.join(dir, "artifacts"), 0o777).catch(() => undefined),
    ...TUTORIAL_PROJECT_FILES.map((name) => chmod(path.join(dir, name), 0o666).catch(() => undefined))
  ]);
}

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

async function nodeCanWrite(target: string) {
  try {
    await access(target, fsConstants.W_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    if (isTutorialStoragePermissionError(error)) return false;
    throw error;
  }
}

async function tutorialProjectWriteTargets(dir: string) {
  const targets = [dir];
  for (const folder of [dir, path.join(dir, "artifacts")]) {
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isFile() || (folder === dir && entry.isDirectory() && entry.name === "artifacts")) {
        targets.push(path.join(folder, entry.name));
      }
    }
  }
  return targets;
}

/**
 * PHP (www-data) still creates some tutorial projects: the next practice
 * project after a completion, test attempts and draft/reject rounds. The
 * storage ACL grants www-data write access to everything but gives the API
 * service only the owning group's r-x, so Node cannot write into those
 * directories. The service owns the student's projects folder, so it can take
 * the project over: copy it into a Node-owned sibling (which inherits the
 * www-data ACL) and swap the two names within the same parent. The original
 * is kept beside it under a dot name that no project listing matches.
 * Returns true when the project was taken over.
 */
export async function ensureTutorialProjectNodeWritable(dir: string, canWrite: TutorialPathWritable = nodeCanWrite) {
  let needsTakeover = false;
  for (const target of await tutorialProjectWriteTargets(dir)) {
    if (!(await canWrite(target))) {
      needsTakeover = true;
      break;
    }
  }
  if (!needsTakeover) return false;

  const parent = path.dirname(dir);
  const name = path.basename(dir);
  const staging = await mkdtemp(path.join(parent, `.adopt-${name}-`));
  let swapped = false;
  try {
    await cp(dir, staging, { recursive: true, force: true });
    await makeTutorialProjectPhpWritable(staging);
    const retired = path.join(parent, `.php-owned-${name}-${Date.now()}`);
    await rename(dir, retired);
    try {
      await rename(staging, dir);
      swapped = true;
    } catch (error) {
      await rename(retired, dir).catch(() => undefined);
      throw error;
    }
  } finally {
    if (!swapped) await rm(staging, { recursive: true, force: true });
  }
  return true;
}
