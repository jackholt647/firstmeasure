import type { LibraryKind } from "./contracts.js";

/**
 * The kinds of default the library holds. Each kind is declared once, in its own file under `kinds/`, by the domain
 * that reads it; `kinds/index.ts` registers them all. A kind is code (its structure, its checks, how an
 * organization's copy is reset); its entries are data.
 */
const kinds = new Map<string, LibraryKind>();
export const DEFAULT_ID_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,159}$/;

export function registerLibraryKind<T>(kind: LibraryKind<T>) {
  if (!/^[a-z][a-z0-9_]{1,59}$/.test(kind.kind)) throw new Error(`Config library kind ${kind.kind} has an invalid name.`);
  const existing = kinds.get(kind.kind);
  if (existing && existing !== kind) throw new Error(`Config library kind ${kind.kind} is declared twice.`);
  kinds.set(kind.kind, kind as LibraryKind);
  return kind;
}
export function libraryKind(name: string) { return kinds.get(name) || null; }
export function listLibraryKinds() { return [...kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)); }
