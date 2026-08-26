import path from "node:path";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

import type { ProjectManifest } from "./storage.js";

export type SharedPdfOutputSpec = {
  slot?: "main" | "summary";
  mode?: "full" | "summary";
  file_name?: string;
  cover_title?: string;
  page_config?: Record<string, unknown>;
  branding?: Record<string, unknown>;
  prepared_for?: Record<string, unknown>;
  outputFileName?: string;
  coverTitle?: string;
  pageConfigOverride?: Record<string, unknown>;
  organizationBranding?: Record<string, unknown>;
  brandingOverrides?: Record<string, unknown>;
  apply_branding_to_full?: boolean;
  applyBrandingToFull?: boolean;
  disable_organization_branding?: boolean;
  disableOrganizationBranding?: boolean;
  use_project_organization_branding?: boolean;
  useProjectOrganizationBranding?: boolean;
  clear_branding_overrides?: boolean;
  clearBrandingOverrides?: boolean;
  persist?: boolean;
  update_status?: boolean;
  updateStatus?: boolean;
  snapshot_patch?: unknown;
  statePatch?: unknown;
  pdf_config_patch?: Record<string, unknown>;
  pdfConfigPatch?: Record<string, unknown>;
};

export type SharedPdfBatchRequest = {
  snapshot: unknown;
  manifest: ProjectManifest;
  organization?: Record<string, unknown> | null;
  assetBaseUrl: string;
  outputs: SharedPdfOutputSpec[];
};

export type SharedPdfRenderResult = {
  slot: "main" | "summary";
  mode: "full" | "summary";
  fileName: string;
  renderChecksum: string | null;
  bytes: Buffer;
  persist: boolean;
  updateStatus: boolean;
};

export type SharedPdfDebugEntry = {
  ts: string;
  source: "browser-console" | "page-error";
  level: string;
  text: string;
  location?: string;
};

export type SharedPdfBatchRenderResponse = {
  outputs: SharedPdfRenderResult[];
  debug: SharedPdfDebugEntry[];
};

export type SharedPdfClientAssetName =
  | "jspdf"
  | "pdf"
  | "pdf-standalone"
  | "font-regular"
  | "font-bold"
  | "default-logo";

export type SharedPdfClientAsset = {
  name: SharedPdfClientAssetName;
  filePath: string;
  contentType: string;
  fileName: string;
};

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

type RuntimeAssetPaths = {
  jsPdfPath: string;
  pdfJsPath: string;
  pdfStandalonePath: string;
  fontRegularPath: string;
  fontBoldPath: string;
  defaultLogoPath: string;
};

type RuntimeRootInfo = {
  v1Root: string;
  publicRoot: string;
};

type EditorRuntimeCandidate = {
  label: string;
  rootFolderName: string;
  folderName: string;
};

const EDITOR_RUNTIME_CANDIDATES: EditorRuntimeCandidate[] = [
  { label: "measure/internal", rootFolderName: "measure", folderName: "internal" },
  { label: "measure/internal_new", rootFolderName: "measure", folderName: "internal_new" },
  { label: "measure/internal_old", rootFolderName: "measure", folderName: "internal_old" },
  { label: "measure-dev/internal", rootFolderName: "measure-dev", folderName: "internal" },
  { label: "measure-dev/internal_new", rootFolderName: "measure-dev", folderName: "internal_new" },
  { label: "measure-dev/internal_old", rootFolderName: "measure-dev", folderName: "internal_old" }
];

let cachedScriptsPromise: Promise<RuntimeAssetPaths> | null = null;
let cachedRuntimeRootPromise: Promise<RuntimeRootInfo> | null = null;

export async function renderSharedProjectPdfs(request: SharedPdfBatchRequest): Promise<SharedPdfBatchRenderResponse> {
  const scripts = await loadRuntimeScripts();
  const executablePath = await resolveBrowserExecutablePath();
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: [
      "--disable-gpu",
      "--font-render-hinting=medium",
      "--disable-dev-shm-usage"
    ]
  });

  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1024 },
      deviceScaleFactor: 1
    });
    const debugEntries: SharedPdfDebugEntry[] = [];
    const pushDebugEntry = (entry: SharedPdfDebugEntry) => {
      debugEntries.push(entry);
      if (debugEntries.length > 400) {
        debugEntries.shift();
      }
    };

    page.on("console", (message) => {
      const text = message.text();
      const isRelevant = text.startsWith("[PDF DEBUG]")
        || text.startsWith("[PDF]")
        || text.startsWith("[PDF-SIZE]");
      if (!isRelevant && message.type() !== "error") return;

      const location = message.location();
      pushDebugEntry({
        ts: new Date().toISOString(),
        source: "browser-console",
        level: message.type(),
        text,
        location: location?.url
          ? `${location.url}${typeof location.lineNumber === "number" ? `:${location.lineNumber + 1}` : ""}`
          : undefined
      });
    });

    page.on("pageerror", (error) => {
      pushDebugEntry({
        ts: new Date().toISOString(),
        source: "page-error",
        level: "error",
        text: error?.stack || error?.message || String(error)
      });
    });

    const blankRuntimeUrl = `${request.assetBaseUrl.replace(/\/+$/, "")}/blank`;
    await page.goto(blankRuntimeUrl, { waitUntil: "domcontentloaded" });
    await page.evaluate(({ assetBaseUrl }) => {
      window.__pdfAssetBaseUrl = assetBaseUrl;
    }, { assetBaseUrl: request.assetBaseUrl });
    await page.addScriptTag({ path: scripts.jsPdfPath });
    await page.addScriptTag({ path: scripts.pdfJsPath });
    await page.addScriptTag({ path: scripts.pdfStandalonePath });

    const outputs = await page.evaluate(async ({ snapshot, manifest, organization, outputs }) => {
        if (!window.FirstMatePDFStandalone) {
          throw new Error("Shared PDF runtime failed to initialize.");
        }
        const snapshotObj = (snapshot && typeof snapshot === "object")
          ? snapshot as Record<string, unknown>
          : {};
        const generated = await window.FirstMatePDFStandalone.generateProjectPdfsFromSnapshot(
          snapshot,
          {
            folderId: typeof snapshotObj.folderId === "string" && snapshotObj.folderId ? snapshotObj.folderId : manifest.id,
            manifest,
            organization
          },
          {
            outputs,
            skipUpload: true,
            skipStatusUpdate: true,
            download: false
          }
        );

        const generatedList = Array.isArray(generated) ? generated as Array<Record<string, unknown>> : [];
        const serialized: Array<Record<string, unknown>> = [];
        for (const item of generatedList) {
          const result = (item.result && typeof item.result === "object") ? item.result as Record<string, unknown> : {};
          const blob = result.blob as Blob;
          const base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              const value = typeof reader.result === "string" ? reader.result : "";
              resolve(value.split(",")[1] || "");
            };
            reader.onerror = () => reject(reader.error || new Error("Failed to serialize generated PDF blob."));
            reader.readAsDataURL(blob);
          });
          serialized.push({
            slot: item.slot || null,
            mode: item.mode || "full",
            fileName: typeof result.filename === "string" ? result.filename : "report.pdf",
            renderChecksum: typeof item.renderChecksum === "string" ? item.renderChecksum : null,
            persist: item.persist !== false,
            updateStatus: !!item.updateStatus,
            base64
          });
        }
        return serialized;
      }, {
        snapshot: request.snapshot,
        manifest: request.manifest,
        organization: request.organization || null,
        outputs: request.outputs
      }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        const recentDebug = debugEntries.slice(-8).map((entry) => `${entry.level}: ${entry.text}`).join(" | ");
        throw new Error(recentDebug ? `Shared PDF runtime failed: ${message} | ${recentDebug}` : `Shared PDF runtime failed: ${message}`);
      });

    return {
      outputs: (outputs as Array<Record<string, unknown>>).map((item) => ({
        slot: item.slot === "summary" ? "summary" : "main",
        mode: item.mode === "summary" ? "summary" : "full",
        fileName: typeof item.fileName === "string" ? item.fileName : "report.pdf",
        renderChecksum: typeof item.renderChecksum === "string" ? item.renderChecksum : null,
        bytes: Buffer.from(typeof item.base64 === "string" ? item.base64 : "", "base64"),
        persist: item.persist !== false,
        updateStatus: !!item.updateStatus
      })),
      debug: debugEntries
    };
  } finally {
    await browser.close();
  }
}

export async function getSharedPdfRuntimeAsset(name: SharedPdfClientAssetName): Promise<SharedPdfClientAsset> {
  const scripts = await loadRuntimeScripts();
  switch (name) {
    case "jspdf":
      return {
        name,
        filePath: scripts.jsPdfPath,
        contentType: "application/javascript; charset=utf-8",
        fileName: "jspdf.umd.min.js"
      };
    case "pdf":
      return {
        name,
        filePath: scripts.pdfJsPath,
        contentType: "application/javascript; charset=utf-8",
        fileName: "pdf.js"
      };
    case "pdf-standalone":
      return {
        name,
        filePath: scripts.pdfStandalonePath,
        contentType: "application/javascript; charset=utf-8",
        fileName: "pdf_standalone.js"
      };
    case "font-regular":
      return {
        name,
        filePath: scripts.fontRegularPath,
        contentType: "font/ttf",
        fileName: "Montserrat-Regular.ttf"
      };
    case "font-bold":
      return {
        name,
        filePath: scripts.fontBoldPath,
        contentType: "font/ttf",
        fileName: "Montserrat-Bold.ttf"
      };
    case "default-logo":
      return {
        name,
        filePath: scripts.defaultLogoPath,
        contentType: "image/png",
        fileName: "logo_red.png"
      };
    default:
      throw new Error(`Unsupported shared PDF client asset '${String(name)}'.`);
  }
}

async function loadRuntimeScripts() {
  const scriptsPromise = cachedScriptsPromise ?? (cachedScriptsPromise = (async () => {
      const roots = await resolveRuntimeRoots();
      const [jsPdfPath, fontRegularPath, fontBoldPath, defaultLogoPath] = await Promise.all([
        resolveExistingPath(
          [path.join(roots.v1Root, "node_modules", "jspdf", "dist", "jspdf.umd.min.js")],
          "jsPDF runtime script"
        ),
        resolveExistingPath(
          [path.join(roots.publicRoot, "fonts", "Montserrat-Regular.ttf")],
          "Montserrat regular font"
        ),
        resolveExistingPath(
          [path.join(roots.publicRoot, "fonts", "Montserrat-Bold.ttf")],
          "Montserrat bold font"
        ),
        resolveExistingPath(
          [path.join(roots.publicRoot, "images", "logo_red.png")],
          "default PDF logo"
        )
      ]);

      const configuredEditorRuntimeRoot = process.env.FIRSTMEASURE_EDITOR_RUNTIME_ROOT?.trim();
      const editorRuntimeCandidates = [
        ...(configuredEditorRuntimeRoot
          ? [{ label: "configured", editorRoot: configuredEditorRuntimeRoot }]
          : []),
        ...EDITOR_RUNTIME_CANDIDATES.map((candidate) => ({
          label: candidate.label,
          editorRoot: path.join(roots.publicRoot, candidate.rootFolderName, candidate.folderName)
        }))
      ];

      for (const candidate of editorRuntimeCandidates) {
        const editorRoot = candidate.editorRoot;
        const [pdfJsPath, pdfStandalonePath] = await Promise.all([
          resolveExistingPath(
            [path.join(editorRoot, "editor_scripts", "pdf.js")],
            `${candidate.label} shared PDF script`,
            true
          ),
          resolveExistingPath(
            [path.join(editorRoot, "editor_scripts", "pdf_standalone.js")],
            `${candidate.label} PDF standalone bridge`,
            true
          )
        ]);

        if (pdfJsPath && pdfStandalonePath) {
          return {
            jsPdfPath,
            pdfJsPath,
            pdfStandalonePath,
            fontRegularPath,
            fontBoldPath,
            defaultLogoPath
          };
        }
      }

      throw new Error(
        `Unable to locate a shared editor runtime under ${roots.publicRoot}. ` +
        `Checked: ${editorRuntimeCandidates.map((candidate) => candidate.editorRoot).join(", ")}.`
      );
    })());
  return scriptsPromise;
}

async function resolveRuntimeRoots(): Promise<RuntimeRootInfo> {
  const runtimeRootPromise = cachedRuntimeRootPromise ?? (cachedRuntimeRootPromise = (async () => {
      const candidates = uniquePaths([
        process.cwd(),
        path.resolve(MODULE_DIR, ".."),
        path.resolve(MODULE_DIR, "..", "..")
      ]);

      for (const candidate of candidates) {
        const packageJsonPath = path.join(candidate, "package.json");
        const nodeModulesPath = path.join(candidate, "node_modules");
        try {
          await Promise.all([access(packageJsonPath), access(nodeModulesPath)]);
          return {
            v1Root: candidate,
            publicRoot: path.resolve(candidate, "..")
          };
        } catch {
          // try next root candidate
        }
      }

      throw new Error(
        `Unable to resolve the FirstMeasure v1 runtime root from module directory '${MODULE_DIR}' or cwd '${process.cwd()}'.`
      );
    })());
  return runtimeRootPromise;
}

async function resolveBrowserExecutablePath() {
  const configured = process.env.FIRSTMEASURE_PDF_BROWSER;
  if (configured) {
    await access(configured);
    return configured;
  }

  const candidates = process.platform === "win32"
    ? [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
      ]
    : process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
        ]
      : [
          "/usr/bin/google-chrome",
          "/usr/bin/chromium-browser",
          "/usr/bin/chromium",
          "/snap/bin/chromium",
          "/usr/bin/microsoft-edge"
        ];

  return resolveExistingPath(candidates, "browser executable");
}

async function resolveExistingPath(candidates: string[], label: string): Promise<string>;
async function resolveExistingPath(candidates: string[], label: string, allowMissing: true): Promise<string | null>;
async function resolveExistingPath(candidates: string[], label: string, allowMissing = false) {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try next path
    }
  }
  if (allowMissing) {
    return null;
  }
  throw new Error(`Unable to locate ${label}. Checked: ${candidates.join(", ")}`);
}

function uniquePaths(paths: string[]) {
  return [...new Set(paths.map((value) => path.resolve(value)))];
}

declare global {
  interface Window {
    __pdfAssetBaseUrl?: string;
    FirstMatePDFStandalone?: {
      generateProjectPdfsFromSnapshot: (
        snapshot: unknown,
        runtimeContext: Record<string, unknown>,
        options: Record<string, unknown>
      ) => Promise<Array<Record<string, unknown>>>;
    };
  }
}
