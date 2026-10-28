import type { Author } from "../config-library/contracts.js";
import { libraryWritable } from "../config-library/library.js";
import { mutatePlatformConfiguration, readPlatformConfiguration, type JsonObject } from "./storage.js";

/**
 * Writing the capability kinds of the config library (app flag defaults, capability presets, the signup preset) from
 * the operator routes that used to write platform configuration documents, and the one-time import of those
 * documents (docs/architecture/config-library.md). Writes go through the library's own writer, so they are refused
 * outside the development data environment like every library write.
 */

async function writer() {
  const { registerAllLibraryKinds } = await import("../config-library/kinds/index.js");
  registerAllLibraryKinds();
  return import("../config-library/writes.js");
}

export async function saveLibraryEntry(kind: string, id: string, data: unknown, author: Author, options: { expected_revision?: number; note?: string } = {}) {
  return (await writer()).saveEntry({ kind, id, data, ...options }, author);
}

export async function deleteLibraryEntry(kind: string, id: string, author: Author, options: { expected_revision?: number; note?: string } = {}) {
  return (await writer()).deleteEntry({ kind, id, ...options }, author);
}

/** Who a signed-in operator's library write is recorded as. */
export function personAuthor(email: unknown): Author {
  return { kind: "person", id: String(email ?? "").trim().toLowerCase() || "operator" };
}

const IMPORT_AUTHOR: Author = { kind: "agent", id: "import:platform-configuration" };
const imports = new Map<string, Promise<void>>();

/**
 * Brings a platform configuration document a host saved before these defaults were library entries into the
 * library, once: `toEntries` turns it into entries, which are saved as imports, and the document is marked
 * `library_imported_at` so it is never imported again (it is no longer read otherwise). Only where the library is
 * writable; a failure is logged and retried by the next process.
 */
export function importPlatformConfigurationOnce(name: string, toEntries: (document: JsonObject) => Array<{ kind: string; id: string; data: unknown }>) {
  if (!libraryWritable()) return Promise.resolve();
  let running = imports.get(name);
  if (!running) {
    running = (async () => {
      const document = await readPlatformConfiguration(name);
      if (!document || document.library_imported_at) return;
      const { saveEntry } = await writer();
      for (const entry of toEntries(document)) {
        // One that no longer passes the kind's checks is left out (and said so); the rest still come across.
        try { await saveEntry({ ...entry, note: `Imported from the platform configuration ${name}.` }, IMPORT_AUTHOR, "import"); }
        catch (error) { console.error(`${entry.kind}/${entry.id} was not imported from ${name}:`, error instanceof Error ? error.message : error); }
      }
      await mutatePlatformConfiguration(name, (current) => ({ ...(current || {}), library_imported_at: new Date().toISOString() }));
    })().catch((error) => {
      imports.delete(name);
      console.error(`The platform configuration ${name} was not imported into the config library:`, error instanceof Error ? error.message : error);
    });
    imports.set(name, running);
  }
  return running;
}
