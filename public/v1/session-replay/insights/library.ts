import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The browser's session replay codec and model, loaded on the server so a recording is read
 * exactly as the player reads it (public/libraries/session-replay/). Found by walking up from
 * this file, which works from the TypeScript source and from dist/.
 */
const require = createRequire(import.meta.url);

function findLibrary(file: string) {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    const candidate = path.join(dir, "libraries", "session-replay", file);
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error(`Session replay library ${file} was not found above ${fileURLToPath(import.meta.url)}.`);
}

export type ReplayEvent = { t: number; type: number; a: any[] };
export type VirtualNode = {
  id: number;
  tag: string;
  attrs: Record<string, string> | null;
  children: VirtualNode[] | null;
  parent: VirtualNode | null;
  text: string;
  url?: string;
};
export type MutationChange = { removed: VirtualNode[]; added: VirtualNode[]; attrs: Array<[VirtualNode, string]>; texts: VirtualNode[] } | null;
export interface VirtualMirror {
  nodes: Map<number, VirtualNode>;
  root: VirtualNode | null;
  values: Map<number, string>;
  focusId: number;
  hoverId: number;
  url: string;
  node(id: number): VirtualNode | null;
  ancestors(v: VirtualNode): VirtualNode[];
  textOf(v: VirtualNode, max?: number): string;
  label(v: VirtualNode | null): string;
  interactive(v: VirtualNode | null): VirtualNode | null;
  role(v: VirtualNode | null): string;
  path(v: VirtualNode | null): string;
  context(v: VirtualNode, max?: number): string[];
  headingIn(v: VirtualNode): string;
  headings(limit?: number): string[];
  activeTabs(limit?: number): string[];
  outline(maxLines?: number, start?: number): string;
}
export type ReplayPage = {
  strings: string[];
  events: ReplayEvent[];
  cursor: number[];
  meta: Record<string, any>;
  text(id: number): string;
  walk(visit: { before?: (event: ReplayEvent, mirror: VirtualMirror, index: number) => void; after?: (event: ReplayEvent, mirror: VirtualMirror, change: MutationChange, index: number) => void }): VirtualMirror;
  mirrorAt(t: number): VirtualMirror;
};

export const Codec: {
  E: Record<string, number>;
  PTR: Record<string, number>;
  DIAG_FIELDS: string[];
  BLOB_PREFIX: string;
  isBlobRef(value: unknown): boolean;
} = require(findLibrary("session-replay-codec.js"));

export const Model: {
  readPage(chunks: unknown[], blobs?: Map<string, string>): ReplayPage;
} = require(findLibrary("session-replay-model.js"));
