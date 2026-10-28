import { libraryEntries, libraryVersion } from '../../config-library/library.js';
import { TERMINOLOGY_NAMESPACE_KIND, type TerminologyNamespace } from '../../config-library/kinds/terminology_namespace.js';
import { terminologyContract, terminologyContractFrom, useTerminologyContract, type TerminologyContract } from './terminology.js';

/**
 * The server's terminology contract, read from the config library's `terminology_namespace` entries
 * (docs/architecture/terminology.md). Importing this module installs it for `terminology.ts`; every server module
 * that resolves terms imports it (or `terminologyContract` from here). The contract is rebuilt only when the library
 * changes, so an edit on dev is used on the next request.
 */
let cachedVersion = -1;
let cached: TerminologyContract = {};
export function libraryTerminologyContract(): TerminologyContract {
  const version = libraryVersion();
  if (version !== cachedVersion) {
    cached = terminologyContractFrom(libraryEntries<TerminologyNamespace>(TERMINOLOGY_NAMESPACE_KIND));
    cachedVersion = version;
  }
  return cached;
}
useTerminologyContract(libraryTerminologyContract);

/**
 * A `variable_mappings` module as it is stored: the legacy English `labels` equal to the term's library default are
 * dropped, so an organization's module holds overrides only and a later library change reaches it. Locale
 * dictionaries (`localized_labels`) are kept as written: there an empty string is an explicit reset.
 */
export function withoutDefaultLabels<T extends { labels?: Record<string, Record<string, string>> }>(data: T): T {
  if (!data.labels) return data;
  const contract = terminologyContract();
  const labels = Object.fromEntries(Object.entries(data.labels)
    .map(([namespace, values]) => [namespace, Object.fromEntries(Object.entries(values).filter(([key, value]) => contract[`${namespace}.${key}`]?.label !== value))] as const)
    .filter(([, values]) => Object.keys(values).length));
  return { ...data, labels };
}
export { terminologyContract };
