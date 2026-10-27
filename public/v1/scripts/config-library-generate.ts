/**
 * One-shot generation of the config library snapshot from the code seeds (docs/architecture/config-library.md,
 * "Generation"): runs every kind's generator, checks each entry against its kind and the running code's registries,
 * and writes config-library/snapshot/ (revision 1). `--kind <name>` (repeatable) limits it to those kinds;
 * `--check` reports problems without writing.
 *
 *   node --experimental-sqlite --import tsx scripts/config-library-generate.ts [--kind document_template] [--check]
 */
process.env.CONFIG_LIBRARY_SOURCE ||= "snapshot";
const { registerAllLibraryKinds } = await import("../config-library/kinds/index.js");
const { libraryKind } = await import("../config-library/kinds.js");
const { allGenerators } = await import("../config-library/generate/all.js");
const { checkEntry } = await import("../config-library/writes.js");
const { writeSnapshot } = await import("../config-library/snapshot.js");

const args = process.argv.slice(2);
const only = args.flatMap((arg, index) => (arg === "--kind" ? [args[index + 1]!] : []));
const checkOnly = args.includes("--check");
registerAllLibraryKinds();
const generatedAt = new Date().toISOString();
const { applyLibraryChange } = await import("../config-library/library.js");
const { contentHash } = await import("../config-library/canonical.js");
// Every generator runs first and its entries are put into this process's library, so an entry that names another
// (a workflow naming a template, a step naming a setup step) is checked against the whole generated set.
const generated: Array<{ kind: string; id: string; data: unknown }> = [];
const assets = [];
const problems: string[] = [];
for (const generator of await allGenerators()) {
  if (only.length && !only.includes(generator.kind)) continue;
  if (!libraryKind(generator.kind)) { problems.push(`${generator.kind}: no kind is registered for this generator.`); continue; }
  const seen = new Set<string>();
  for (const item of await generator.run()) {
    if (seen.has(item.id)) problems.push(`${generator.kind}/${item.id}: generated twice.`);
    seen.add(item.id);
    generated.push({ kind: generator.kind, id: item.id, data: item.data });
    const data = JSON.parse(JSON.stringify(item.data ?? null));
    applyLibraryChange({ kind: generator.kind, id: item.id, revision: 1, sha256: contentHash(data), title: item.id, data, updated_at: generatedAt, updated_by: "generator" });
  }
  assets.push(...(generator.assets || []));
  console.log(`${generator.kind}: ${seen.size} entries`);
}
const entries = [];
for (const item of generated) {
  const kind = libraryKind(item.kind)!;
  const checked = checkEntry(item.kind, item.id, item.data, null);
  if (checked.errors.length) { problems.push(...checked.errors.map((error) => `${item.kind}/${item.id}: ${error}`)); continue; }
  entries.push({ kind: item.kind, id: item.id, revision: 1, title: String(kind.titleOf?.(checked.data, item.id) || item.id).trim() || item.id, updated_at: generatedAt, updated_by: "generator", data: checked.data! });
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
if (!checkOnly) {
  const kinds = only.length ? only : [...new Set(entries.map((entry) => entry.kind))];
  console.log(writeSnapshot(entries, assets, { kinds }));
}
process.exit(0);
