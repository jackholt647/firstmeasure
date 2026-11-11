/**
 * The offline asset manifest (docs/architecture/offline.md#asset-manifest):
 * every browser file an offline portal can need, with its sha256 and size, for
 * the release this host is serving.
 *
 * The files are read through the `current` release link, the same link NGINX
 * serves from, so a browser-only release that keeps this Node process is
 * picked up without a restart. deploy/digitalocean/release-node-fingerprint.py
 * lists this file as a reader of portal files with nothing in NODE_READS:
 * nothing is kept from the release Node started in.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { servedRelease } from "../live_assets.js";

/**
 * What is in the offline set. `**` crosses folders, `*` stays in one.
 * A file is in the set when an `include` pattern matches it and no `exclude`
 * entry does. docs/architecture/offline.md lists the exclusions and why.
 */
export const ASSET_RULES = {
  include: [
    "/libraries/**",
    "/portal/scripts/**",
    "/portal/mobile/**",
    // The signup widget the portal page loads; the landing pages around it are not included.
    "/portal/landing/shared/**",
    "/portal/signup-sandbox/**",
    "/portal/media/**",
    "/portal/manifest.webmanifest",
    "/fonts.css",
    "/fonts/**",
    "/images/**",
    "/favicon.ico"
  ],
  exclude: [
    { match: "**/*.php", reason: "Server pages. A person's shell is saved by the service worker, not listed here." },
    { match: "**/*.md", reason: "Documentation." },
    { match: "**/*.txt", reason: "Licences and notes." },
    { match: "**/LICENSE*", reason: "Licences." },
    { match: "**/*.map", reason: "Source maps." },
    { match: "**/*.html", reason: "Development previews and embed pages; no portal page needs one offline." },
    { match: "**/*.eot", reason: "A font format no supported browser asks for." },
    { match: "**/package.json", reason: "Build files." },
    { match: "**/package-lock.json", reason: "Build files." },
    { match: "/libraries/apps/smoke/**", reason: "Smoke test pages." },
    { match: "/libraries/**/*-sample.json", reason: "Sample data (the report settings preview's 3.4 MB sample report)." },
    { match: "/libraries/calls-runtime/effects/**", reason: "Call background effects: 34 MB of WASM and models, and a call needs a connection." },
    {
      match: "/libraries/platform-language/catalogs/*.json",
      unless: "current_catalog",
      reason: "Language catalogs the catalog manifest no longer names (older hashed files stay on disk)."
    },
    { match: "/portal/landing/**", except: "/portal/landing/shared/**", reason: "Marketing pages." },
    { match: "/portal/marketing/**", reason: "Marketing pages." },
    { match: "/portal/samples/**", reason: "Samples." },
    { match: "/measure/**", reason: "The measure editor is not offline yet." }
  ] as Array<{ match: string; reason: string; except?: string; unless?: "current_catalog" }>,
  /** Pages saved per person by the service worker (the server-rendered portal). */
  shells: ["/portal/"],
  /**
   * Other-origin stylesheets and scripts public/portal/index.php needs to render, and the icon
   * font files the stylesheet loads. An entry ending in `*` is a prefix: the service worker keeps
   * whatever is first loaded under it (the fonts' other formats). tests/offline-assets.test.ts
   * fails when the page gains an outside file that is in neither list.
   */
  external: [
    "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css",
    "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/webfonts/fa-solid-900.woff2",
    "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/webfonts/fa-regular-400.woff2",
    "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/webfonts/fa-brands-400.woff2",
    "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/webfonts/fa-v4compatibility.woff2",
    "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/webfonts/*",
    "https://cdn.jsdelivr.net/npm/geotiff",
    "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js",
    "https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"
  ],
  /** Outside hosts the page loads from that are never saved. */
  externalLeftOut: [
    { host: "www.googletagmanager.com", reason: "Analytics." },
    { host: "maps.googleapis.com", reason: "Google Maps needs a connection and may not be stored." },
    { host: "analytics.tiktok.com", reason: "Marketing pixel." },
    { host: "connect.facebook.net", reason: "Marketing pixel." }
  ]
} as const;

/** The set should stay under this; the manifest is still served over it, with a warning in the log. */
export const ASSET_BUDGET_BYTES = 60 * 1024 * 1024;

const CATALOG_DIR = "/libraries/platform-language/catalogs/";

export type OfflineAssetFiles = Record<string, [sha256: string, bytes: number]>;
export type OfflineAssetSet = {
  release: string;
  generated_at: string;
  files: OfflineAssetFiles;
  /** Bytes of every listed file. */
  bytes: number;
  /** A digest of the list, for the ETag. */
  digest: string;
  /** What `exclude` removed, by rule. */
  excluded: Array<{ match: string; reason: string; files: number; bytes: number }>;
};

function globPattern(glob: string) {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char !== "*") { source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&"); continue; }
    if (glob[index + 1] === "*") { source += ".*"; index += 1; } else source += "[^/]*";
  }
  return new RegExp(`^${source}$`);
}

const includes = ASSET_RULES.include.map((glob) => ({ glob, pattern: globPattern(glob) }));
const excludes = ASSET_RULES.exclude.map((rule) => ({ rule, pattern: globPattern(rule.match), except: rule.except ? globPattern(rule.except) : null }));

/** The `public` folder of the release this host serves; without a release link (a checkout), this checkout's. */
export function offlinePublicRoot(link = String(process.env.FIRSTMEASURE_CURRENT_RELEASE_LINK ?? "/opt/firstmeasure/current").trim()) {
  try {
    const served = path.join(fs.realpathSync(link), "public");
    if (fs.statSync(served).isDirectory()) return { root: served, pinned: true };
  } catch {
    // No release link on this machine.
  }
  // platform/offline in the sources, dist/platform/offline in a build: walk up to the folder that holds the browser files.
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    if (fs.existsSync(path.join(dir, "libraries")) && fs.existsSync(path.join(dir, "portal"))) return { root: dir, pinned: false };
    dir = path.dirname(dir);
  }
  return { root: "", pinned: false };
}

/** The catalog files the language manifest names now, or null when it cannot be read. */
function currentCatalogs(root: string) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, CATALOG_DIR, "manifest.json"), "utf8")) as { namespaces?: Record<string, unknown> };
    return new Set(["manifest.json", ...Object.values(manifest.namespaces ?? {}).map((file) => path.posix.basename(String(file)))]);
  } catch {
    return null;
  }
}

function candidateFiles(root: string) {
  const found = new Map<string, number>();
  const visit = (urlDir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(root, urlDir), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const url = `${urlDir}/${entry.name}`;
      // Real folders and files only: a link could lead out of the release.
      if (entry.isDirectory()) visit(url);
      else if (entry.isFile() && includes.some(({ pattern }) => pattern.test(url))) {
        try { found.set(url, fs.statSync(path.join(root, url)).size); } catch { /* Went away while listing. */ }
      }
    }
  };
  for (const { glob } of includes) {
    const wildcard = glob.indexOf("*");
    if (wildcard < 0) {
      try { const stat = fs.statSync(path.join(root, glob)); if (stat.isFile()) found.set(glob, stat.size); } catch { /* Not in this release. */ }
    } else {
      visit(glob.slice(0, glob.lastIndexOf("/", wildcard)));
    }
  }
  return found;
}

/** Which files the rules keep, and what each exclusion removed. Sizes only; nothing is hashed. */
export function selectOfflineAssets(root: string) {
  const catalogs = currentCatalogs(root);
  const kept: Array<{ url: string; bytes: number }> = [];
  const removed = new Map<string, { files: number; bytes: number }>();
  for (const [url, bytes] of [...candidateFiles(root)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const hit = excludes.find(({ rule, pattern, except }) => {
      if (!pattern.test(url) || except?.test(url)) return false;
      if (rule.unless === "current_catalog") return !catalogs?.has(path.posix.basename(url));
      return true;
    });
    if (!hit) { kept.push({ url, bytes }); continue; }
    const tally = removed.get(hit.rule.match) ?? { files: 0, bytes: 0 };
    removed.set(hit.rule.match, { files: tally.files + 1, bytes: tally.bytes + bytes });
  }
  const excluded = ASSET_RULES.exclude.filter((rule) => removed.has(rule.match)).map((rule) => ({ match: rule.match, reason: rule.reason, ...removed.get(rule.match)! }));
  return { kept, excluded };
}

async function buildAssetSet(root: string, release: string): Promise<OfflineAssetSet> {
  const { kept, excluded } = selectOfflineAssets(root);
  const files: OfflineAssetFiles = {};
  const digest = createHash("sha256");
  let bytes = 0;
  for (const { url } of kept) {
    // One file at a time: the event loop runs between files, and the largest is about a megabyte.
    let content: Buffer;
    try { content = await fs.promises.readFile(path.join(root, url)); } catch { continue; }
    const sha = createHash("sha256").update(content).digest("hex");
    files[url] = [sha, content.length];
    bytes += content.length;
    digest.update(`${url}\0${sha}\n`);
  }
  return { release, generated_at: new Date().toISOString(), files, bytes, digest: digest.digest("hex").slice(0, 32), excluded };
}

/** A cheap signature of a checkout's files, so a file edited in place gets a new manifest. */
function checkoutSignature(root: string) {
  const hash = createHash("sha256");
  for (const { url, bytes } of selectOfflineAssets(root).kept) {
    let modified = 0;
    try { modified = fs.statSync(path.join(root, url)).mtimeMs; } catch { /* Counted as changed. */ }
    hash.update(`${url}\0${bytes}\0${modified}\n`);
  }
  return hash.digest("hex").slice(0, 16);
}

let cached: { key: string; set: Promise<OfflineAssetSet> } | null = null;

/**
 * The asset set of the release being served, computed once per release in this process
 * (a release directory never changes). A checkout without a release link is checked by
 * size and time on every call, because its files do change.
 */
export function offlineAssetSet(): Promise<OfflineAssetSet> {
  const { root, pinned } = offlinePublicRoot();
  const release = servedRelease();
  const key = pinned ? `${release}\0${root}` : `${release}\0${root}\0${root ? checkoutSignature(root) : ""}`;
  if (cached?.key === key) return cached.set;
  const set = root ? buildAssetSet(root, release) : Promise.resolve<OfflineAssetSet>({ release, generated_at: new Date().toISOString(), files: {}, bytes: 0, digest: "", excluded: [] });
  const entry = { key, set };
  cached = entry;
  // A failed build is not kept: the next request tries again.
  set.catch(() => { if (cached === entry) cached = null; });
  return set;
}
