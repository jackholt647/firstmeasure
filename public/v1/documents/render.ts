import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { JsonObject } from "../platform/storage.js";
import { FMDocModel } from "./schemas.js";
import type { LanguageSnapshot } from "../platform/localization/core.js";
import { frozenCatalogs } from "../platform/localization/server.js";
import { DOCUMENT_NAMESPACES } from "../platform/localization/documents.js";

/**
 * Builds the static print/PDF harness: a self-contained HTML document that
 * inlines the shared doc-model/doc-renderer/doc-widgets libraries, injects the
 * frozen render payload as JSON, and boots FMDocRenderer in static mode.
 *
 * Server-authoritative by design — the client never uploads HTML; this file is
 * the only place harness HTML is produced.
 */

const LIBRARY_FILES = {
  docModel: "doc-model/firstmate-doc-model.js",
  docRenderer: "doc-renderer/firstmate-doc-renderer.js",
  docRendererCss: "doc-renderer/doc-renderer.css",
  docWidgets: "doc-widgets/firstmate-doc-widgets.js"
} as const;

function librariesRootCandidates() {
  return [
    // Source layout: public/v1/documents/render.ts -> public/libraries
    fileURLToPath(new URL("../../libraries/", import.meta.url)),
    path.resolve(process.cwd(), "../libraries"),
    path.resolve(process.cwd(), "public/libraries"),
    path.resolve(process.cwd(), "libraries")
  ];
}

type LibrarySources = {
  docModel: string;
  docRenderer: string;
  docRendererCss: string;
  docWidgets: string;
  loadedAt: number;
};

let cachedSources: LibrarySources | null = null;

async function readLibraryFile(relativePath: string) {
  let lastError: unknown = null;
  for (const root of librariesRootCandidates()) {
    try {
      return await readFile(path.join(root, relativePath), "utf8");
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `Document render harness requires public/libraries/${relativePath}. `
    + "The doc-renderer/doc-widgets libraries are not built yet — build them before rendering documents. "
    + `(${lastError instanceof Error ? lastError.message : String(lastError)})`
  );
}

async function librarySources(): Promise<LibrarySources> {
  if (cachedSources) return cachedSources;
  // The renderer/widget libraries EMBED their own CSS — the harness only needs
  // the three JS files. A standalone doc-renderer.css is inlined when present
  // but is not required.
  const [docModel, docRenderer, docWidgets, docRendererCss] = await Promise.all([
    readLibraryFile(LIBRARY_FILES.docModel),
    readLibraryFile(LIBRARY_FILES.docRenderer),
    readLibraryFile(LIBRARY_FILES.docWidgets),
    readLibraryFile(LIBRARY_FILES.docRendererCss).catch(() => "")
  ]);
  cachedSources = { docModel, docRenderer, docRendererCss, docWidgets, loadedAt: Date.now() };
  return cachedSources;
}

/** Test hook / hot-reload escape hatch. */
export function clearRenderHarnessCache() {
  cachedSources = null;
}

/** Neutralize "</script" sequences so inlined JS can never close its tag early. */
function escapeInlineScript(source: string) {
  return source.replace(/<\/script/gi, "<\\/script");
}

/** JSON payloads additionally escape every "<" so no markup can break out. */
function escapeJsonPayload(value: unknown) {
  return JSON.stringify(value ?? null).replace(/</g, "\\u003c");
}

export async function buildRenderHarnessHtml(input: {
  resolved_definition: JsonObject;
  theme: JsonObject;
  themeContext: JsonObject;
  widgetData: Record<string, unknown>;
  scope: JsonObject;
  title?: string;
  language_snapshot?: LanguageSnapshot;
}) {
  const sources = await librarySources();
  const paper = FMDocModel.paperDimensions(input.resolved_definition);
  const themeVars = FMDocModel.resolveThemeTokens(input.theme || {}, input.themeContext || {});
  const themeCss = FMDocModel.themeCssText(themeVars, ":root");
  const payload = escapeJsonPayload({
    document: input.resolved_definition,
    theme: input.theme || {},
    themeContext: input.themeContext || {},
    widgetData: input.widgetData || {},
    scope: input.scope || {}
  });
  const title = String(input.title || "Document").replace(/[<>&"]/g, "");
  const language = input.language_snapshot;
  const languageBoot = language && (language.locale !== "en-US" || Object.keys(language.terminology?.labels || {}).length || Object.keys(language.terminology?.localized_labels || {}).length)
    ? `<script>${escapeInlineScript(await readLibraryFile("platform-language/platform-language.js"))}</script><script>${(await frozenCatalogs(language, DOCUMENT_NAMESPACES)).map(bundle => `PlatformLanguage.register(${escapeJsonPayload(bundle)});`).join("")}PlatformLanguage.configure({context:${escapeJsonPayload(language)}});PlatformLanguage.setTerminology(${escapeJsonPayload(language.terminology || {})});</script>`
    : "";
  const boot = `
(function () {
  window.__fmdocReady = false;
  var container = document.getElementById("fmdoc-root");
  function done() { window.__fmdocReady = true; }
  var payloadNode = document.getElementById("fmdoc-payload");
  var payload;
  try {
    payload = JSON.parse(payloadNode.textContent || "{}");
  } catch (error) {
    done();
    return;
  }
  try {
    container.addEventListener("fmdoc:ready", done, { once: true });
    FMDocRenderer.render(container, {
      document: payload.document,
      theme: payload.theme,
      themeContext: payload.themeContext,
      mode: "static",
      widgetData: payload.widgetData,
      scope: payload.scope
    });
    if (container.__fmdocReady === true) done();
  } catch (error) {
    // A render failure must not hang the PDF pipeline; the page prints as-is.
    done();
  }
  // Hard stop: never leave Playwright waiting forever.
  setTimeout(done, 15000);
})();`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
${sources.docRendererCss}
@page { size: ${paper.w_pt}pt ${paper.h_pt}pt; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
${themeCss}
</style>
</head>
<body class="fmdoc-print">
<div id="fmdoc-root"></div>
${languageBoot}
<script>${escapeInlineScript(sources.docModel)}</script>
<script>${escapeInlineScript(sources.docWidgets)}</script>
<script>${escapeInlineScript(sources.docRenderer)}</script>
<script type="application/json" id="fmdoc-payload">${payload}</script>
<script>${escapeInlineScript(boot)}</script>
</body>
</html>`;
}
