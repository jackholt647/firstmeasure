import type { Generator } from "./index.js";
import { terminologyNamespaceGenerator } from "./terminology_namespace.js";

/** Every kind's one-shot generator (see ./index.ts). One import per kind; removed with that kind's code seeds. */
export async function allGenerators(): Promise<Generator[]> {
  return [terminologyNamespaceGenerator];
}
