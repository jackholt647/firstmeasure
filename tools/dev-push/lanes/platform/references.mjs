// References to files that are not in the tree (docs/architecture/dev-lanes.md, "Checks"): the apps manifest's
// bundles, script/link tags and asset-version calls in PHP and HTML pages, and relative imports in browser code.
// The old rollout tooling kept every file a host ever had, so a deleted file could stay referenced unnoticed; a
// release built from git would then serve the portal's HTML in its place. Runs on every platform submission.
//
//   node tools/dev-push/lanes/platform/references.mjs [<checkout>]     lists missing references, exit 1 if any
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST = "public/libraries/apps/firstmate-apps-manifest.js";
const SKIP = new Set(["node_modules", "dist", "storage", "unused", ".git", "vendor"]);

function* files(root, rel, test) {
  let entries;
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) { if (!SKIP.has(entry.name)) yield* files(root, child, test); }
    else if (entry.isFile() && test(entry.name)) yield child;
  }
}

/** [{ from, ref, path }] for every reference whose target is missing. `exists(repoPath)` decides. */
export function missingReferences(root, exists = (rel) => fs.existsSync(path.join(root, rel))) {
  const missing = [];
  const check = (from, ref, target) => {
    const clean = target.split(/[?#]/)[0];
    if (!clean || /^(https?:)?\/\//.test(clean) || clean.includes("$") || clean.includes("<?")) return;
    const rel = path.posix.normalize(clean.startsWith("/") ? `public${clean}` : path.posix.join(path.posix.dirname(from), clean));
    if (!rel.startsWith("public/") || exists(rel)) return;
    missing.push({ from, ref, path: rel });
  };
  // The apps manifest: bundle paths are relative to public/libraries/apps.
  const manifest = (() => { try { return fs.readFileSync(path.join(root, MANIFEST), "utf8"); } catch { return ""; } })();
  for (const match of manifest.matchAll(/versionedBundle\(\s*'([^']+)'/g)) check(MANIFEST, match[0], `/${path.posix.join("libraries/apps", match[1])}`);
  // PHP and HTML pages: script and link tags, and asset-version helpers.
  const page = /(?:<script[^>]*\ssrc=["']([^"'<>]+\.m?js)[^"']*["']|<link[^>]*\shref=["']([^"'<>]+\.css)[^"']*["']|[A-Za-z]+AssetVersion\(\s*'([^']+\.(?:m?js|css))')/g;
  for (const file of files(root, "public", (name) => /\.(php|html?)$/i.test(name))) {
    if (file.startsWith("public/v1/") || file.startsWith("public/dev-previews/")) continue;
    const text = fs.readFileSync(path.join(root, file), "utf8");
    for (const match of text.matchAll(page)) check(file, match[0].slice(0, 120), match[1] || match[2] || match[3]);
  }
  // Browser modules: relative static imports.
  for (const file of files(root, "public/libraries", (name) => /\.m?js$/.test(name))) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    for (const match of text.matchAll(/(?:^|[;\s])(?:import\s[^'"]*?from\s*|import\s*)["'](\.{1,2}\/[^"']+)["']/gm)) check(file, match[0].trim().slice(0, 120), match[1]);
  }
  return missing;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] || ".");
  const started = Date.now();
  const missing = missingReferences(root);
  for (const item of missing) console.log(`${item.path}  <- ${item.from}  (${item.ref})`);
  console.log(`${missing.length} missing reference(s), ${Date.now() - started} ms`);
  process.exit(missing.length ? 1 : 0);
}
