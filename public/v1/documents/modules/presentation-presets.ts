import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

type JsonObject = Record<string, unknown>;

const require = createRequire(import.meta.url);

/** Load a browser library that also exports for Node, from the source or the deployed layout. */
function loadLibrary<T>(relative: string): T {
  const candidates = [
    fileURLToPath(new URL(`../../../libraries/${relative}`, import.meta.url)),
    path.resolve(process.cwd(), `../libraries/${relative}`),
    path.resolve(process.cwd(), `public/libraries/${relative}`),
    path.resolve(process.cwd(), `libraries/${relative}`)
  ];
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      return require(candidate) as T;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Unable to load public/libraries/${relative}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/** Raise when the deck in public/libraries/doc-present/templates/roofing-presentation.js changes. */
export const ROOFING_PRESENTATION_REVISION = 4;

/**
 * The roofing sales presentation's layout. The deck is authored once, in the
 * library the editor and the player use, so the seeded preset is exactly what
 * the editor's template builds.
 */
export function roofingPresentationLayout(): JsonObject {
  return loadLibrary<{ build: () => JsonObject }>("doc-present/templates/roofing-presentation.js").build();
}
