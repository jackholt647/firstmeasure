import path from "node:path";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

import { finalizeFirstMatePdf } from "../src/pdf_metadata.js";

import { badRequest } from "./errors.js";
import { buildProjectInstantPayload, INSTANT_STRUCTURE_INSIGHTS_FILE_NAME } from "./instant.js";
import { buildInstantRenderData } from "./instant_render.js";
import { patchManifest, readArtifact, saveArtifact, type ProjectManifest } from "./storage.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOGO_NAME = "logo_red.png";
export const INSTANT_PDF_FILE_NAME = "Instant Report.pdf";
const INSTANT_PDF_RENDER_VERSION = 38;
const INSTANT_REPORT_QUAD_VIEW_ENABLED = false;

type InstantPdfAssetPaths = {
  browserExecutablePath: string;
  geotiffScriptPath: string;
  threeScriptPath: string;
  orbitControlsPath: string;
  defaultLogoPath: string;
  fontRegularPath: string;
  fontBoldPath: string;
};

type InstantPdfGenerationResult = {
  fileName: string;
  bytes: Uint8Array;
};

export type InstantPdfArtifactState = {
  status: "ready" | "generating" | "pending" | "failed";
  fileName: string | null;
  error?: string | null;
};

let cachedAssetPathsPromise: Promise<InstantPdfAssetPaths> | null = null;
const instantPdfJobMap = new Map<string, Promise<InstantPdfGenerationResult | null>>();

const PAGE_WIDTH_PX = 1836;
const PAGE_HEIGHT_PX = 2376;
const PAGE_WIDTH_MM = 215.9;
const PX_PER_MM = PAGE_WIDTH_PX / PAGE_WIDTH_MM;
const PAGE_HEIGHT_MM = PAGE_HEIGHT_PX / PX_PER_MM;
const REPORT_PRIMARY_STRIP_PX = Math.round(8 * PX_PER_MM);
const REPORT_SECONDARY_STRIP_PX = Math.round(2 * PX_PER_MM);
const REPORT_CONTENT_LEFT_PX = Math.round(25 * PX_PER_MM);
const REPORT_CONTENT_RIGHT_PX = Math.round(15 * PX_PER_MM);
const REPORT_MARGIN_PX = REPORT_CONTENT_RIGHT_PX;
const REPORT_TOP_MARGIN_PX = Math.round(10 * PX_PER_MM);
const REPORT_LOGO_HEIGHT_PX = Math.round(12 * PX_PER_MM);
const REPORT_LOGO_LEFT_PX = Math.round(20 * PX_PER_MM);
const REPORT_LOGO_BOTTOM_GAP_PX = Math.round(18 * PX_PER_MM);
const REPORT_SECTION_GAP_PX = Math.round(8 * PX_PER_MM);
const REPORT_THUMB_GAP_PX = Math.round(6 * PX_PER_MM);
const REPORT_THUMB_BOTTOM_PX = Math.round(18 * PX_PER_MM);
const REPORT_CARD_RADIUS_PX = Math.round(3 * PX_PER_MM);
const REPORT_CARD_SHADOW_OFFSET_PX = Math.round(1.5 * PX_PER_MM);
const REPORT_CARD_BORDER_PX = Math.max(1, Math.round(0.3 * PX_PER_MM));

export async function ensureInstantPdfArtifact(input: {
  projectId: string;
  manifest: ProjectManifest;
  brandingDefaults?: unknown;
  insights?: unknown;
  structureInsights?: unknown;
  rgbContent?: Uint8Array | Buffer | null;
  heightMapContent?: Uint8Array | Buffer | null;
  maskContent?: Uint8Array | Buffer | null;
}) {
  const artifactState = asRecord(input.manifest.artifacts);
  const existingVersion = Number(artifactState.instant_pdf_version ?? 0);
  const existing = await readArtifact(input.projectId, INSTANT_PDF_FILE_NAME).catch(() => null);
  if (existing && existingVersion >= INSTANT_PDF_RENDER_VERSION) {
    await patchManifest(input.projectId, {
      artifacts: {
        has_instant_pdf: true,
        instant_pdf_status: "ready",
        instant_pdf_last_error: null,
        instant_pdf_version: INSTANT_PDF_RENDER_VERSION
      }
    }).catch(() => null);
    return {
      fileName: existing.name,
      bytes: existing.content
    };
  }

  const insights = input.insights ?? await readJsonArtifact(input.projectId, "insights.json");
  const structureInsights = input.structureInsights ?? await readJsonArtifact(input.projectId, INSTANT_STRUCTURE_INSIGHTS_FILE_NAME);
  const rgbContent = input.rgbContent ?? (await readArtifact(input.projectId, "rgb.tif").catch(() => null))?.content ?? null;
  const heightMapContent = input.heightMapContent ?? (await readArtifact(input.projectId, "dsm.tif").catch(() => null))?.content ?? null;
  const maskContent = input.maskContent ?? (await readArtifact(input.projectId, "mask.tif").catch(() => null))?.content ?? null;

  if (!insights || !heightMapContent || !maskContent) {
    await patchManifest(input.projectId, {
      artifacts: {
        instant_pdf_status: "pending"
      }
    }).catch(() => null);
    return null;
  }

  await patchManifest(input.projectId, {
    artifacts: {
      instant_pdf_status: "generating",
      instant_pdf_last_error: null,
      instant_pdf_last_attempt_at: new Date().toISOString()
    }
  }).catch(() => null);

  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await buildInstantPdfBytes({
      manifest: input.manifest,
      brandingDefaults: input.brandingDefaults,
      insights,
      structureInsights,
      rgbContent,
      heightMapContent,
      maskContent,
      showPreparedFor: true
    });
  } catch (error) {
    await patchManifest(input.projectId, {
      artifacts: {
        instant_pdf_status: "failed",
        instant_pdf_last_error: String(error instanceof Error ? error.message : "Instant PDF render data could not be prepared.")
      }
    }).catch(() => null);
    return null;
  }
  await saveArtifact(input.projectId, INSTANT_PDF_FILE_NAME, pdfBytes);
  await patchManifest(input.projectId, {
    artifacts: {
      has_instant_pdf: true,
      instant_pdf_status: "ready",
      instant_pdf_last_error: null,
      instant_pdf_generated_at: new Date().toISOString(),
      instant_pdf_version: INSTANT_PDF_RENDER_VERSION
    }
  }).catch(() => null);

  return {
    fileName: INSTANT_PDF_FILE_NAME,
    bytes: pdfBytes
  } satisfies InstantPdfGenerationResult;
}

export async function generateProjectInstantPdf(input: {
  projectId: string;
  manifest: ProjectManifest;
  brandingDefaults?: unknown;
  preparedFor?: unknown;
  showPreparedFor?: boolean;
  fileName?: string;
  insights?: unknown;
  structureInsights?: unknown;
  rgbContent?: Uint8Array | Buffer | null;
  heightMapContent?: Uint8Array | Buffer | null;
  maskContent?: Uint8Array | Buffer | null;
}) {
  const insights = input.insights ?? await readJsonArtifact(input.projectId, "insights.json");
  const structureInsights = input.structureInsights ?? await readJsonArtifact(input.projectId, INSTANT_STRUCTURE_INSIGHTS_FILE_NAME);
  const rgbContent = input.rgbContent ?? (await readArtifact(input.projectId, "rgb.tif").catch(() => null))?.content ?? null;
  const heightMapContent = input.heightMapContent ?? (await readArtifact(input.projectId, "dsm.tif").catch(() => null))?.content ?? null;
  const maskContent = input.maskContent ?? (await readArtifact(input.projectId, "mask.tif").catch(() => null))?.content ?? null;

  if (!insights || !heightMapContent || !maskContent) {
    throw badRequest("instant_pdf_not_ready", "Instant PDF generation requires insights, DSM, and mask artifacts.");
  }

  const bytes = await buildInstantPdfBytes({
    manifest: input.manifest,
    brandingDefaults: input.brandingDefaults,
    preparedFor: input.preparedFor,
    showPreparedFor: input.showPreparedFor,
    insights,
    structureInsights,
    rgbContent,
    heightMapContent,
    maskContent
  });

  return {
    fileName: input.fileName || INSTANT_PDF_FILE_NAME,
    bytes
  } satisfies InstantPdfGenerationResult;
}

export function triggerInstantPdfArtifact(input: {
  projectId: string;
  manifest: ProjectManifest;
  brandingDefaults?: unknown;
  insights?: unknown;
  structureInsights?: unknown;
  rgbContent?: Uint8Array | Buffer | null;
  heightMapContent?: Uint8Array | Buffer | null;
  maskContent?: Uint8Array | Buffer | null;
}): InstantPdfArtifactState {
  const artifactState = asRecord(input.manifest.artifacts);
  const currentStatus = String(artifactState.instant_pdf_status || "").trim().toLowerCase();
  const existingVersion = Number(artifactState.instant_pdf_version ?? 0);
  const hasCurrentPdf = Boolean(artifactState.has_instant_pdf) && existingVersion >= INSTANT_PDF_RENDER_VERSION;
  if (hasCurrentPdf) {
    return {
      status: "ready",
      fileName: INSTANT_PDF_FILE_NAME
    };
  }

  if (!input.insights || !input.heightMapContent || !input.maskContent) {
    return {
      status: "pending",
      fileName: null
    };
  }

  if (!instantPdfJobMap.has(input.projectId)) {
    const job = ensureInstantPdfArtifact(input)
      .catch(async (error) => {
        await patchManifest(input.projectId, {
          artifacts: {
            instant_pdf_status: "failed",
            instant_pdf_last_error: String(error?.message || "Instant PDF generation failed.")
          }
        }).catch(() => null);
        return null;
      })
      .finally(() => {
        instantPdfJobMap.delete(input.projectId);
      });
    instantPdfJobMap.set(input.projectId, job);
  }

  return {
    status: currentStatus === "failed" ? "failed" : "generating",
    fileName: null,
    error: typeof artifactState.instant_pdf_last_error === "string"
      ? artifactState.instant_pdf_last_error
      : null
  };
}

async function buildInstantPdfBytes(input: {
  manifest: ProjectManifest;
  brandingDefaults?: unknown;
  preparedFor?: unknown;
  showPreparedFor?: boolean;
  insights: unknown;
  structureInsights?: unknown;
  rgbContent?: Uint8Array | Buffer | null;
  heightMapContent: Uint8Array | Buffer;
  maskContent: Uint8Array | Buffer;
}) {
  const renderData = await buildInstantRenderData({
    heightMapContent: input.heightMapContent,
    maskContent: input.maskContent,
    sampleSize: 72
  });
  if (!renderData) {
    throw badRequest("instant_pdf_render_data_unavailable", "Instant PDF render data could not be prepared.");
  }

  const instantPayload = {
    ...buildProjectInstantPayload({
      manifest: input.manifest,
      insights: input.insights,
      structureInsights: input.structureInsights,
      assetUrls: {
        preview_image_url: null,
        solar_rgb_url: null,
        height_map_url: null,
        mask_url: null,
        insights_url: null,
        structure_insights_url: null
      }
    }),
    render_data: renderData
  };

  const brandingColors = resolveBrandingColors(input.brandingDefaults);
  const resolvedLogo = await resolveLogoDataUrl(input.brandingDefaults);
  const fontData = await resolveFontDataUrls();
  return renderInstantPdfDocument({
    manifest: input.manifest,
    instant: instantPayload,
    logoDataUrl: resolvedLogo.dataUrl,
    logoColorizedFallback: resolvedLogo.colorizedFallback,
    brandingColors,
    fontData,
    rgbTiffBase64: input.rgbContent ? Buffer.from(input.rgbContent).toString("base64") : null,
    preparedForOverride: normalizePreparedForOverride(input.preparedFor),
    hasPreparedForOverride: input.preparedFor !== undefined,
    showPreparedFor: input.showPreparedFor !== false
  });
}

async function renderInstantPdfDocument(input: {
  manifest: ProjectManifest;
  instant: Record<string, unknown>;
  logoDataUrl: string;
  logoColorizedFallback: boolean;
  brandingColors: {
    primary: string;
    secondary: string;
  };
  fontData: {
    regular: string;
    bold: string;
  };
  rgbTiffBase64: string | null;
  preparedForOverride?: Record<string, unknown> | null;
  hasPreparedForOverride?: boolean;
  showPreparedFor?: boolean;
}) {
  const assets = await loadInstantPdfAssets();
  const browser = await chromium.launch({
    executablePath: assets.browserExecutablePath,
    headless: true,
    args: [
      "--disable-gpu",
      "--font-render-hinting=medium",
      "--disable-dev-shm-usage"
    ]
  });

  try {
    const layout = {
      pageWidth: PAGE_WIDTH_PX,
      pageHeight: PAGE_HEIGHT_PX,
      pageWidthMm: PAGE_WIDTH_MM,
      pageHeightMm: PAGE_HEIGHT_MM,
      primaryStrip: REPORT_PRIMARY_STRIP_PX,
      secondaryStrip: REPORT_SECONDARY_STRIP_PX,
      contentLeft: REPORT_CONTENT_LEFT_PX,
      contentRight: REPORT_CONTENT_RIGHT_PX,
      topMargin: REPORT_TOP_MARGIN_PX,
      logoHeight: REPORT_LOGO_HEIGHT_PX,
      logoLeft: REPORT_LOGO_LEFT_PX,
      sectionGap: REPORT_SECTION_GAP_PX,
      thumbGap: REPORT_THUMB_GAP_PX,
      thumbBottom: REPORT_THUMB_BOTTOM_PX,
      cardRadius: REPORT_CARD_RADIUS_PX,
      cardShadowOffset: REPORT_CARD_SHADOW_OFFSET_PX,
      cardBorder: REPORT_CARD_BORDER_PX,
      pxPerMm: PX_PER_MM,
      instantReportQuadViewEnabled: INSTANT_REPORT_QUAD_VIEW_ENABLED
    };
    const page = await browser.newPage({
      viewport: { width: 1836, height: 2376 },
      deviceScaleFactor: 1
    });
    await page.emulateMedia({ media: "screen" });

    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><title>Instant PDF</title></head><body><div id="app"></div></body></html>`, {
      waitUntil: "domcontentloaded"
    });
    await page.addScriptTag({ path: assets.geotiffScriptPath });
    await page.addScriptTag({ path: assets.threeScriptPath });
    await page.addScriptTag({ path: assets.orbitControlsPath });

    await page.evaluate(async (payload) => {
      const app = document.getElementById("app");
      if (!app) {
        throw new Error("Instant PDF root element is missing.");
      }

      const rgbTiffBase64 = typeof payload.rgbTiffBase64 === "string" ? payload.rgbTiffBase64 : null;
      const instant = (payload.instant && typeof payload.instant === "object")
        ? payload.instant
        : {};
      const renderData = (instant.render_data && typeof instant.render_data === "object")
        ? instant.render_data
        : null;
      if (!renderData) {
        throw new Error("Instant PDF render data is unavailable.");
      }

      const structureBounds = resolveSelectedStructureBounds(instant, {
        left: 0,
        top: 0,
        right: 1,
        bottom: 1
      });
      const modelCropSquare = computeSquareBoundsAroundBox(structureBounds, 0.5);
      const modelCropBounds = squareToBox(modelCropSquare);
      const textureCanvas = await buildTextureCanvas(rgbTiffBase64, renderData);
      const croppedTextureCanvas = cropCanvasToBounds(textureCanvas, modelCropBounds);
      const focusedRenderData = cropRenderData(renderData, modelCropBounds, structureBounds);
      const modelViews = await buildModelViews(
        focusedRenderData,
        croppedTextureCanvas,
        null,
        payload.layout.instantReportQuadViewEnabled === true
      );
      const stats = buildStats(instant);
      const allStructures = collectAllStructures(instant);
      const address = String(instant.address || payload.manifest?.address || "").trim();
      const dateText = formatReportDate(payload.manifest);
      const preparedFor = resolvePreparedFor(
        instant,
        payload.manifest,
        payload.preparedForOverride,
        payload.hasPreparedForOverride === true,
        payload.showPreparedFor !== false
      );
      const primaryColor = normalizeHexColor(payload.brandingColors?.primary, "#c82828");
      const secondaryColor = normalizeHexColor(payload.brandingColors?.secondary, "#960000");

      app.innerHTML = `
        <style>
          @page{
            size:${payload.layout.pageWidth}px ${payload.layout.pageHeight}px;
            margin:0;
          }
          @font-face{
            font-family:'Montserrat';
            src:url('${escapeHtml(payload.fontData?.regular || "")}') format('truetype');
            font-weight:400;
            font-style:normal;
          }
          @font-face{
            font-family:'Montserrat';
            src:url('${escapeHtml(payload.fontData?.bold || "")}') format('truetype');
            font-weight:700;
            font-style:normal;
          }
          :root{
            --ink:#19202a;
            --muted:#68707c;
            --line-primary:${escapeHtml(primaryColor)};
            --line-secondary:${escapeHtml(secondaryColor)};
            --card:#ffffff;
            --border:#dcdcdc;
            --shadow:#e6e6e6;
          }
          *{box-sizing:border-box}
          html,body{margin:0; padding:0; background:#ffffff; font-family:'Montserrat', Arial, Helvetica, sans-serif; color:var(--ink)}
          body{width:${payload.layout.pageWidth}px; min-height:${payload.layout.pageHeight}px}
          #app{width:${payload.layout.pageWidth}px}
          .pdfDoc{
            width:${payload.layout.pageWidth}px;
          }
          .page{
            width:${payload.layout.pageWidth}px;
            height:${payload.layout.pageHeight}px;
            position:relative;
            background:#ffffff;
            overflow:hidden;
            break-after:page;
            page-break-after:always;
          }
          .page:last-child{
            break-after:auto;
            page-break-after:auto;
          }
          .linePrimary{
            position:absolute;
            left:0;
            top:0;
            bottom:0;
            width:${payload.layout.primaryStrip}px;
            background:var(--line-primary);
          }
          .lineSecondary{
            position:absolute;
            left:${payload.layout.primaryStrip}px;
            top:0;
            bottom:0;
            width:${payload.layout.secondaryStrip}px;
            background:var(--line-secondary);
          }
          .content{
            position:absolute;
            inset:0;
          }
          .brand{
            position:absolute;
            left:${payload.layout.logoLeft}px;
            top:${payload.layout.topMargin}px;
            display:flex;
            align-items:flex-start;
            justify-content:flex-start;
            height:${payload.layout.logoHeight}px;
          }
          .brand img{
            width:auto;
            height:${payload.layout.logoHeight}px;
            max-height:${payload.layout.logoHeight}px;
            object-fit:contain;
          }
          .brandLogoFallback{
            display:block;
            width:${Math.round(REPORT_LOGO_HEIGHT_PX * 3.2)}px;
            height:${payload.layout.logoHeight}px;
            background:var(--line-primary);
            -webkit-mask:var(--brand-logo-url) left center / contain no-repeat;
            mask:var(--brand-logo-url) left center / contain no-repeat;
          }
          .pageHeader{
            position:absolute;
            top:${Math.round(15 * payload.layout.pxPerMm)}px;
            right:${Math.round(20 * payload.layout.pxPerMm)}px;
            text-align:right;
            font-size:${Math.round(3.2 * payload.layout.pxPerMm)}px;
            line-height:1.55;
            color:#646464;
            font-weight:400;
          }
          .top{
            position:absolute;
            left:${payload.layout.contentLeft}px;
            right:${payload.layout.contentRight}px;
            top:${Math.round(40 * payload.layout.pxPerMm)}px;
            display:grid;
            grid-template-columns:minmax(0, 2fr) minmax(0, 1fr);
            gap:${payload.layout.sectionGap}px;
            align-items:stretch;
          }
          .reportCard{
            background:var(--card);
            border:${payload.layout.cardBorder}px solid var(--border);
            border-radius:${payload.layout.cardRadius}px;
            box-shadow:${payload.layout.cardShadowOffset}px ${payload.layout.cardShadowOffset}px 0 var(--shadow);
          }
          .heroCard{
            overflow:hidden;
            width:100%;
            aspect-ratio:1 / 1;
            position:relative;
          }
          .heroCard img{
            width:100%;
            height:100%;
            object-fit:cover;
            display:block;
            background:#eef1f4;
          }
          .heroLabels{
            position:absolute;
            inset:0;
            pointer-events:none;
          }
          .heroLabel{
            position:absolute;
            transform:translate(-50%, -50%);
            min-width:46px;
            height:46px;
            padding:0 14px;
            border-radius:999px;
            border:3px solid rgba(255,255,255,0.96);
            background:rgba(18,26,37,0.88);
            color:#ffffff;
            display:flex;
            align-items:center;
            justify-content:center;
            font-size:22px;
            font-weight:800;
            line-height:1;
            letter-spacing:0.02em;
            box-shadow:0 10px 26px rgba(0,0,0,0.26);
          }
          .heroLabel.missing{
            background:rgba(132,43,43,0.9);
          }
          .thumbRow{
            position:absolute;
            left:${payload.layout.contentLeft}px;
            right:${payload.layout.contentRight}px;
            bottom:${payload.layout.thumbBottom}px;
            display:grid;
            grid-template-columns: repeat(4, 1fr);
            gap:${payload.layout.thumbGap}px;
            align-items:start;
          }
          .thumb{
            background:transparent;
            border:none;
            border-radius:0;
            overflow:visible;
          }
          .thumb img{
            width:100%;
            aspect-ratio:1 / 1;
            object-fit:cover;
            display:block;
            background:transparent;
          }
          .thumbLabel{
            padding:14px 0 0;
            font-size:18px;
            font-weight:800;
            letter-spacing:0.04em;
            color:#4c5663;
            text-align:center;
          }
          .overviewLowerStack{
            position:absolute;
            left:${payload.layout.contentLeft}px;
            right:${payload.layout.contentRight}px;
            top:${Math.round(160 * payload.layout.pxPerMm)}px;
            height:${Math.round(96 * payload.layout.pxPerMm)}px;
            display:grid;
            grid-template-rows:${Math.round(36 * payload.layout.pxPerMm)}px minmax(0, 1fr);
            gap:${payload.layout.sectionGap}px;
          }
          .overviewWasteCard,
          .overviewNotesCard{
            padding:${Math.round(7 * payload.layout.pxPerMm)}px ${Math.round(8 * payload.layout.pxPerMm)}px;
          }
          .wasteTable{
            width:100%;
            border-collapse:collapse;
            table-layout:fixed;
            margin-top:${Math.round(3 * payload.layout.pxPerMm)}px;
          }
          .wasteTable th,
          .wasteTable td{
            border:none;
            padding:${Math.round(2 * payload.layout.pxPerMm)}px ${Math.round(2 * payload.layout.pxPerMm)}px;
            text-align:center;
            line-height:1.1;
          }
          .wasteTable th:not(:last-child),
          .wasteTable td:not(:last-child){
            border-right:${payload.layout.cardBorder}px solid var(--border);
          }
          .wasteTable th{
            border-bottom:${payload.layout.cardBorder}px solid var(--border);
          }
          .wasteTable th{
            color:#596472;
            font-size:22px;
            font-weight:800;
            letter-spacing:0;
            text-transform:none;
            background:transparent;
          }
          .wasteTable td{
            color:#1c2531;
            font-weight:800;
            text-align:center;
            font-size:28px;
            padding-top:${Math.round(2.5 * payload.layout.pxPerMm)}px;
            padding-bottom:${Math.round(2.5 * payload.layout.pxPerMm)}px;
          }
          .wasteNotesLabel{
            font-size:18px;
            font-weight:800;
            color:#596472;
          }
          .metaCard{
            padding:${Math.round(8 * payload.layout.pxPerMm)}px ${Math.round(5.6 * payload.layout.pxPerMm)}px ${Math.round(7 * payload.layout.pxPerMm)}px;
            display:flex;
            flex-direction:column;
            gap:${Math.round(3 * payload.layout.pxPerMm)}px;
            min-height:100%;
          }
          .metaCard.hasPreparedFor{
            padding:${Math.round(6.5 * payload.layout.pxPerMm)}px ${Math.round(4.6 * payload.layout.pxPerMm)}px ${Math.round(6 * payload.layout.pxPerMm)}px;
            gap:${Math.round(2.2 * payload.layout.pxPerMm)}px;
          }
          .eyebrow{
            font-size:16px;
            letter-spacing:0.12em;
            text-transform:uppercase;
            color:#7b8591;
            font-weight:800;
            margin-bottom:8px;
          }
          .addr{
            font-size:35px;
            line-height:1.14;
            font-weight:800;
            margin-bottom:12px;
          }
          .date{
            font-size:19px;
            color:#6f7883;
            font-weight:700;
            margin-bottom:0;
          }
          .metaCard.hasPreparedFor .eyebrow{
            margin-bottom:10px;
          }
          .sectionTitle{
            font-size:22px;
            font-weight:800;
            margin-bottom:0;
            color:#4b5562;
          }
          .metaCard.hasPreparedFor .sectionTitle{
            font-size:20px;
            margin-bottom:0;
          }
          .preparedForBlock{
            margin-bottom:0;
          }
          .preparedForName{
            font-size:32px;
            line-height:1.14;
            font-weight:800;
            color:#1c2531;
            word-break:break-word;
          }
          .preparedForLine{
            margin-top:8px;
            font-size:18px;
            line-height:1.45;
            font-weight:700;
            color:#596472;
            word-break:break-word;
          }
          .statGrid{
            display:grid;
            grid-template-columns:1fr;
            grid-template-rows:repeat(2, minmax(0, 1fr));
            gap:${Math.round(5 * payload.layout.pxPerMm)}px;
            flex:1;
            min-height:0;
            margin-top:${Math.round(2 * payload.layout.pxPerMm)}px;
          }
          .metaCard.hasPreparedFor .statGrid{
            gap:${Math.round(4 * payload.layout.pxPerMm)}px;
            margin-top:${Math.round(1 * payload.layout.pxPerMm)}px;
          }
          .stat{
            border:${payload.layout.cardBorder}px solid var(--border);
            border-radius:${payload.layout.cardRadius}px;
            padding:${Math.round(5.5 * payload.layout.pxPerMm)}px ${Math.round(5 * payload.layout.pxPerMm)}px ${Math.round(5 * payload.layout.pxPerMm)}px;
            background:#ffffff;
            display:flex;
            flex-direction:column;
            justify-content:center;
            min-height:0;
          }
          .metaCard.hasPreparedFor .stat{
            padding:${Math.round(4.5 * payload.layout.pxPerMm)}px ${Math.round(4 * payload.layout.pxPerMm)}px;
          }
          .statK{
            font-size:16px;
            font-weight:800;
            text-transform:uppercase;
            letter-spacing:0.08em;
            color:#7b8591;
            margin-bottom:16px;
          }
          .metaCard.hasPreparedFor .statK{
            font-size:15px;
            margin-bottom:12px;
          }
          .statV{
            font-size:52px;
            font-weight:800;
            line-height:1.02;
          }
          .metaCard.hasPreparedFor .statV{
            font-size:46px;
          }
          .breakdownContent{
            position:absolute;
            left:${payload.layout.contentLeft}px;
            right:${payload.layout.contentRight}px;
            top:${Math.round(40 * payload.layout.pxPerMm)}px;
            bottom:${payload.layout.thumbBottom}px;
            display:flex;
            flex-direction:column;
          }
          .breakdownGrid{
            display:grid;
            gap:${payload.layout.sectionGap}px;
            margin-top:${Math.round(12 * payload.layout.pxPerMm)}px;
            flex:1;
            align-content:stretch;
          }
          .breakdownGrid.cols2{
            grid-template-columns:repeat(2, minmax(0, 1fr));
          }
          .breakdownGrid.quads{
            grid-template-columns:repeat(2, minmax(0, 1fr));
            grid-template-rows:repeat(2, minmax(0, 1fr));
            grid-auto-rows:minmax(0, 1fr);
          }
          .structureCard{
            padding:${Math.round(7 * payload.layout.pxPerMm)}px;
            display:flex;
            flex-direction:column;
            min-height:0;
          }
          .structureCardHeader{
            display:flex;
            align-items:flex-start;
            justify-content:space-between;
            gap:16px;
            margin-bottom:16px;
          }
          .structureCardEyebrow{
            font-size:15px;
            letter-spacing:0.12em;
            text-transform:uppercase;
            color:#7b8591;
            font-weight:800;
            margin-bottom:8px;
          }
          .structureCardTitle{
            font-size:32px;
            line-height:1.1;
            font-weight:800;
          }
          .structureCardMeta{
            margin-top:8px;
            font-size:18px;
            line-height:1.4;
            color:#66707c;
            font-weight:700;
          }
          .structureBadge{
            flex-shrink:0;
            min-width:58px;
            height:58px;
            padding:0 16px;
            border-radius:999px;
            background:rgba(25,32,42,0.08);
            border:${payload.layout.cardBorder}px solid rgba(25,32,42,0.12);
            display:flex;
            align-items:center;
            justify-content:center;
            font-size:30px;
            font-weight:800;
            color:#1c2531;
          }
          .structureBadge.missing{
            background:rgba(160,54,54,0.1);
            border-color:rgba(160,54,54,0.2);
            color:#842b2b;
          }
          .structureMetricGrid{
            display:grid;
            grid-template-columns:repeat(2, minmax(0, 1fr));
            gap:${Math.round(4 * payload.layout.pxPerMm)}px;
            margin-top:auto;
          }
          .structureMetric{
            border:${payload.layout.cardBorder}px solid var(--border);
            border-radius:${payload.layout.cardRadius}px;
            padding:${Math.round(4.5 * payload.layout.pxPerMm)}px ${Math.round(4.5 * payload.layout.pxPerMm)}px ${Math.round(4 * payload.layout.pxPerMm)}px;
            background:#ffffff;
          }
          .structureMetric.full{
            grid-column:1 / -1;
          }
          .structureMetricK{
            font-size:14px;
            font-weight:800;
            text-transform:uppercase;
            letter-spacing:0.08em;
            color:#7b8591;
            margin-bottom:8px;
          }
          .structureMetricV{
            font-size:28px;
            font-weight:800;
            line-height:1.14;
          }
          .structureMetricSub{
            margin-top:6px;
            font-size:16px;
            line-height:1.45;
            color:#66707c;
            font-weight:700;
          }
          .structureAlert{
            margin-top:auto;
            border:${payload.layout.cardBorder}px solid rgba(132,43,43,0.22);
            border-radius:${payload.layout.cardRadius}px;
            padding:${Math.round(5 * payload.layout.pxPerMm)}px;
            background:linear-gradient(180deg, rgba(160,54,54,0.08), rgba(160,54,54,0.03));
          }
          .structureAlertTitle{
            font-size:22px;
            font-weight:800;
            line-height:1.2;
            color:#842b2b;
          }
          .structureAlertText{
            margin-top:10px;
            font-size:18px;
            line-height:1.5;
            color:#5c6673;
            font-weight:700;
          }
          .pageIndex{
            position:absolute;
            right:${payload.layout.contentRight}px;
            bottom:${Math.round(10 * payload.layout.pxPerMm)}px;
            font-size:15px;
            color:#7b8591;
            font-weight:700;
          }
        </style>
        <div class="pdfDoc">
          ${buildOverviewPage({
            address,
            dateText,
            logoDataUrl: payload.logoDataUrl,
            logoColorizedFallback: payload.logoColorizedFallback === true,
            modelViews,
            stats,
            preparedFor,
            instantPayload: instant,
            modelCropBounds,
            allStructures
          })}
          ${buildBreakdownPages({
            address,
            dateText,
            logoDataUrl: payload.logoDataUrl,
            logoColorizedFallback: payload.logoColorizedFallback === true,
            instantPayload: instant,
            allStructures
          })}
        </div>
      `;

      const allImages = Array.from(document.images);
      await Promise.all(allImages.map((image) => new Promise((resolve) => {
        if (image.complete) {
          resolve(null);
          return;
        }
        image.addEventListener("load", () => resolve(null), { once: true });
        image.addEventListener("error", () => resolve(null), { once: true });
      })));

      function buildThumb(label: string, src: string) {
        return `<div class="thumb"><img src="${escapeHtml(src)}" alt="${escapeHtml(label)} view"><div class="thumbLabel">${escapeHtml(label)}</div></div>`;
      }

      function buildStat(label: string, value: string) {
        return `<div class="stat"><div class="statK">${escapeHtml(label)}</div><div class="statV">${escapeHtml(value)}</div></div>`;
      }

      function buildBrandLogo(logoDataUrl: string, colorizedFallback: boolean) {
        if (!colorizedFallback) {
          return `<img src="${escapeHtml(logoDataUrl)}" alt="Logo">`;
        }
        return `<span class="brandLogoFallback" aria-label="Logo" style="--brand-logo-url:url('${escapeCssSingleQuotedUrl(logoDataUrl)}')"></span>`;
      }

      function escapeCssSingleQuotedUrl(value: string) {
        return String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      }

      function buildOverviewPage(input: {
        address: string;
        dateText: string;
        logoDataUrl: string;
        logoColorizedFallback: boolean;
        modelViews: {
          top: string;
          north: string;
          south: string;
          east: string;
          west: string;
          hasQuadViews: boolean;
        };
        stats: {
          squareCountRange: string;
          pitchRange: string;
          wasteTable: Array<{ waste: string; squares: string }>;
        };
        preparedFor: {
          name: string;
          email: string;
          phone: string;
        } | null;
        instantPayload: any;
        modelCropBounds: { left: number; top: number; right: number; bottom: number };
        allStructures: Array<any>;
      }) {
        const metaCard = input.preparedFor
          ? `
            <div class="metaCard reportCard hasPreparedFor">
              ${buildPreparedForSection(input.preparedFor)}
              <div class="sectionTitle">Instant Overview</div>
              <div class="statGrid">
                ${buildStat("Square Range", input.stats.squareCountRange)}
                ${buildStat("Pitch", input.stats.pitchRange)}
              </div>
            </div>
          `
          : `
            <div class="metaCard reportCard">
              <div class="eyebrow">FirstMeasure Instant</div>
              <div class="addr">${escapeHtml(input.address || "Property Address")}</div>
              <div class="date">${escapeHtml(input.dateText)}</div>
              <div class="sectionTitle">Instant Overview</div>
              <div class="statGrid">
                ${buildStat("Square Range", input.stats.squareCountRange)}
                ${buildStat("Pitch", input.stats.pitchRange)}
              </div>
            </div>
          `;
        return `
          <div class="page">
            <div class="linePrimary"></div>
            <div class="lineSecondary"></div>
            <div class="content">
              <div class="pageHeader">
                <div>${escapeHtml(input.address || "Property Address")}</div>
                <div>${escapeHtml(input.dateText)}</div>
              </div>
              <div class="brand">${buildBrandLogo(input.logoDataUrl, input.logoColorizedFallback)}</div>
              <div class="top">
                <div class="heroCard reportCard">
                  <img src="${input.modelViews.top}" alt="Top view">
                  ${buildHeroLabels(input.allStructures, input.modelCropBounds)}
                </div>
                ${metaCard}
              </div>
              ${input.modelViews.hasQuadViews ? `
                <div class="thumbRow">
                  ${buildThumb("North", input.modelViews.north)}
                  ${buildThumb("South", input.modelViews.south)}
                  ${buildThumb("East", input.modelViews.east)}
                  ${buildThumb("West", input.modelViews.west)}
                </div>
              ` : buildWasteTableCard(input.stats.wasteTable)}
              <div class="pageIndex">Page 1</div>
            </div>
          </div>
        `;
      }

      function buildWasteTableCard(rows: Array<{ waste: string; squares: string }>) {
        return `
          <div class="overviewLowerStack">
            <div class="overviewWasteCard reportCard">
              <div class="sectionTitle">Waste Table</div>
              <table class="wasteTable">
                <thead>
                  <tr>
                    ${rows.map((row) => `<th>${escapeHtml(row.waste)}</th>`).join("")}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    ${rows.map((row) => `<td>${escapeHtml(row.squares)}</td>`).join("")}
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="overviewNotesCard reportCard">
              <div class="wasteNotesLabel">Notes</div>
            </div>
          </div>
        `;
      }

      function buildBreakdownPages(input: {
        address: string;
        dateText: string;
        logoDataUrl: string;
        logoColorizedFallback: boolean;
        instantPayload: any;
        allStructures: Array<any>;
      }) {
        const structures = Array.isArray(input.allStructures) ? input.allStructures : [];
        if (structures.length <= 1) {
          return "";
        }
        const chunkSize = 4;
        const chunks: Array<Array<any>> = [];
        for (let index = 0; index < structures.length; index += chunkSize) {
          chunks.push(structures.slice(index, index + chunkSize));
        }
        return chunks.map((chunk, chunkIndex) => {
          const pageNumber = chunkIndex + 2;
          const totalPages = chunks.length + 1;
          return `
            <div class="page">
              <div class="linePrimary"></div>
              <div class="lineSecondary"></div>
              <div class="content">
                <div class="pageHeader">
                  <div>${escapeHtml(input.address || "Property Address")}</div>
                  <div>${escapeHtml(input.dateText)}</div>
                </div>
                <div class="brand">${buildBrandLogo(input.logoDataUrl, input.logoColorizedFallback)}</div>
                <div class="breakdownContent">
                  <div class="addr">Structure Breakdown</div>
                  <div class="breakdownGrid quads">
                    ${chunk.map((structure) => buildStructureCard(structure)).join("")}
                  </div>
                </div>
                <div class="pageIndex">Page ${pageNumber} of ${totalPages}</div>
              </div>
            </div>
          `;
        }).join("");
      }

      function buildPreparedForSection(preparedFor: {
        name: string;
        email: string;
        phone: string;
      }) {
        const lines = [
          preparedFor.email ? `<div class="preparedForLine">${escapeHtml(preparedFor.email)}</div>` : "",
          preparedFor.phone ? `<div class="preparedForLine">${escapeHtml(preparedFor.phone)}</div>` : ""
        ].filter(Boolean).join("");
        return `
          <div class="preparedForBlock">
            <div class="eyebrow">Prepared for</div>
            <div class="preparedForName">${escapeHtml(preparedFor.name || "Customer")}</div>
            ${lines}
          </div>
        `;
      }

      function buildStructureCard(structure: any) {
        const label = String(structure?.label || "?").trim() || "?";
        const hasCoverage = structure?.has_coverage !== false;
        const stats = hasCoverage ? buildStructureStats(structure) : null;
        const coverageMessage = String(structure?.coverage_message || "").trim();
        const fallbackMessage = coverageMessage || "No usable instant data was found for this selected structure.";
        return `
          <div class="structureCard reportCard">
            <div class="structureCardHeader">
              <div>
                <div class="structureCardEyebrow">${hasCoverage ? "Included Structure" : "Excluded Structure"}</div>
                <div class="structureCardTitle">Structure ${escapeHtml(label)}</div>
                <div class="structureCardMeta">${escapeHtml(hasCoverage ? "Measurements shown below" : "No usable instant data available")}</div>
              </div>
              <div class="structureBadge${hasCoverage ? "" : " missing"}">${escapeHtml(label)}</div>
            </div>
            ${hasCoverage && stats ? `
              <div class="structureMetricGrid">
                ${buildStructureMetric("Square Range", stats.squareCountRange)}
                ${buildStructureMetric("Pitch", stats.pitchRange)}
              </div>
            ` : `
              <div class="structureAlert">
                <div class="structureAlertTitle">No usable instant data found</div>
                <div class="structureAlertText">${escapeHtml(fallbackMessage)}</div>
              </div>
            `}
          </div>
        `;
      }

      function resolvePreparedFor(
        instantPayload: any,
        manifest: any,
        preparedForOverride: any,
        hasPreparedForOverride: boolean,
        showPreparedFor: boolean
      ) {
        if (!showPreparedFor) {
          return null;
        }
        if (hasPreparedForOverride) {
          return normalizePreparedFor(preparedForOverride);
        }
        const candidates = [
          instantPayload?.prepared_for,
          instantPayload?.resident,
          manifest?.prepared_for,
          manifest?.resident
        ];
        for (const candidate of candidates) {
          const preparedFor = normalizePreparedFor(candidate);
          if (preparedFor) {
            return preparedFor;
          }
        }
        return null;
      }

      function normalizePreparedFor(value: any) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return null;
        }
        const name = normalizeContactText(value.name);
        const email = normalizeContactText(value.email);
        const phone = normalizeContactText(value.phone);
        if (!name && !email && !phone) {
          return null;
        }
        return {
          name,
          email,
          phone
        };
      }

      function normalizeContactText(value: unknown) {
        return typeof value === "string" ? value.trim() : "";
      }

      function buildStructureMetric(label: string, value: string, fullWidth = false) {
        return `
          <div class="structureMetric${fullWidth ? " full" : ""}">
            <div class="structureMetricK">${escapeHtml(label)}</div>
            <div class="structureMetricV">${escapeHtml(value)}</div>
          </div>
        `;
      }

      function buildStructureStats(structure: any) {
        const segments = Array.isArray(structure?.roof_segments) ? structure.roof_segments : [];
        const roofArea = toNumber(structure?.roof_area?.total_roof_area_meters2)
          ?? toNumber(structure?.mask_area?.roof_area_meters2);
        const pitchDegrees = predominantPitchDegrees(segments);
        const pitchRise = pitchToRise12(pitchDegrees);
        const waste = suggestedWastePercent(pitchDegrees);
        const squareCount = roofArea == null ? null : Math.ceil((roofArea * (1 + (waste / 100))) / 9.290304);
        const wasteTable = buildWasteTable(squareCount);
        return {
          squareCountRange: formatSquareRange(squareCount),
          pitchRange: formatPitchRange(pitchRise),
          wasteTable
        };
      }

      function buildHeroLabels(structures: Array<any>, cropBounds: { left: number; top: number; right: number; bottom: number }) {
        if (!Array.isArray(structures) || structures.length <= 1) {
          return "";
        }
        const width = Math.max(0.0001, cropBounds.right - cropBounds.left);
        const height = Math.max(0.0001, cropBounds.bottom - cropBounds.top);
        const labels = structures.map((structure) => {
          const point = resolveStructureAnchorPoint(structure);
          if (!point) {
            return "";
          }
          const left = ((point.x - cropBounds.left) / width) * 100;
          const top = ((point.y - cropBounds.top) / height) * 100;
          if (!Number.isFinite(left) || !Number.isFinite(top)) {
            return "";
          }
          if (left < 0 || left > 100 || top < 0 || top > 100) {
            return "";
          }
          const label = String(structure?.label || "").trim();
          if (!label) {
            return "";
          }
          const missingClass = structure?.has_coverage === false ? " missing" : "";
          return `<div class="heroLabel${missingClass}" style="left:${left.toFixed(3)}%; top:${top.toFixed(3)}%;">${escapeHtml(label)}</div>`;
        }).filter(Boolean);
        if (!labels.length) {
          return "";
        }
        return `<div class="heroLabels">${labels.join("")}</div>`;
      }

      function escapeHtml(value: unknown) {
        return String(value ?? "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      }

      function formatReportDate(manifest: Record<string, unknown>) {
        const timestamps = asPlainObject(manifest.timestamps);
        const processedAt = String(timestamps.processed_at || timestamps.updated_at || "").trim();
        const candidate = processedAt
          ? new Date(processedAt.includes("T") ? processedAt : `${processedAt.replace(" ", "T")}Z`)
          : new Date();
        const safeDate = Number.isNaN(candidate.getTime()) ? new Date() : candidate;
        return safeDate.toLocaleDateString("en-US", {
          month: "long",
          day: "numeric",
          year: "numeric"
        });
      }

      function buildStats(instantPayload: any) {
        const structures = collectRenderableStructures(instantPayload);
        const largestStructure = selectLargestStructure(structures);
        const segments = Array.isArray(largestStructure?.roof_segments) ? largestStructure.roof_segments : [];
        const roofArea = toNumber(instantPayload?.roof_area?.total_roof_area_meters2)
          ?? sumNumbers(structures.map((structure: any) => toNumber(structure?.mask_area?.roof_area_meters2)));
        const pitchDegrees = predominantPitchDegrees(segments);
        const pitchRise = pitchToRise12(pitchDegrees);
        const waste = suggestedWastePercent(pitchDegrees);
        const squareCount = roofArea == null ? null : Math.ceil((roofArea * (1 + (waste / 100))) / 9.290304);
        const wasteTable = buildWasteTable(squareCount);
        return {
          squareCountRange: formatSquareRange(squareCount),
          pitchRange: formatPitchRange(pitchRise),
          wasteTable
        };
      }

      function selectLargestStructure(structures: Array<any>) {
        if (!Array.isArray(structures) || !structures.length) {
          return null;
        }
        return structures
          .map((structure) => ({
            structure,
            area: toNumber(structure?.roof_area?.total_roof_area_meters2)
              ?? toNumber(structure?.mask_area?.roof_area_meters2)
              ?? toNumber(structure?.mask_area?.ground_area_meters2)
              ?? toNumber(structure?.roof_area?.building_ground_area_meters2)
              ?? 0
          }))
          .sort((a, b) => b.area - a.area)[0]?.structure ?? structures[0];
      }

      function collectAllStructures(instantPayload: any) {
        const structures = Array.isArray(instantPayload?.structures) ? instantPayload.structures : [];
        return structures.length ? structures : collectRenderableStructures(instantPayload);
      }

      function collectRenderableStructures(instantPayload: any) {
        const structures = Array.isArray(instantPayload?.structures) ? instantPayload.structures : [];
        const covered = structures.filter((structure: any) => structure?.has_coverage !== false);
        return covered.length ? covered : structures.slice(0, 1);
      }

      function suggestedWastePercent(pitchDegrees: number | null) {
        let base = 8;
        if (pitchDegrees != null) {
          if (pitchDegrees >= 45) base = 14;
          else if (pitchDegrees >= 35) base = 12;
          else if (pitchDegrees >= 25) base = 10;
        }
        return base + 10;
      }

      function predominantPitchDegrees(segments: Array<any>) {
        if (!Array.isArray(segments) || !segments.length) return null;
        const best = segments
          .map((segment) => ({
            pitch: toNumber(segment?.pitch_degrees),
            area: toNumber(segment?.roof_area_meters2) || 0
          }))
          .filter((entry) => entry.pitch != null)
          .sort((a, b) => b.area - a.area)[0];
        return best?.pitch ?? null;
      }

      function pitchToRise12(degrees: number | null) {
        const pitch = toNumber(degrees);
        if (pitch == null) return null;
        return Math.max(1, Math.round(Math.tan((pitch * Math.PI) / 180) * 12));
      }

      function formatPitchRange(pitchRise: number | null) {
        const rise = toNumber(pitchRise);
        if (rise == null) return "-";
        return `${rise}/12`;
      }

      function buildWasteTable(squareCount: number | null) {
        const baseCount = toNumber(squareCount);
        return [5, 10, 15, 20, 25].map((wastePercent) => ({
          waste: `${wastePercent}%`,
          squares: formatSquareCount(
            baseCount == null ? null : Math.ceil(baseCount * (1 + ((wastePercent - 5) / 100)))
          )
        }));
      }

      function formatSquareRange(squareCount: number | null) {
        const count = toNumber(squareCount);
        if (count == null) return "-";
        const high = count;
        const low = Math.max(1, high - 2);
        return `${low} to ${high} Squares`;
      }

      function formatSquareCount(squareCount: number | null) {
        const count = toNumber(squareCount);
        if (count == null) return "-";
        return `${count} Squares`;
      }

      function toNumber(value: unknown) {
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
      }

      function asPlainObject(value: unknown): Record<string, unknown> {
        return (value && typeof value === "object" && !Array.isArray(value))
          ? value as Record<string, unknown>
          : {};
      }

      function normalizeHexColor(value: unknown, fallback: string) {
        const raw = String(value || "").trim();
        if (/^#[0-9a-f]{6}$/i.test(raw)) return raw;
        if (/^[0-9a-f]{6}$/i.test(raw)) return `#${raw}`;
        return fallback;
      }

      async function buildTextureCanvas(rgbBase64: string | null, fallbackRenderData: any) {
        if (!rgbBase64 || !window.GeoTIFF?.fromArrayBuffer) {
          return buildFallbackTexture(fallbackRenderData);
        }
        try {
          const bytes = base64ToUint8(rgbBase64);
          const tiff = await window.GeoTIFF.fromArrayBuffer(bytes.buffer);
          const image = await tiff.getImage();
          const width = Number(image.getWidth()) || 1;
          const height = Number(image.getHeight()) || 1;
          const maxDimension = 1200;
          const scale = Math.min(1, maxDimension / Math.max(width, height, 1));
          const targetWidth = Math.max(1, Math.round(width * scale));
          const targetHeight = Math.max(1, Math.round(height * scale));
          const samples = [0, 1, 2];
          const raster = await image.readRasters({
            interleave: true,
            width: targetWidth,
            height: targetHeight,
            samples
          });
          const canvas = document.createElement("canvas");
          canvas.width = targetWidth;
          canvas.height = targetHeight;
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("2D context unavailable.");
          const imageData = ctx.createImageData(targetWidth, targetHeight);
          const source = raster;
          const channels = Math.max(1, Math.round(source.length / Math.max(1, targetWidth * targetHeight)));
          for (let pixelIndex = 0; pixelIndex < targetWidth * targetHeight; pixelIndex += 1) {
            const srcIndex = pixelIndex * channels;
            const dstIndex = pixelIndex * 4;
            const red = Number(source[srcIndex] ?? 0);
            const green = Number(source[srcIndex + Math.min(1, channels - 1)] ?? red);
            const blue = Number(source[srcIndex + Math.min(2, channels - 1)] ?? red);
            imageData.data[dstIndex] = clampByte(red);
            imageData.data[dstIndex + 1] = clampByte(green);
            imageData.data[dstIndex + 2] = clampByte(blue);
            imageData.data[dstIndex + 3] = 255;
          }
          ctx.putImageData(imageData, 0, 0);
          return canvas;
        } catch {
          return buildFallbackTexture(fallbackRenderData);
        }
      }

      function buildFallbackTexture(renderInfo: any) {
        const cols = Math.max(12, Number(renderInfo?.cols) || 48);
        const rows = Math.max(12, Number(renderInfo?.rows) || 48);
        const canvas = document.createElement("canvas");
        canvas.width = cols;
        canvas.height = rows;
        const ctx = canvas.getContext("2d");
        if (!ctx) return canvas;
        const imageData = ctx.createImageData(cols, rows);
        const heights = Array.isArray(renderInfo?.heights_meters) ? renderInfo.heights_meters : [];
        const masks = Array.isArray(renderInfo?.mask) ? renderInfo.mask : [];
        const maxHeight = Math.max(1, ...heights.map((value: unknown) => Number(value) || 0));
        for (let index = 0; index < cols * rows; index += 1) {
          const heightValue = Number(heights[index] || 0);
          const maskValue = Number(masks[index] || 0);
          const tone = Math.round((heightValue / maxHeight) * 180) + 40;
          const dst = index * 4;
          imageData.data[dst] = tone;
          imageData.data[dst + 1] = Math.min(255, tone + 18);
          imageData.data[dst + 2] = Math.min(255, tone + 28);
          imageData.data[dst + 3] = Math.round(255 * (maskValue > 0.05 ? 1 : 0.88));
        }
        ctx.putImageData(imageData, 0, 0);
        return canvas;
      }

      async function buildModelViews(
        renderInfo: any,
        textureCanvas: HTMLCanvasElement,
        topSquareBounds: { left: number; top: number; side: number } | null,
        includeQuadViews: boolean
      ) {
        const top = buildTopView(textureCanvas, topSquareBounds);
        if (!includeQuadViews) {
          return { top, north: "", south: "", east: "", west: "", hasQuadViews: false };
        }

        const THREE_NS = window.THREE;
        if (!THREE_NS) {
          throw new Error("Three.js failed to load for instant PDF rendering.");
        }

        const cols = Math.max(12, Number(renderInfo?.cols) || 48);
        const rows = Math.max(12, Number(renderInfo?.rows) || 48);
        const heights = Array.isArray(renderInfo?.heights_meters) ? renderInfo.heights_meters : [];
        const masks = Array.isArray(renderInfo?.mask) ? renderInfo.mask : [];
        const aspect = cols / Math.max(rows, 1);
        const planeWidth = aspect >= 1 ? 108 : 108 * aspect;
        const planeHeight = aspect >= 1 ? 108 / Math.max(aspect, 0.001) : 108;
        const maxHeightMeters = Math.max(0.5, Number(renderInfo?.max_height_meters) || Math.max(...heights.map((value: unknown) => Number(value) || 0), 0.5));
        const maxHeightScene = Math.max(8, Math.min(34, maxHeightMeters * Math.max(1.3, 30 / Math.max(maxHeightMeters, 1))));
        const verticalScale = maxHeightScene / Math.max(maxHeightMeters, 0.5);

        const canvas = document.createElement("canvas");
        canvas.width = 780;
        canvas.height = 780;
        const renderer = new THREE_NS.WebGLRenderer({
          canvas,
          antialias: true,
          alpha: false,
          preserveDrawingBuffer: true
        });
        renderer.setSize(canvas.width, canvas.height, false);
        if ("outputEncoding" in renderer && typeof THREE_NS.sRGBEncoding !== "undefined") {
          renderer.outputEncoding = THREE_NS.sRGBEncoding;
        }

        const scene = new THREE_NS.Scene();
        scene.background = new THREE_NS.Color(0xf4f5f7);
        const camera = new THREE_NS.PerspectiveCamera(34, canvas.width / canvas.height, 0.1, 1200);
        scene.add(new THREE_NS.HemisphereLight(0xffffff, 0xdfe4e8, 0.82));
        const keyLight = new THREE_NS.DirectionalLight(0xffffff, 0.56);
        keyLight.position.set(-planeWidth * 0.5, maxHeightScene * 2.8, planeHeight * 0.9);
        scene.add(keyLight);
        scene.add(new THREE_NS.AmbientLight(0xffffff, 0.16));

        const geometry = new THREE_NS.PlaneGeometry(planeWidth, planeHeight, cols - 1, rows - 1);
        const positions = geometry.attributes.position.array;
        for (let row = 0; row < rows; row += 1) {
          for (let col = 0; col < cols; col += 1) {
            const index = (row * cols) + col;
            const heightValue = Number(heights[index] || 0);
            const maskValue = Number(masks[index] || 0);
            positions[(index * 3) + 2] = maskValue >= 0.1 ? Math.max(0, heightValue) * verticalScale : 0;
          }
        }
        geometry.attributes.position.needsUpdate = true;
        geometry.computeVertexNormals();

        const texture = new THREE_NS.CanvasTexture(textureCanvas);
        if ("encoding" in texture && typeof THREE_NS.sRGBEncoding !== "undefined") {
          texture.encoding = THREE_NS.sRGBEncoding;
        }
        texture.needsUpdate = true;

        const material = new THREE_NS.MeshStandardMaterial({
          map: texture,
          side: THREE_NS.DoubleSide,
          roughness: 0.9,
          metalness: 0.03
        });
        const mesh = new THREE_NS.Mesh(geometry, material);
        mesh.rotation.x = -Math.PI / 2;
        scene.add(mesh);

        const bounds = new THREE_NS.Box3().setFromObject(mesh);
        const size = bounds.getSize(new THREE_NS.Vector3());
        const center = bounds.getCenter(new THREE_NS.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z, 1);
        const fitDistance = (maxDim / (2 * Math.tan((camera.fov * Math.PI) / 360))) * 1.38;
        const target = center.clone().add(new THREE_NS.Vector3(0, Math.max(1.2, size.y * 0.08), 0));

        const capture = (x: number, y: number, z: number) => {
          camera.position.copy(center.clone().add(new THREE_NS.Vector3(x, y, z)));
          camera.lookAt(target);
          renderer.render(scene, camera);
          return canvas.toDataURL("image/png");
        };

        const viewDistance = fitDistance * 0.48;
        const elevated = fitDistance * 0.54;
        const north = capture(0, elevated, viewDistance);
        const south = capture(0, elevated, -viewDistance);
        const east = capture(viewDistance, elevated, 0);
        const west = capture(-viewDistance, elevated, 0);

        geometry.dispose();
        material.dispose();
        texture.dispose();
        renderer.dispose();

        return { top, north, south, east, west, hasQuadViews: true };
      }

      function buildTopView(textureCanvas: HTMLCanvasElement, topSquareBounds: { left: number; top: number; side: number } | null) {
        const crop = topSquareBounds
          ? {
              sx: Math.round(topSquareBounds.left * textureCanvas.width),
              sy: Math.round(topSquareBounds.top * textureCanvas.height),
              sw: Math.max(1, Math.round(topSquareBounds.side * textureCanvas.width)),
              sh: Math.max(1, Math.round(topSquareBounds.side * textureCanvas.height))
            }
          : {
              sx: 0,
              sy: 0,
              sw: textureCanvas.width,
              sh: textureCanvas.height
            };
        const canvas = document.createElement("canvas");
        canvas.width = 960;
        canvas.height = 960;
        const ctx = canvas.getContext("2d");
        if (!ctx) return textureCanvas.toDataURL("image/png");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(
          textureCanvas,
          crop.sx,
          crop.sy,
          crop.sw,
          crop.sh,
          0,
          0,
          canvas.width,
          canvas.height
        );
        return canvas.toDataURL("image/png");
      }

      function resolveFocusBounds(instantPayload: any, renderInfo: any) {
        const structures = collectRenderableStructures(instantPayload);
        const raw = unionNormalizedBounds(structures.map((structure: any) => structure?.normalized_padded_bounds))
          || renderInfo?.mask_bounds
          || { left: 0, top: 0, right: 1, bottom: 1 };
        return {
          left: clamp01(toNumber(raw.left) ?? 0),
          top: clamp01(toNumber(raw.top) ?? 0),
          right: clamp01(toNumber(raw.right) ?? 1),
          bottom: clamp01(toNumber(raw.bottom) ?? 1)
        };
      }

      function resolveSelectedStructureBounds(instantPayload: any, fallbackBounds: { left: number; top: number; right: number; bottom: number }) {
        const structures = collectAllStructures(instantPayload);
        const normalized = unionNormalizedBounds(structures.map((structure: any) => (
          resolveStructureSelectionBounds(structure)
        )));
        if (normalized) {
          return normalized;
        }
        return fallbackBounds;
      }

      function resolveStructureSelectionBounds(structure: any) {
        const directBounds = asPlainObject(structure?.normalized_padded_bounds);
        const directLeft = toNumber(directBounds.left);
        const directTop = toNumber(directBounds.top);
        const directRight = toNumber(directBounds.right);
        const directBottom = toNumber(directBounds.bottom);
        if (directLeft != null && directTop != null && directRight != null && directBottom != null) {
          return {
            left: clamp01(directLeft),
            top: clamp01(directTop),
            right: clamp01(directRight),
            bottom: clamp01(directBottom)
          };
        }
        const point = resolveStructureAnchorPoint(structure);
        if (!point) {
          return null;
        }
        const pad = 0.04;
        return {
          left: clamp01(point.x - pad),
          top: clamp01(point.y - pad),
          right: clamp01(point.x + pad),
          bottom: clamp01(point.y + pad)
        };
      }

      function resolveStructureAnchorPoint(structure: any) {
        const bounds = asPlainObject(structure?.normalized_padded_bounds);
        const left = toNumber(bounds.left);
        const top = toNumber(bounds.top);
        const right = toNumber(bounds.right);
        const bottom = toNumber(bounds.bottom);
        if (left != null && top != null && right != null && bottom != null) {
          return {
            x: clamp01((left + right) / 2),
            y: clamp01((top + bottom) / 2)
          };
        }
        return normalizePointWithinProjectExtent(
          structure?.pin ?? structure?.center,
          structure?.project_extent_bounds
        );
      }

      function normalizePointWithinProjectExtent(point: any, projectExtent: any) {
        const lat = toNumber(point?.latitude);
        const lng = toNumber(point?.longitude);
        const swLat = toNumber(projectExtent?.sw?.latitude);
        const swLng = toNumber(projectExtent?.sw?.longitude);
        const neLat = toNumber(projectExtent?.ne?.latitude);
        const neLng = toNumber(projectExtent?.ne?.longitude);
        if ([lat, lng, swLat, swLng, neLat, neLng].some((value) => value == null)) {
          return null;
        }
        const width = Math.max(0.000001, (neLng as number) - (swLng as number));
        const height = Math.max(0.000001, (neLat as number) - (swLat as number));
        return {
          x: clamp01(((lng as number) - (swLng as number)) / width),
          y: clamp01(((neLat as number) - (lat as number)) / height)
        };
      }

      function unionNormalizedBounds(boundsList: Array<any>) {
        let left = Number.POSITIVE_INFINITY;
        let top = Number.POSITIVE_INFINITY;
        let right = Number.NEGATIVE_INFINITY;
        let bottom = Number.NEGATIVE_INFINITY;
        let found = false;
        for (const candidate of boundsList) {
          const raw = asPlainObject(candidate);
          const nextLeft = toNumber(raw.left);
          const nextTop = toNumber(raw.top);
          const nextRight = toNumber(raw.right);
          const nextBottom = toNumber(raw.bottom);
          if (nextLeft == null || nextTop == null || nextRight == null || nextBottom == null) {
            continue;
          }
          left = Math.min(left, nextLeft);
          top = Math.min(top, nextTop);
          right = Math.max(right, nextRight);
          bottom = Math.max(bottom, nextBottom);
          found = true;
        }
        if (!found) {
          return null;
        }
        return {
          left: clamp01(left),
          top: clamp01(top),
          right: clamp01(right),
          bottom: clamp01(bottom)
        };
      }

      function sumNumbers(values: Array<number | null>) {
        let sum = 0;
        let found = false;
        for (const value of values) {
          if (value == null) continue;
          sum += value;
          found = true;
        }
        return found ? sum : null;
      }

      function cropCanvasToBounds(sourceCanvas: HTMLCanvasElement, bounds: { left: number; top: number; right: number; bottom: number }) {
        const sx = Math.max(0, Math.floor(bounds.left * sourceCanvas.width));
        const sy = Math.max(0, Math.floor(bounds.top * sourceCanvas.height));
        const sw = Math.max(1, Math.ceil((bounds.right - bounds.left) * sourceCanvas.width));
        const sh = Math.max(1, Math.ceil((bounds.bottom - bounds.top) * sourceCanvas.height));
        const canvas = document.createElement("canvas");
        canvas.width = sw;
        canvas.height = sh;
        const ctx = canvas.getContext("2d");
        if (!ctx) return sourceCanvas;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
        return canvas;
      }

      function cropRenderData(renderInfo: any, focusBounds: { left: number; top: number; right: number; bottom: number }, structureBounds: { left: number; top: number; right: number; bottom: number }) {
        const cols = Math.max(12, Number(renderInfo?.cols) || 48);
        const rows = Math.max(12, Number(renderInfo?.rows) || 48);
        const startCol = Math.max(0, Math.floor(focusBounds.left * (cols - 1)));
        const endCol = Math.min(cols - 1, Math.ceil(focusBounds.right * (cols - 1)));
        const startRow = Math.max(0, Math.floor(focusBounds.top * (rows - 1)));
        const endRow = Math.min(rows - 1, Math.ceil(focusBounds.bottom * (rows - 1)));
        const heights: number[] = [];
        const mask: number[] = [];
        let maxHeight = 0;

        for (let row = startRow; row <= endRow; row += 1) {
          for (let col = startCol; col <= endCol; col += 1) {
            const u = cols <= 1 ? 0 : col / (cols - 1);
            const v = rows <= 1 ? 0 : row / (rows - 1);
            const index = (row * cols) + col;
            const insideStructure = (
              u >= structureBounds.left
              && u <= structureBounds.right
              && v >= structureBounds.top
              && v <= structureBounds.bottom
            );
            const nextMask = insideStructure ? Number(renderInfo?.mask?.[index] || 0) : 0;
            const nextHeight = insideStructure ? Math.max(0, Number(renderInfo?.heights_meters?.[index] || 0)) : 0;
            heights.push(nextHeight);
            mask.push(nextMask);
            if (nextMask >= 0.1 && nextHeight > maxHeight) {
              maxHeight = nextHeight;
            }
          }
        }

        return {
          ...renderInfo,
          cols: Math.max(12, endCol - startCol + 1),
          rows: Math.max(12, endRow - startRow + 1),
          heights_meters: heights,
          mask,
          max_height_meters: Math.max(0.5, maxHeight),
          mask_bounds: {
            left: 0,
            top: 0,
            right: 1,
            bottom: 1
          }
        };
      }

      function remapBoundsIntoCrop(bounds: { left: number; top: number; right: number; bottom: number }, crop: { left: number; top: number; right: number; bottom: number }) {
        const width = Math.max(0.0001, crop.right - crop.left);
        const height = Math.max(0.0001, crop.bottom - crop.top);
        return {
          left: clamp01((bounds.left - crop.left) / width),
          top: clamp01((bounds.top - crop.top) / height),
          right: clamp01((bounds.right - crop.left) / width),
          bottom: clamp01((bounds.bottom - crop.top) / height)
        };
      }

      function computeSquareBoundsAroundBox(bounds: { left: number; top: number; right: number; bottom: number }, minFillRatio: number) {
        const width = Math.max(0.06, bounds.right - bounds.left);
        const height = Math.max(0.06, bounds.bottom - bounds.top);
        const desiredSide = Math.min(1, Math.max(width, height) / Math.max(0.01, Math.min(1, minFillRatio)));
        return clampSquare({
          left: ((bounds.left + bounds.right) / 2) - (desiredSide / 2),
          top: ((bounds.top + bounds.bottom) / 2) - (desiredSide / 2),
          side: desiredSide
        });
      }

      function squareToBox(square: { left: number; top: number; side: number }) {
        return {
          left: square.left,
          top: square.top,
          right: square.left + square.side,
          bottom: square.top + square.side
        };
      }

      function clampSquare(value: { left: number; top: number; side: number }) {
        const side = Math.max(0.06, Math.min(1, value.side));
        const maxOrigin = 1 - side;
        return {
          side,
          left: Math.max(0, Math.min(maxOrigin, value.left)),
          top: Math.max(0, Math.min(maxOrigin, value.top))
        };
      }

      function clamp01(value: number) {
        return Math.max(0, Math.min(1, value));
      }

      function base64ToUint8(value: string) {
        const binary = atob(value);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        return bytes;
      }

      function clampByte(value: unknown) {
        return Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
      }
    }, {
      manifest: input.manifest,
      instant: input.instant,
      logoDataUrl: input.logoDataUrl,
      logoColorizedFallback: input.logoColorizedFallback,
      brandingColors: input.brandingColors,
      fontData: input.fontData,
      rgbTiffBase64: input.rgbTiffBase64,
      preparedForOverride: input.preparedForOverride ?? null,
      hasPreparedForOverride: input.hasPreparedForOverride === true,
      showPreparedFor: input.showPreparedFor !== false,
      layout
    });

    const pdf = await page.pdf({
      printBackground: true,
      preferCSSPageSize: true,
      margin: {
        top: "0",
        right: "0",
        bottom: "0",
        left: "0"
      }
    });
    return finalizeFirstMatePdf(pdf, {
      title: `${String(input.manifest.address ?? "Property").trim() || "Property"} - FirstMate FirstMeasure Report`,
      subject: "FirstMate FirstMeasure instant roof measurement report",
      keywords: ["FirstMeasure", "roof measurement", "instant report"]
    });
  } finally {
    await browser.close();
  }
}

async function resolveLogoDataUrl(brandingDefaults: unknown) {
  const record = asRecord(brandingDefaults);
  const direct = extractLogoUrl(record);
  if (direct) {
    const remoteDataUrl = await fetchDataUrl(direct).catch(() => null);
    if (remoteDataUrl) {
      return {
        dataUrl: remoteDataUrl,
        colorizedFallback: false
      };
    }
  }

  const assets = await loadInstantPdfAssets();
  const content = await readFile(assets.defaultLogoPath);
  return {
    dataUrl: `data:image/png;base64,${content.toString("base64")}`,
    colorizedFallback: true
  };
}

async function resolveFontDataUrls() {
  const assets = await loadInstantPdfAssets();
  const [regular, bold] = await Promise.all([
    readFile(assets.fontRegularPath),
    readFile(assets.fontBoldPath)
  ]);
  return {
    regular: `data:font/ttf;base64,${regular.toString("base64")}`,
    bold: `data:font/ttf;base64,${bold.toString("base64")}`
  };
}

function resolveBrandingColors(brandingDefaults: unknown) {
  const records = collectBrandingRecords(brandingDefaults);
  return {
    primary: extractHexColor(
      records.flatMap((record) => {
        const colors = asRecord(record.colors);
        return [
          record.primary_color,
          record.primary,
          record.primaryColor,
          colors.primary,
          record.accent_color,
          record.accent,
          colors.accent
        ];
      }),
      "#c82828"
    ),
    secondary: extractHexColor(
      records.flatMap((record) => {
        const colors = asRecord(record.colors);
        return [
          record.secondary_color,
          record.secondary,
          record.secondaryColor,
          colors.secondary
        ];
      }),
      "#960000"
    )
  };
}

function extractHexColor(candidates: unknown[], fallback: string) {
  for (const candidate of candidates) {
    const raw = String(candidate || "").trim();
    if (/^#[0-9a-f]{6}$/i.test(raw)) return raw;
    if (/^[0-9a-f]{6}$/i.test(raw)) return `#${raw}`;
  }
  return fallback;
}

function normalizePreparedForOverride(value: unknown) {
  const source = asRecord(value);
  const name = typeof source.name === "string" ? source.name.trim() : "";
  const email = typeof source.email === "string" ? source.email.trim() : "";
  const phone = typeof source.phone === "string" ? source.phone.trim() : "";
  if (!name && !email && !phone) {
    return null;
  }
  return {
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {})
  } satisfies Record<string, unknown>;
}

function extractLogoUrl(source: Record<string, unknown>) {
  const candidates = collectBrandingRecords(source)
    .flatMap((record) => [
      record.logo_url,
      record.logo,
      record.logo_node_url,
      record.logoDataUrl,
      record.logo_data_url,
      record.logo_path,
      asRecord(record.logo).path,
      asRecord(record.logo).url
    ])
    .filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0)
    .map((candidate) => candidate.trim());
  return candidates.find(isAbsoluteOrDataUrl) ?? candidates[0] ?? null;
}

function isAbsoluteOrDataUrl(value: string) {
  return /^(?:[a-z]+:)?\/\//i.test(value) || value.startsWith("data:");
}

function collectBrandingRecords(source: unknown) {
  const root = asRecord(source);
  const records: Record<string, unknown>[] = [];
  const add = (value: unknown) => {
    const record = asRecord(value);
    if (Object.keys(record).length > 0) {
      records.push(record);
    }
  };

  add(root);
  add(root.branding);

  for (const key of ["report", "default", "full", "main", "summary"]) {
    add(root[key]);
    add(asRecord(root.branding)[key]);
  }

  return records;
}

async function fetchDataUrl(url: string) {
  if (url.startsWith("data:")) {
    return url;
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Logo fetch failed with status ${response.status}.`);
  }
  const contentType = response.headers.get("content-type") || "image/png";
  const buffer = Buffer.from(await response.arrayBuffer());
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

async function readJsonArtifact(projectId: string, fileName: string) {
  const artifact = await readArtifact(projectId, fileName).catch(() => null);
  if (!artifact) return null;
  try {
    return JSON.parse(artifact.content.toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

async function loadInstantPdfAssets() {
  const promise = cachedAssetPathsPromise ?? (cachedAssetPathsPromise = (async () => {
    const distRoot = path.resolve(MODULE_DIR, "..");
    const sourceRoot = path.resolve(MODULE_DIR, "..", "..");
    const candidateV1Roots = [distRoot, sourceRoot];
    const candidatePublicRoots = [
      path.resolve(distRoot, ".."),
      path.resolve(sourceRoot, "..")
    ];
    return {
      browserExecutablePath: await resolveBrowserExecutablePath(),
      geotiffScriptPath: await resolveExistingPath(
        candidateV1Roots.map((root) => path.join(root, "node_modules", "geotiff", "dist-browser", "geotiff.js")),
        "GeoTIFF browser runtime"
      ),
      threeScriptPath: await resolveExistingPath(
        candidateV1Roots.map((root) => path.join(root, "node_modules", "three", "build", "three.min.js")),
        "Three.js runtime"
      ),
      orbitControlsPath: await resolveExistingPath(
        candidateV1Roots.map((root) => path.join(root, "node_modules", "three", "examples", "js", "controls", "OrbitControls.js")),
        "Three.js OrbitControls runtime"
      ),
      defaultLogoPath: await resolveExistingPath(
        candidatePublicRoots.map((root) => path.join(root, "images", DEFAULT_LOGO_NAME)),
        "default instant PDF logo"
      ),
      fontRegularPath: await resolveExistingPath(
        candidatePublicRoots.map((root) => path.join(root, "fonts", "Montserrat-Regular.ttf")),
        "Montserrat regular font"
      ),
      fontBoldPath: await resolveExistingPath(
        candidatePublicRoots.map((root) => path.join(root, "fonts", "Montserrat-Bold.ttf")),
        "Montserrat bold font"
      )
    } satisfies InstantPdfAssetPaths;
  })());

  return promise;
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
          "/snap/bin/chromium"
        ];

  return resolveExistingPath(candidates, "browser executable");
}

async function resolveExistingPath(candidates: string[], label: string) {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try next path
    }
  }
  throw new Error(`Unable to locate ${label}. Checked: ${candidates.join(", ")}`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

declare global {
  interface Window {
    GeoTIFF?: {
      fromArrayBuffer?: (buffer: ArrayBuffer) => Promise<{
        getImage: () => Promise<{
          getWidth: () => number;
          getHeight: () => number;
          readRasters: (options?: Record<string, unknown>) => Promise<any>;
        }>;
      }>;
    };
    THREE?: any;
  }
}
