import { readFileSync } from "node:fs";
import { sha256 } from "../canonical.js";

/**
 * One-shot generation of the config library from the code seeds it replaces (docs/architecture/config-library.md,
 * "Generation"). Each kind has one generator file here that evaluates today's seed code and returns its entries;
 * `scripts/config-library-generate.ts` runs them all, checks every entry against its kind and writes the snapshot.
 * Once a kind's seeds are deleted its generator goes with them: from then on the store is the source and the
 * snapshot is exported from it (`scripts/config-library-snapshot.ts`).
 */

export type GeneratedAsset = { sha256: string; content_type: string; file_name: string; bytes: Buffer };
export type GeneratedEntry = { id: string; data: unknown };
export type Generator = { kind: string; run(): Promise<GeneratedEntry[]> | GeneratedEntry[]; assets?: GeneratedAsset[] };

const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", avif: "image/avif" };
/** An image file a generated entry uses: its `asset:<sha256>` reference and the asset to store. */
export function fileAsset(file: string) {
  const bytes = readFileSync(file);
  const extension = file.split(".").pop()!.toLowerCase();
  const contentType = TYPES[extension];
  if (!contentType) throw new Error(`${file} is not an image type the library takes.`);
  const hash = sha256(bytes);
  return { ref: `asset:${hash}`, asset: { sha256: hash, content_type: contentType, file_name: file.split(/[\\/]/).pop()!, bytes } };
}

const generators: Generator[] = [];
export function registerGenerator(generator: Generator) { generators.push(generator); }
export function listGenerators() { return [...generators]; }
