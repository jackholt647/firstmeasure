import type { z } from "zod";
import type { PlatformAuthContext } from "../platform/auth.js";

/**
 * Contracts of the platform config library (docs/architecture/config-library.md). A **kind** is one sort of
 * default (a document template, a guided experience, the app flag defaults); an **entry** is one default of a kind,
 * with an id unique inside the kind. Code declares kinds and reads entries; entries themselves are data, edited on
 * dev and checked in as a generated snapshot.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonData = { [key: string]: JsonValue };

export type LibraryEntry<T = JsonData> = {
  kind: string;
  id: string;
  /** Rises by one with every saved revision of this entry, from 1. */
  revision: number;
  /** sha256 of the canonical JSON of `data`: equal content, equal hash. */
  sha256: string;
  title: string;
  data: T;
  updated_at: string;
  updated_by: string;
};

export type LibraryRevision = Omit<LibraryEntry, "data"> & {
  data: JsonData | null;
  action: "create" | "update" | "delete" | "revert" | "import";
  author_kind: AuthorKind;
  note: string;
};

/** Who wrote a revision: a signed-in person, a coding agent with an access key, or the snapshot seeding a fresh store. */
export type AuthorKind = "person" | "agent" | "snapshot";
export type Author = { kind: AuthorKind; id: string };

/** What the running code registers, for checking references in an entry when it is saved. */
export type RegistryChecks = {
  provider(id: string, version?: string): boolean;
  providerExport(id: string, exportName: string): boolean;
  action(id: string, version?: string): boolean;
  widget(id: string, version?: string): boolean;
  measurementKey(key: string): boolean;
  measurementSchema(id: string): boolean;
  workItem(id: string): boolean;
  capability(id: string): boolean;
  /** Errors in a value written in the one condition contract (work/conditions.ts). */
  conditions(value: unknown, path?: string): string[];
  /** The current entry of another kind, to check a cross-reference (a workflow naming a template). */
  entry(kind: string, id: string): LibraryEntry | null;
};

export type ValidationContext = { id: string; previous: LibraryEntry | null; registries: RegistryChecks };

/** How one organization's copy of an entry stands against the library. */
export type OrgCopyStatus = {
  id: string;
  /** missing: the organization has no copy; library: an untouched copy of the current revision; behind: an untouched
   * copy of an older revision (it upgrades by itself); changed: the organization edited its copy (defaults no longer
   * reach it until it is reset). */
  state: "missing" | "library" | "behind" | "changed";
  copy_revision?: number;
  library_revision?: number;
  detail?: string;
};

export type LibraryKind<T = any> = {
  kind: string;
  title: string;
  description: string;
  /** Default /^[a-z0-9][a-z0-9_.:-]{0,159}$/. */
  idPattern?: RegExp;
  /** Structure of an entry's data. Parsing may fill defaults; what is stored is the parsed value. */
  schema: z.ZodType<T>;
  /** References to what the running code registers (providers, actions, widgets, measurement keys, conditions).
   * Runs on every save, so it must cost milliseconds: in-memory lookups only, never rendering, running a module or
   * reading organizations. Anything slower belongs in `deepCheck`. */
  validate?(data: T, ctx: ValidationContext): string[];
  /** An on-demand check that may be slow (render a template, run a module): never run on save; the dev console or an
   * agent asks for it with POST /v1/config-library/deep-check. Returns problems found. */
  deepCheck?(data: T, id: string): Promise<string[]>;
  /** A dictionary: entries are only ever added. Never deleted; `compatible` says what an edit may change. */
  appendOnly?: boolean;
  /** Errors when `next` is not an allowed change of `previous` (for an append-only kind, its meaning, unit or key). */
  compatible?(previous: T, next: T, id: string): string[];
  titleOf?(data: T, id: string): string;
  /** Pages read these entries directly (labels, marketing copy): served to anyone at GET /v1/config-library/read/<kind>,
   * from the store in development and the snapshot elsewhere. Never for anything that is not fit to publish. */
  browser?: boolean;
  /** sha256 ids of library assets the entry uses. Every one must exist when it is saved. */
  assetsOf?(data: T): string[];
  /** An organization's copies: how they stand, and putting one back to the library entry. */
  orgCopies?: {
    status(orgId: string, ids?: string[]): Promise<OrgCopyStatus[]>;
    reset(ctx: PlatformAuthContext, id: string): Promise<unknown>;
  };
};

export type LibraryChange = { kind: string; id: string; revision: number; deleted: boolean };
