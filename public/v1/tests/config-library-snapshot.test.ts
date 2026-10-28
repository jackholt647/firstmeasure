import assert from "node:assert/strict";
import test from "node:test";

// The checked-in config library snapshot (config-library/snapshot/): every file matches its hash (a read refuses a hand
// edit), names a registered kind, and passes that kind's save-time checks against the running code, so what fresh
// databases, tests and production read is what dev would accept.
process.env.CONFIG_LIBRARY_SOURCE = "snapshot";

test("config library snapshot: every entry is a registered kind and passes its checks", async () => {
  const { registerAllLibraryKinds } = await import("../config-library/kinds/index.js");
  const { libraryKind, listLibraryKinds } = await import("../config-library/kinds.js");
  const { readSnapshot } = await import("../config-library/library.js");
  const { readSnapshotAssets } = await import("../config-library/assets.js");
  const { checkEntry } = await import("../config-library/writes.js");
  registerAllLibraryKinds();
  const files = readSnapshot();
  assert.ok(files.length > 0, "the snapshot is checked in");
  const assets = new Set(readSnapshotAssets().map((asset) => asset.sha256));
  const problems: string[] = [];
  for (const file of files) {
    const kind = libraryKind(file.kind);
    if (!kind) { problems.push(`${file.kind}/${file.id}: no kind ${file.kind} is registered.`); continue; }
    const checked = checkEntry(file.kind, file.id, file.data, null);
    problems.push(...checked.errors.map((error) => `${file.kind}/${file.id}: ${error}`));
    for (const sha of kind.assetsOf?.(checked.data ?? file.data) || []) if (!assets.has(sha)) problems.push(`${file.kind}/${file.id}: asset ${sha} is not in the snapshot.`);
  }
  assert.deepEqual(problems, []);
  const empty = listLibraryKinds().filter((kind) => !files.some((file) => file.kind === kind.kind)).map((kind) => kind.kind);
  // Kinds that start empty on purpose (written on dev as they are needed).
  assert.deepEqual(empty.filter((kind) => !["guided_copy"].includes(kind)), [], "every other kind has entries");
});
