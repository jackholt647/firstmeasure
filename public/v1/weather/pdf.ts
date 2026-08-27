import path from "node:path";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

import { env } from "../src/config/env.js";
import { isFirstMeasurePostgresEnabled } from "../src/database/postgres.js";
import { readWeatherReport } from "./storage.js";
import type { GeoPoint, WeatherEventSummary, WeatherFinding, WeatherModeledHistoryEvent, WeatherRecord, WeatherReport, WeatherStormArea } from "./types.js";
import { finalizeFirstMatePdf } from "../src/pdf_metadata.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PAGE_WIDTH_PX = 1836;
const PAGE_HEIGHT_PX = 2376;
const PAGE_WIDTH_MM = 215.9;
const PX_PER_MM = PAGE_WIDTH_PX / PAGE_WIDTH_MM;
const PRIMARY_STRIP_PX = Math.round(8 * PX_PER_MM);
const SECONDARY_STRIP_PX = Math.round(2 * PX_PER_MM);
const CONTENT_LEFT_PX = Math.round(25 * PX_PER_MM);
const CONTENT_RIGHT_PX = Math.round(15 * PX_PER_MM);
const TOP_MARGIN_PX = Math.round(10 * PX_PER_MM);
const LOGO_HEIGHT_PX = Math.round(12 * PX_PER_MM);
const LOGO_LEFT_PX = Math.round(20 * PX_PER_MM);
const CARD_RADIUS_PX = Math.round(3 * PX_PER_MM);
const CARD_BORDER_PX = Math.max(1, Math.round(0.3 * PX_PER_MM));
const CARD_SHADOW_OFFSET_PX = Math.round(1.5 * PX_PER_MM);
const MAP_ASPECT_RATIO = 4 / 3;
const MODELED_HISTORY_ROWS_PER_PAGE = 20;

type WeatherPdfAssetPaths = {
  browserExecutablePath: string;
  defaultLogoPath: string;
  fontRegularPath: string;
  fontBoldPath: string;
};

let cachedAssetPathsPromise: Promise<WeatherPdfAssetPaths> | null = null;

export async function generateWeatherReportPdf(reportId: string) {
  const report = await readWeatherReport(reportId);
  const bytes = await renderWeatherPdfDocument(report);
  const dir = path.resolve(env.weatherStorageRoot, "pdfs");
  const fileName = weatherPdfFileName(report);
  const filePath = path.join(dir, fileName);
  if (!isFirstMeasurePostgresEnabled()) {
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, bytes);
  }
  return {
    report,
    fileName,
    filePath,
    bytes
  };
}

export async function renderWeatherPdfDocument(report: WeatherReport) {
  const assets = await loadWeatherPdfAssets();
  const [logo, fontRegular, fontBold] = await Promise.all([
    readFile(assets.defaultLogoPath),
    readFile(assets.fontRegularPath),
    readFile(assets.fontBoldPath)
  ]);
  const browser = await chromium.launch({
    executablePath: assets.browserExecutablePath,
    headless: true,
    args: ["--disable-gpu", "--font-render-hinting=medium", "--disable-dev-shm-usage"]
  });

  try {
    const page = await browser.newPage({
      viewport: { width: PAGE_WIDTH_PX, height: PAGE_HEIGHT_PX },
      deviceScaleFactor: 1
    });
    await page.emulateMedia({ media: "screen" });
    await page.setContent(buildWeatherPdfHtml(report, {
      logoDataUrl: `data:image/png;base64,${logo.toString("base64")}`,
      fontRegularDataUrl: `data:font/ttf;base64,${fontRegular.toString("base64")}`,
      fontBoldDataUrl: `data:font/ttf;base64,${fontBold.toString("base64")}`
    }), { waitUntil: "domcontentloaded" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => null);
    const pdf = await page.pdf({
      printBackground: true,
      width: `${PAGE_WIDTH_PX}px`,
      height: `${PAGE_HEIGHT_PX}px`,
      margin: { top: "0px", right: "0px", bottom: "0px", left: "0px" },
      preferCSSPageSize: true
    });
    return finalizeFirstMatePdf(pdf, {
      title: `${String(report.property.address ?? "Property").trim() || "Property"} - FirstMate Weather Report`,
      subject: "FirstMate property weather report",
      keywords: ["weather", "property weather", "report"]
    });
  } finally {
    await browser.close();
  }
}

export function weatherPdfFileName(report: WeatherReport) {
  const cityish = String(report.property.address ?? "weather-report")
    .split(",")[0]
    ?.replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "weather-report";
  return `${cityish}-weather-report-${report.id.slice(0, 8)}.pdf`;
}

function buildWeatherPdfHtml(report: WeatherReport, assets: {
  logoDataUrl: string;
  fontRegularDataUrl: string;
  fontBoldDataUrl: string;
}) {
  const topRecords = report.records
    .filter((record) => record.dataset === "nx3hail" && record.magnitude != null)
    .sort((a, b) => (b.magnitude ?? 0) - (a.magnitude ?? 0) || (a.distance_miles ?? 999) - (b.distance_miles ?? 999))
    .slice(0, 18);
  const nearestRecords = report.records
    .filter((record) => record.distance_miles != null)
    .sort((a, b) => (a.distance_miles ?? 999) - (b.distance_miles ?? 999))
    .slice(0, 12);
  const lsrRecords = report.records
    .filter((record) => record.dataset === "iem_lsr")
    .sort((a, b) => (a.distance_miles ?? 999) - (b.distance_miles ?? 999));
  const warningRecords = report.records
    .filter((record) => record.dataset === "iem_warning")
    .sort((a, b) => scoreWarning(b) - scoreWarning(a) || String(a.observed_at ?? "").localeCompare(String(b.observed_at ?? "")))
    .slice(0, 8);
  const stormEvents = report.storm_events ?? [];
  const pages = report.tier === "comprehensive"
    ? buildComprehensivePages(report, assets.logoDataUrl, topRecords, nearestRecords, lsrRecords, warningRecords, stormEvents)
    : [
        renderCoverPage(report, assets.logoDataUrl),
        renderFindingsPage(report, topRecords, nearestRecords, assets.logoDataUrl),
        renderStormReportsPage(report, lsrRecords, stormEvents, assets.logoDataUrl, 3),
        renderWarningsPage(report, warningRecords, assets.logoDataUrl, 4),
        renderSourcesPage(report, assets.logoDataUrl, 5)
      ].join("");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(report.property.address ?? "Weather Report")}</title>
<style>
@page{size:${PAGE_WIDTH_PX}px ${PAGE_HEIGHT_PX}px;margin:0}
@font-face{font-family:Montserrat;src:url('${assets.fontRegularDataUrl}') format('truetype');font-weight:400}
@font-face{font-family:Montserrat;src:url('${assets.fontBoldDataUrl}') format('truetype');font-weight:700}
:root{--ink:#19202a;--muted:#68707c;--primary:#c82828;--secondary:#960000;--card:#ffffff;--border:#dcdcdc;--shadow:#ececec;--soft:#f6f7f9}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#fff;font-family:Montserrat,Arial,sans-serif;color:var(--ink)}
.page{width:${PAGE_WIDTH_PX}px;height:${PAGE_HEIGHT_PX}px;position:relative;overflow:hidden;background:#fff;break-after:page;page-break-after:always}
.page:last-child{break-after:auto;page-break-after:auto}
.linePrimary{position:absolute;left:0;top:0;bottom:0;width:${PRIMARY_STRIP_PX}px;background:var(--primary)}
.lineSecondary{position:absolute;left:${PRIMARY_STRIP_PX}px;top:0;bottom:0;width:${SECONDARY_STRIP_PX}px;background:var(--secondary)}
.brand{position:absolute;left:${LOGO_LEFT_PX}px;top:${TOP_MARGIN_PX}px;height:${LOGO_HEIGHT_PX}px}
.brand img{height:${LOGO_HEIGHT_PX}px;width:auto;object-fit:contain}
.header{position:absolute;top:${Math.round(15 * PX_PER_MM)}px;right:${Math.round(20 * PX_PER_MM)}px;text-align:right;color:#646464;font-size:${Math.round(3.2 * PX_PER_MM)}px;line-height:1.55}
.content{position:absolute;left:${CONTENT_LEFT_PX}px;right:${CONTENT_RIGHT_PX}px;top:${Math.round(38 * PX_PER_MM)}px;bottom:${Math.round(16 * PX_PER_MM)}px}
.kicker{font-size:24px;font-weight:700;color:var(--primary);letter-spacing:.08em;text-transform:uppercase;margin:0 0 14px}
h1{font-size:64px;line-height:1.06;margin:0 0 16px;font-weight:700;letter-spacing:0}
h2{font-size:44px;line-height:1.15;margin:0 0 22px;font-weight:700;letter-spacing:0}
h3{font-size:25px;margin:0 0 13px;font-weight:700}
p{font-size:23px;line-height:1.5;margin:0 0 16px;color:#28313d}
.muted{color:var(--muted)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:36px}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}
.card{background:var(--card);border:${CARD_BORDER_PX}px solid var(--border);border-radius:${CARD_RADIUS_PX}px;box-shadow:${CARD_SHADOW_OFFSET_PX}px ${CARD_SHADOW_OFFSET_PX}px 0 var(--shadow);padding:30px}
.card.tight{padding:24px}
.stat .label{font-size:18px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:700;margin-bottom:10px}
.stat .value{font-size:39px;font-weight:700;color:var(--ink);line-height:1.1}
.stat .sub{font-size:20px;color:var(--muted);line-height:1.35;margin-top:10px}
.hero{display:grid;grid-template-columns:1.1fr .9fr;gap:38px;align-items:stretch;margin-top:34px}
.coverIntro{max-width:1320px;margin-bottom:28px}
.coverAddress{font-size:27px;line-height:1.35;color:#384150;margin-bottom:10px}
.summary{font-size:26px;line-height:1.44}
.note{font-size:18px;line-height:1.4;color:#69717d;margin-top:14px}
.evidenceGrid{display:grid;grid-template-columns:1.2fr .8fr;gap:30px;margin-top:28px}
.coverMetricGrid{display:grid;grid-template-columns:1fr 1fr;column-gap:24px;row-gap:2px;margin-top:20px}
.coverMetricGrid p{font-size:18px;line-height:1.28;margin:0 0 10px}
.solarImageBox{position:relative;width:100%;aspect-ratio:1 / 1;background:#eef2f5;border:${CARD_BORDER_PX}px solid var(--border);border-radius:${CARD_RADIUS_PX}px;overflow:hidden}
.solarImageBox.coverWide{aspect-ratio:auto;height:1320px}
.solarImageBox img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.solarMeta{font-size:16px;line-height:1.35;color:#69717d;margin-top:12px}
.findingsLayout{display:grid;grid-template-columns:.82fr 1.18fr;gap:30px;align-items:start}
.mapPanel{padding:24px}
.table{width:100%;border-collapse:collapse;font-size:18px;table-layout:fixed}
.table th{font-size:14px;text-align:left;color:#68707c;text-transform:uppercase;letter-spacing:.05em;border-bottom:2px solid #d7dbe0;padding:0 7px 12px}
.table td{border-bottom:1px solid #e5e7eb;padding:12px 7px;vertical-align:top;line-height:1.35}
.table .num{text-align:right}
.table th:first-child,.table td:first-child{white-space:nowrap}
.table.compact{font-size:16px}
.table.compact th{font-size:12px;padding-bottom:9px}
.table.compact td{padding:9px 6px}
.table.modeledTable{font-size:25px}
.table.modeledTable th{font-size:16px;padding:0 10px 14px}
.table.modeledTable td{padding:16px 10px;line-height:1.28}
.table.modeledTable th:nth-child(1),.table.modeledTable td:nth-child(1){width:30%}
.table.modeledTable th:nth-child(2),.table.modeledTable td:nth-child(2){width:28%}
.table.modeledTable .num{font-weight:700}
.eventTypeMark{display:inline-flex;align-items:center;gap:10px;font-weight:700}
.eventTypeMark::before{content:"";display:inline-block;width:14px;height:14px;border-radius:50%;flex:0 0 14px}
.eventTypeMark.hail{color:#9b1111}
.eventTypeMark.hail::before{background:#c82828}
.eventTypeMark.wind{color:#12665c}
.eventTypeMark.wind::before{background:#1c9a89}
.eventTypeMark.tornado{color:#7046a5}
.eventTypeMark.tornado::before{background:#7046a5}
.eventTypeMark.weather{color:#445160}
.eventTypeMark.weather::before{background:#68707c}
.pill{display:inline-block;background:#f7e8e8;color:#9b1111;font-weight:700;border-radius:999px;padding:7px 13px;font-size:18px}
.source{font-size:20px;line-height:1.38}
.warningText{white-space:pre-wrap;font-family:Montserrat,Arial,sans-serif;font-size:18px;line-height:1.28;color:#2f3742;max-height:720px;overflow:hidden}
.mapBox{position:relative;width:100%;aspect-ratio:${MAP_ASPECT_RATIO};background:#eef2f5;border:${CARD_BORDER_PX}px solid var(--border);border-radius:${CARD_RADIUS_PX}px;overflow:hidden}
.mapTile{position:absolute;display:block}
.dot{position:absolute;width:18px;height:18px;border-radius:50%;transform:translate(-50%,-50%);background:#c82828;border:3px solid #fff;box-shadow:0 4px 12px rgba(0,0,0,.25)}
.dot.property{width:26px;height:26px;background:#19202a}
.dot.lsr{background:#e67e22}
.dot.radar{background:#c82828}
.mapAttribution{position:absolute;right:8px;bottom:6px;background:rgba(255,255,255,.86);padding:3px 6px;border-radius:3px;font-size:12px;color:#53606e}
.mapOverlay{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.stormArea{fill:rgba(35,111,214,.18);stroke:#236fd6;stroke-width:.55;stroke-linejoin:round}
.stormArea.warning{fill:rgba(225,83,44,.16);stroke:#e1532c}
.stormArea.mrms{fill:rgba(24,143,92,.18);stroke:#188f5c;stroke-width:.8}
.stormArea.impact{fill:rgba(39,163,82,.18);stroke:#27a352;stroke-width:.75}
.legend{display:flex;gap:18px;align-items:center;font-size:17px;color:#4a5360;margin-top:14px;flex-wrap:wrap}
.legend span::before{content:"";display:inline-block;width:14px;height:14px;border-radius:50%;margin-right:8px;vertical-align:-1px;background:#c82828}
.legend .prop::before{background:#19202a}.legend .lsr::before{background:#e67e22}.legend .area::before{border-radius:2px;background:#236fd6}.legend .impact::before{border-radius:2px;background:#27a352}
.footer{position:absolute;left:${CONTENT_LEFT_PX}px;right:${CONTENT_RIGHT_PX}px;bottom:${Math.round(8 * PX_PER_MM)}px;display:flex;justify-content:space-between;color:#8a9099;font-size:16px}
.limitations li{font-size:22px;line-height:1.45;margin:0 0 12px;color:#3a4350}
.sectionGap{margin-top:28px}
.smallCaps{font-size:17px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:700;margin-bottom:8px}
.callout{border-left:7px solid var(--primary);padding:6px 0 6px 18px}
</style>
</head>
<body>${pages}</body>
</html>`;
}

function buildComprehensivePages(
  report: WeatherReport,
  logoDataUrl: string,
  topRecords: WeatherRecord[],
  nearestRecords: WeatherRecord[],
  lsrRecords: WeatherRecord[],
  warningRecords: WeatherRecord[],
  stormEvents: WeatherEventSummary[]
) {
  const pages: string[] = [];
  const nextPageNumber = () => pages.length + 1;
  pages.push(renderCoverPage(report, logoDataUrl));
  pages.push(renderFindingsPage(report, topRecords, nearestRecords, logoDataUrl));
  if (report.modeled_history_events?.length) {
    pages.push(...renderModeledHistoryPages(report, logoDataUrl, nextPageNumber()));
  }
  pages.push(...renderComprehensiveEventHistoryPages(report, logoDataUrl, nextPageNumber()));
  pages.push(renderStormAreasPage(report, logoDataUrl, nextPageNumber()));
  pages.push(...renderStormReportsPages(report, lsrRecords, stormEvents, logoDataUrl, nextPageNumber()));
  pages.push(renderWarningsPage(report, warningRecords, logoDataUrl, nextPageNumber()));
  pages.push(renderArtifactsPage(report, logoDataUrl, nextPageNumber()));
  pages.push(renderSourcesPage(report, logoDataUrl, nextPageNumber()));
  return pages.join("");
}

function renderPageShell(report: WeatherReport, logoDataUrl: string, title: string, body: string, pageNumber: number) {
  return `<section class="page">
    <div class="linePrimary"></div><div class="lineSecondary"></div>
    <div class="brand"><img src="${logoDataUrl}" alt="FirstMeasure"></div>
    <div class="header">Weather Report<br>${escapeHtml(report.tier.toUpperCase())}<br>${escapeHtml(formatDate(report.generated_at))}</div>
    <main class="content">${body}</main>
    <div class="footer"><span>${escapeHtml(title)}</span><span>${pageNumber}</span></div>
  </section>`;
}

function renderCoverPage(report: WeatherReport, logoDataUrl: string) {
  const finding = report.findings[0] ?? null;
  const body = `
    <div class="coverIntro">
      <p class="kicker">Automated Weather Report</p>
      <h1>Property Weather Summary</h1>
      <p class="coverAddress">${escapeHtml(report.property.address ?? "Property address unavailable")}</p>
      <p class="muted">Prepared ${escapeHtml(formatDate(report.generated_at))} from public radar, storm report, and National Weather Service warning datasets.</p>
    </div>
    <div class="grid3">
      ${statCard("Max Nearby Hail", finding?.max_magnitude != null ? `${finding.max_magnitude}"` : "None", finding?.date ?? "No hail finding")}
      ${statCard("Closest Evidence", finding?.nearest_distance_miles != null ? `${finding.nearest_distance_miles} mi` : "None", "Nearest supporting record")}
      ${statCard("Confidence", titleCase(finding?.confidence ?? "low"), "Automated source confidence")}
    </div>
    ${renderSolarPreviewCard(report, true)}`;
  return renderPageShell(report, logoDataUrl, "Weather Report Overview", body, 1);
}

function renderFindingsPage(report: WeatherReport, topRecords: WeatherRecord[], nearestRecords: WeatherRecord[], logoDataUrl: string) {
  const body = `
    <p class="kicker">Findings</p>
    <h2>Event Evidence Near the Property</h2>
    <div class="findingsLayout">
      <div class="card tight">
        <h3>Event Finding</h3>
        ${renderFindingsTable(report.findings)}
        <p class="note">Distances are measured from the resolved property coordinates to the nearest public weather record in the report window.</p>
      </div>
      <div class="card mapPanel">
        <h3>Location Exhibit</h3>
        ${renderMapExhibit(report, [...nearestRecords.slice(0, 10), ...topRecords.slice(0, 8)])}
      </div>
    </div>
    <div class="card sectionGap">
      <h3>Strongest Hail Signatures</h3>
      ${renderRecordsTable(topRecords.slice(0, 6), true)}
    </div>`;
  return renderPageShell(report, logoDataUrl, "Weather Report Findings", body, 2);
}

function renderModeledHistoryPages(report: WeatherReport, logoDataUrl: string, firstPageNumber: number) {
  const modeled = [...(report.modeled_history_events ?? [])].sort((a, b) => b.date.localeCompare(a.date));
  const chunks = chunk(modeled, MODELED_HISTORY_ROWS_PER_PAGE);
  return chunks.map((events, index) => {
    const start = index * MODELED_HISTORY_ROWS_PER_PAGE + 1;
    const end = Math.min(modeled.length, start + events.length - 1);
    const body = `
      <p class="kicker">Test Model</p>
      <h2>HailTrace-Style Weather History${index ? " Continued" : ""}</h2>
      <div class="card">
        ${index === 0 ? `<p class="muted">This testing page applies a reverse-engineered, public-source event model: records are grouped by convective storm day, filtered by source, distance, and severity, then reduced to one property-level row per meaningful event.</p>` : ""}
        <p class="note">Showing modeled events ${start}-${end} of ${modeled.length}${end < modeled.length ? "; continued on the next page" : ""}. The full raw/de-duped evidence history follows on later pages.</p>
        ${renderModeledHistoryTable(events)}
      </div>`;
    return renderPageShell(report, logoDataUrl, "Weather Modeled History", body, firstPageNumber + index);
  });
}

function renderComprehensiveEventHistoryPages(report: WeatherReport, logoDataUrl: string, firstPageNumber: number) {
  const byRecent = [...(report.storm_events ?? [])].sort((a, b) => b.date.localeCompare(a.date));
  const chunks = chunk(byRecent, 16);
  if (!chunks.length) {
    const body = `
      <p class="kicker">Full Pull</p>
      <h2>Deduped Severe Weather History</h2>
      <div class="card">
        <p class="muted">No de-duped storm events were produced.</p>
      </div>`;
    return [renderPageShell(report, logoDataUrl, "Weather Comprehensive Event History", body, firstPageNumber)];
  }
  return chunks.map((events, index) => {
    const start = index * 16 + 1;
    const end = Math.min(byRecent.length, start + events.length - 1);
    const body = `
      <p class="kicker">Full Pull</p>
      <h2>Deduped Severe Weather History${index ? " Continued" : ""}</h2>
      <div class="card">
        ${index === 0 ? `<p class="muted">Raw radar, warning, and local storm report rows are grouped into storm-level events by local date, peril, and time cluster so repeat reports from the same storm do not dominate the report.</p>` : ""}
        <p class="note">Showing storm events ${start}-${end} of ${byRecent.length}. Full raw evidence remains in the API JSON.</p>
        ${renderStormEventSummaryTable(events)}
      </div>`;
    return renderPageShell(report, logoDataUrl, "Weather Comprehensive Event History", body, firstPageNumber + index);
  });
}

function renderStormAreasPage(report: WeatherReport, logoDataUrl: string, pageNumber = 4) {
  const areas = (report.storm_areas ?? []).slice(0, 18);
  const areaRecords = report.records
    .filter((record) => record.lat != null && record.lon != null)
    .sort((a, b) => (a.distance_miles ?? 999) - (b.distance_miles ?? 999))
    .slice(0, 18);
  const body = `
    <p class="kicker">Storm Footprints</p>
    <h2>Storm Area Exhibits</h2>
    <div class="grid2">
      <div class="card mapPanel">
        <h3>Areas and Evidence</h3>
        ${renderMapExhibit(report, areaRecords, areas)}
      </div>
      <div class="card">
        <h3>Storm Area Index</h3>
        ${renderStormAreasTable(areas)}
        <p class="note">MRMS/MESH contours are derived directly from decoded NOAA raster cells inside the report radius. Estimated swaths are still shown when only point evidence is available. Warning polygons are retained when warning text provides LAT/LON polygon vertices.</p>
      </div>
    </div>`;
  return renderPageShell(report, logoDataUrl, "Weather Storm Areas", body, pageNumber);
}

function renderStormReportsPage(report: WeatherReport, lsrRecords: WeatherRecord[], stormEvents: WeatherEventSummary[], logoDataUrl: string, pageNumber: number) {
  return renderStormReportsPages(report, lsrRecords, stormEvents, logoDataUrl, pageNumber)[0] ?? "";
}

function renderStormReportsPages(report: WeatherReport, lsrRecords: WeatherRecord[], stormEvents: WeatherEventSummary[], logoDataUrl: string, firstPageNumber: number) {
  const lsrEvents = stormEvents
    .filter((event) => event.sources.some((source) => source.includes("iem_lsr")) || event.event_type === "wind");
  const events = lsrEvents.length ? lsrEvents : (report.storm_events ?? []);
  const chunks = chunk(events, 16);
  if (!chunks.length) {
    const body = `
      <p class="kicker">Ground Reports</p>
      <h2>Nearby Storm Events</h2>
      <div class="card">
        <p class="muted">No nearby storm events were available for this report.</p>
      </div>`;
    return [renderPageShell(report, logoDataUrl, "Weather Local Storm Reports", body, firstPageNumber)];
  }
  return chunks.map((pageEvents, index) => {
    const start = index * 16 + 1;
    const end = Math.min(events.length, start + pageEvents.length - 1);
    const body = `
      <p class="kicker">Ground Reports</p>
      <h2>Nearby Storm Events${index ? " Continued" : ""}</h2>
      <div class="card">
        ${index === 0 ? `<p class="muted">This section groups repeat Local Storm Reports and warning wind tags into storm-level rows. Raw LSR rows are retained in the JSON for audit and review.</p>` : ""}
        <p class="note">Showing nearby storm events ${start}-${end} of ${events.length}.${lsrRecords.length && index === 0 ? ` ${lsrRecords.length} raw Local Storm Report row(s) were normalized before de-duplication.` : ""}</p>
        ${renderStormEventSummaryTable(pageEvents)}
      </div>`;
    return renderPageShell(report, logoDataUrl, "Weather Local Storm Reports", body, firstPageNumber + index);
  });
}

function renderWarningsPage(report: WeatherReport, warningRecords: WeatherRecord[], logoDataUrl: string, pageNumber: number) {
  const primary = warningRecords.find((record) => record.raw.property_in_polygon === "true" || record.raw.mentions_address_city === "true") ?? warningRecords[0];
  const body = `
    <p class="kicker">Warnings</p>
    <h2>NWS Warning Text</h2>
    <div class="grid2">
      <div class="card">
        <h3>Warning Summary</h3>
        ${renderWarningsTable(warningRecords)}
      </div>
      <div class="card">
        <h3>Primary Warning Text</h3>
        ${primary ? `<div class="warningText">${escapeHtml(String(primary.raw.text ?? "Warning text unavailable."))}</div>` : `<p class="muted">No warning text was available for this event window.</p>`}
      </div>
    </div>`;
  return renderPageShell(report, logoDataUrl, "Weather NWS Warnings", body, pageNumber);
}

function renderArtifactsPage(report: WeatherReport, logoDataUrl: string, pageNumber: number) {
  const groups = [
    { title: "NEXRAD Level-II", links: report.artifacts.nexrad_level2 ?? [] },
    { title: "MRMS/MESH", links: report.artifacts.mrms ?? [] },
    { title: "IEM Archives", links: report.artifacts.iem ?? [] }
  ];
  const body = `
    <p class="kicker">Artifacts</p>
    <h2>External Radar and Archive Links</h2>
    <div class="card">
      ${groups.map((group) => `<h3>${escapeHtml(group.title)}</h3>${group.links.length
        ? group.links.map((link) => `<p class="source"><strong>${escapeHtml(link.label)}</strong><br>${escapeHtml(link.url)}</p>`).join("")
        : `<p class="muted">No artifact links were generated for this group.</p>`}`).join("")}
    </div>`;
  return renderPageShell(report, logoDataUrl, "Weather External Artifacts", body, pageNumber);
}

function renderSourcesPage(report: WeatherReport, logoDataUrl: string, pageNumber: number) {
  const body = `
    <p class="kicker">Sources</p>
    <h2>Data Sources and Limitations</h2>
    <div class="card">
      ${report.sources.map((source) => `<p class="source"><strong>${escapeHtml(source.name)}</strong> <span class="pill">${escapeHtml(source.status)}</span><br>
        Records included in this report: ${escapeHtml(String(source.record_count ?? 0))}</p>`).join("")}
    </div>
    <div class="card" style="margin-top:34px">
      <h3>Limitations</h3>
      <ul class="limitations">${report.summary.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    </div>`;
  return renderPageShell(report, logoDataUrl, "Weather Report Sources", body, pageNumber);
}

function statCard(label: string, value: string, sub: string) {
  return `<div class="card stat"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div><div class="sub">${escapeHtml(sub)}</div></div>`;
}

function miniMetric(label: string, value: number) {
  return `<p><span class="smallCaps">${escapeHtml(label)}</span><br><strong>${escapeHtml(String(value))}</strong></p>`;
}

function renderSolarPreviewCard(report: WeatherReport, wide = false) {
  const preview = report.solar_preview;
  if (!preview?.image) {
    return `<div class="card${wide ? " sectionGap" : ""}">
      <h3>Property Image</h3>
      <p class="muted">Solar top-down imagery was not available for this report.</p>
      ${preview?.error ? `<p class="note">${escapeHtml(preview.error)}</p>` : ""}
    </div>`;
  }
  const imageryDate = formatSolarImageryDate(preview.imagery_date);
  const meta = [
    preview.imagery_quality ? `Imagery quality: ${preview.imagery_quality}` : "",
    imageryDate ? `Imagery date: ${imageryDate}` : "",
    preview.source ? `Source: ${preview.source}` : "Source: Google Solar"
  ].filter(Boolean).join(" | ");
  return `<div class="card${wide ? " sectionGap" : ""}">
    <h3>Property Image</h3>
    <div class="solarImageBox${wide ? " coverWide" : ""}">
      <img src="${escapeHtml(preview.image)}" alt="Solar top-down property image">
    </div>
    <p class="solarMeta">${escapeHtml(meta || "Google Solar top-down property imagery.")}</p>
  </div>`;
}

function renderFindingsTable(findings: WeatherFinding[]) {
  if (!findings.length) return `<p class="muted">No grouped findings were produced.</p>`;
  const visible = findings.slice(0, 14);
  return `<table class="table"><thead><tr><th>Date</th><th>Event</th><th class="num">Max</th><th class="num">Near</th><th>Conf.</th></tr></thead><tbody>
    ${visible.map((finding) => `<tr><td>${escapeHtml(finding.date)}</td><td>${escapeHtml(formatEventType(finding.event_type))}</td><td class="num">${escapeHtml(formatMagnitude(finding.max_magnitude, finding.magnitude_unit))}</td><td class="num">${escapeHtml(formatDistance(finding.nearest_distance_miles))}</td><td>${escapeHtml(titleCase(finding.confidence))}</td></tr>`).join("")}
  </tbody></table>${findings.length > visible.length ? `<p class="note">Showing top ${visible.length} of ${findings.length} event days. Full event history is retained in the API response.</p>` : ""}`;
}

function renderRecordsTable(records: WeatherRecord[], compact = false) {
  if (!records.length) return `<p class="muted">No records available for this table.</p>`;
  return `<table class="table${compact ? " compact" : ""}"><thead><tr><th>Time UTC</th><th>Radar</th><th>Cell</th><th class="num">Hail</th><th class="num">Prob.</th><th class="num">Dist.</th></tr></thead><tbody>
    ${records.map((record) => `<tr><td>${escapeHtml(formatDateTime(record.observed_at))}</td><td>${escapeHtml(record.raw.WSR_ID ?? "")}</td><td>${escapeHtml(record.raw.CELL_ID ?? "")}</td><td class="num">${escapeHtml(formatMagnitude(record.magnitude, record.magnitude_unit))}</td><td class="num">${escapeHtml(formatProbability(record.raw.PROB))}</td><td class="num">${escapeHtml(formatDistance(record.distance_miles))}</td></tr>`).join("")}
  </tbody></table>`;
}

function renderLsrTable(records: WeatherRecord[]) {
  if (!records.length) return `<p class="muted">No nearby Local Storm Reports were returned for this event window.</p>`;
  return `<table class="table"><thead><tr><th>Time UTC</th><th>Type</th><th>City</th><th class="num">Mag.</th><th>Source</th><th class="num">Dist.</th><th>Remark</th></tr></thead><tbody>
    ${records.map((record) => `<tr><td>${escapeHtml(formatDateTime(record.observed_at))}</td><td>${escapeHtml(formatEventType(record.event_type ?? ""))}</td><td>${escapeHtml(record.raw.CITY ?? "")}</td><td class="num">${escapeHtml(formatMagnitude(record.magnitude, record.magnitude_unit))}</td><td>${escapeHtml(record.raw.SOURCE ?? "")}</td><td class="num">${escapeHtml(formatDistance(record.distance_miles))}</td><td>${escapeHtml(truncate(record.raw.REMARK, 125))}</td></tr>`).join("")}
  </tbody></table>`;
}

function renderWarningsTable(records: WeatherRecord[]) {
  if (!records.length) return `<p class="muted">No NWS warning metadata was returned for this event window.</p>`;
  return `<table class="table compact"><thead><tr><th>Issue UTC</th><th>Type</th><th class="num">Hail</th><th class="num">Wind</th><th>Property</th></tr></thead><tbody>
    ${records.map((record) => `<tr><td>${escapeHtml(formatDateTime(record.observed_at))}</td><td>${escapeHtml(formatEventType(record.event_type ?? ""))}</td><td class="num">${escapeHtml(formatMagnitude(record.magnitude, record.magnitude_unit))}</td><td class="num">${escapeHtml(record.raw.windtag ? `${record.raw.windtag} mph` : "--")}</td><td>${escapeHtml(propertyWarningLabel(record))}</td></tr>`).join("")}
  </tbody></table>`;
}

function renderEventHistoryTable(findings: WeatherFinding[]) {
  if (!findings.length) return `<p class="muted">No grouped event history was produced.</p>`;
  return `<table class="table compact"><thead><tr><th>Date</th><th>Event</th><th class="num">Max</th><th class="num">Near</th><th class="num">Records</th><th>Basis</th></tr></thead><tbody>
    ${findings.map((finding) => `<tr><td>${escapeHtml(finding.date)}</td><td>${escapeHtml(formatEventType(finding.event_type))}</td><td class="num">${escapeHtml(formatMagnitude(finding.max_magnitude, finding.magnitude_unit))}</td><td class="num">${escapeHtml(formatDistance(finding.nearest_distance_miles))}</td><td class="num">${escapeHtml(String(finding.record_count))}</td><td>${escapeHtml(truncate(finding.basis.join(", "), 70))}</td></tr>`).join("")}
  </tbody></table>`;
}

function renderStormEventSummaryTable(events: WeatherEventSummary[]) {
  if (!events.length) return `<p class="muted">No deduped storm events were produced.</p>`;
  return `<table class="table compact"><thead><tr><th>Date</th><th>Event</th><th class="num">Duration</th><th class="num">Max</th><th class="num">Near</th><th class="num">Records</th><th>Basis</th></tr></thead><tbody>
    ${events.map((event) => `<tr><td>${escapeHtml(event.date)}</td><td>${escapeHtml(formatEventType(event.event_type))}</td><td class="num">${escapeHtml(formatDuration(event.duration_minutes))}</td><td class="num">${escapeHtml(formatMagnitude(event.max_magnitude, event.magnitude_unit))}</td><td class="num">${escapeHtml(formatDistance(event.nearest_distance_miles))}</td><td class="num">${escapeHtml(String(event.record_count))}</td><td>${escapeHtml(truncate(event.basis.join("; "), 88))}</td></tr>`).join("")}
  </tbody></table>`;
}

function renderModeledHistoryTable(events: WeatherModeledHistoryEvent[]) {
  if (!events.length) return `<p class="muted">No modeled history events were produced.</p>`;
  return `<table class="table modeledTable"><thead><tr><th>Date</th><th>Event Type</th><th class="num">Duration</th><th class="num">Magnitude</th></tr></thead><tbody>
    ${events.map((event) => `<tr><td>${escapeHtml(formatModeledDate(event.date))}</td><td>${renderModeledEventType(event.event_type)}</td><td class="num">${escapeHtml(formatDuration(event.duration_minutes))}</td><td class="num">${escapeHtml(formatMagnitude(event.magnitude, event.magnitude_unit))}</td></tr>`).join("")}
  </tbody></table>`;
}

function renderModeledEventType(value: WeatherModeledHistoryEvent["event_type"]) {
  const cls = value.toLowerCase();
  return `<span class="eventTypeMark ${escapeHtml(cls)}">${escapeHtml(value)}</span>`;
}

function renderStormAreasTable(areas: WeatherStormArea[]) {
  if (!areas.length) return `<p class="muted">No warning polygons or derived storm areas were produced for this report.</p>`;
  return `<table class="table compact"><thead><tr><th>Date</th><th>Area</th><th>Event</th><th class="num">Max</th><th>Impact</th></tr></thead><tbody>
    ${areas.map((area) => `<tr><td>${escapeHtml(area.date)}</td><td>${escapeHtml(formatAreaType(area.area_type))}</td><td>${escapeHtml(formatEventType(area.event_type))}</td><td class="num">${escapeHtml(formatMagnitude(area.magnitude, area.magnitude_unit))}</td><td>${escapeHtml(area.contains_property ? "Over address" : area.nearest_distance_miles != null ? `${area.nearest_distance_miles} mi` : "Regional")}</td></tr>`).join("")}
  </tbody></table>`;
}

function renderMapExhibit(report: WeatherReport, records: WeatherRecord[], stormAreas: WeatherStormArea[] = (report.storm_areas ?? []).slice(0, 16)) {
  const plotted = records.filter((record) => record.lat != null && record.lon != null).slice(0, 28);
  const map = buildTileMap(report, plotted, stormAreas);
  const dot = (lat: number, lon: number, cls: string, title: string) => {
    const pixel = lonLatToWorldPixel(lat, lon, map.zoom);
    const x = ((pixel.x - map.minPixelX) / map.pixelWidth) * 100;
    const y = ((pixel.y - map.minPixelY) / map.pixelHeight) * 100;
    return `<div class="dot ${cls}" style="left:${x}%;top:${y}%" title="${escapeHtml(title)}"></div>`;
  };
  const polygon = (area: WeatherStormArea) => {
    const points = area.coordinates.map((point) => {
      const pixel = lonLatToWorldPixel(point.lat, point.lon, map.zoom);
      const x = ((pixel.x - map.minPixelX) / map.pixelWidth) * 100;
      const y = ((pixel.y - map.minPixelY) / map.pixelHeight) * 100;
      return `${round(x) ?? 0},${round(y) ?? 0}`;
    }).join(" ");
    const cls = `stormArea ${area.area_type === "warning_polygon" ? "warning" : ""} ${area.area_type === "mrms_mesh_contour" ? "mrms" : ""} ${area.contains_property ? "impact" : ""}`;
    return `<polygon class="${cls}" points="${points}"><title>${escapeHtml(`${formatAreaType(area.area_type)} ${area.date} ${formatEventType(area.event_type)}`)}</title></polygon>`;
  };
  return `<div class="mapBox">
    ${map.tiles.map((tile) => `<img class="mapTile" src="${tile.url}" style="left:${tile.left}%;top:${tile.top}%;width:${tile.width}%;height:${tile.height}%">`).join("")}
    <svg class="mapOverlay" viewBox="0 0 100 100" preserveAspectRatio="none">${stormAreas.map(polygon).join("")}</svg>
    ${dot(report.property.lat, report.property.lon, "property", "Property")}
    ${plotted.map((record) => dot(record.lat as number, record.lon as number, record.dataset === "iem_lsr" ? "lsr" : "radar", `${record.dataset} ${formatMagnitude(record.magnitude, record.magnitude_unit)} ${formatDistance(record.distance_miles)}`)).join("")}
    <div class="mapAttribution">© OpenStreetMap contributors</div>
  </div>
  <div class="legend"><span class="prop">Property</span><span class="radar">Radar/weather point</span><span class="lsr">Local Storm Report</span><span class="area">Storm area</span><span class="impact">Over address</span></div>`;
}

function buildTileMap(report: WeatherReport, records: WeatherRecord[], stormAreas: WeatherStormArea[] = []) {
  const points = [
    { lat: report.property.lat, lon: report.property.lon },
    ...records.map((record) => ({ lat: record.lat as number, lon: record.lon as number })),
    ...stormAreas.flatMap((area) => area.coordinates)
  ];
  const lats = points.map((point) => point.lat);
  const lons = points.map((point) => point.lon);
  const latSpan = Math.max(0.03, Math.max(...lats) - Math.min(...lats));
  const lonSpan = Math.max(0.03, Math.max(...lons) - Math.min(...lons));
  const centerLat = (Math.max(...lats) + Math.min(...lats)) / 2;
  const zoom = chooseMapZoom(latSpan, lonSpan, centerLat);
  const pixels = points.map((point) => lonLatToWorldPixel(point.lat, point.lon, zoom));
  const minX = Math.min(...pixels.map((pixel) => pixel.x));
  const maxX = Math.max(...pixels.map((pixel) => pixel.x));
  const minY = Math.min(...pixels.map((pixel) => pixel.y));
  const maxY = Math.max(...pixels.map((pixel) => pixel.y));
  const padX = Math.max(180, (maxX - minX) * 0.22);
  const padY = Math.max(140, (maxY - minY) * 0.22);
  const bounds = expandPixelBoundsToAspect(minX - padX, maxX + padX, minY - padY, maxY + padY, MAP_ASPECT_RATIO);
  const minPixelX = Math.max(0, bounds.minPixelX);
  const maxPixelX = bounds.maxPixelX;
  const minPixelY = Math.max(0, bounds.minPixelY);
  const maxPixelY = bounds.maxPixelY;
  const tileMinX = Math.floor(minPixelX / 256);
  const tileMaxX = Math.floor(maxPixelX / 256);
  const tileMinY = Math.floor(minPixelY / 256);
  const tileMaxY = Math.floor(maxPixelY / 256);
  const pixelWidth = maxPixelX - minPixelX || 1;
  const pixelHeight = maxPixelY - minPixelY || 1;
  const tiles: Array<{ url: string; left: number; top: number; width: number; height: number }> = [];
  const maxTile = 2 ** zoom;
  for (let x = tileMinX; x <= tileMaxX; x += 1) {
    for (let y = tileMinY; y <= tileMaxY; y += 1) {
      if (y < 0 || y >= maxTile) continue;
      const wrappedX = ((x % maxTile) + maxTile) % maxTile;
      tiles.push({
        url: `https://tile.openstreetmap.org/${zoom}/${wrappedX}/${y}.png`,
        left: ((x * 256 - minPixelX) / pixelWidth) * 100 - 0.06,
        top: ((y * 256 - minPixelY) / pixelHeight) * 100 - 0.06,
        width: (257 / pixelWidth) * 100,
        height: (257 / pixelHeight) * 100
      });
    }
  }
  return { zoom, minPixelX, minPixelY, pixelWidth, pixelHeight, tiles };
}

function expandPixelBoundsToAspect(minPixelX: number, maxPixelX: number, minPixelY: number, maxPixelY: number, aspectRatio: number) {
  let width = maxPixelX - minPixelX || 1;
  let height = maxPixelY - minPixelY || 1;
  const currentAspect = width / height;
  if (currentAspect > aspectRatio) {
    const neededHeight = width / aspectRatio;
    const extra = (neededHeight - height) / 2;
    minPixelY -= extra;
    maxPixelY += extra;
  } else {
    const neededWidth = height * aspectRatio;
    const extra = (neededWidth - width) / 2;
    minPixelX -= extra;
    maxPixelX += extra;
  }
  return { minPixelX, maxPixelX, minPixelY, maxPixelY };
}

function chooseMapZoom(latSpan: number, lonSpan: number, centerLat: number) {
  const targetWidthPx = 620;
  const targetHeightPx = 420;
  for (let zoom = 14; zoom >= 7; zoom -= 1) {
    const west = lonLatToWorldPixel(centerLat, -lonSpan / 2, zoom);
    const east = lonLatToWorldPixel(centerLat, lonSpan / 2, zoom);
    const north = lonLatToWorldPixel(centerLat + latSpan / 2, 0, zoom);
    const south = lonLatToWorldPixel(centerLat - latSpan / 2, 0, zoom);
    if (Math.abs(east.x - west.x) <= targetWidthPx && Math.abs(south.y - north.y) <= targetHeightPx) return zoom;
  }
  return 7;
}

function lonLatToWorldPixel(lat: number, lon: number, zoom: number) {
  const sinLat = Math.sin((Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180);
  const scale = 256 * 2 ** zoom;
  return {
    x: ((lon + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale
  };
}

function propertyWarningLabel(record: WeatherRecord) {
  if (record.raw.property_in_polygon === "true") return "Inside polygon";
  if (record.raw.mentions_address_city === "true") return "City mentioned";
  return "Regional";
}

function scoreWarning(record: WeatherRecord) {
  let score = 0;
  if (record.raw.property_in_polygon === "true") score += 100;
  if (record.raw.mentions_address_city === "true") score += 50;
  if (record.magnitude != null) score += record.magnitude;
  return score;
}

async function loadWeatherPdfAssets() {
  const promise = cachedAssetPathsPromise ?? (cachedAssetPathsPromise = (async () => {
    const distRoot = path.resolve(MODULE_DIR, "..");
    const sourceRoot = path.resolve(MODULE_DIR, "..", "..");
    const candidatePublicRoots = [
      path.resolve(distRoot, ".."),
      path.resolve(sourceRoot, "..")
    ];
    return {
      browserExecutablePath: await resolveBrowserExecutablePath(),
      defaultLogoPath: await resolveExistingPath(
        candidatePublicRoots.map((root) => path.join(root, "images", "logo_red.png")),
        "default FirstMeasure logo"
      ),
      fontRegularPath: await resolveExistingPath(
        candidatePublicRoots.map((root) => path.join(root, "fonts", "Montserrat-Regular.ttf")),
        "Montserrat regular font"
      ),
      fontBoldPath: await resolveExistingPath(
        candidatePublicRoots.map((root) => path.join(root, "fonts", "Montserrat-Bold.ttf")),
        "Montserrat bold font"
      )
    } satisfies WeatherPdfAssetPaths;
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
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
      : ["/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"];
  return resolveExistingPath(candidates, "Chrome or Edge executable");
}

async function resolveExistingPath(candidates: string[], label: string) {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  throw new Error(`Unable to locate ${label}. Checked: ${candidates.join(", ")}`);
}

function formatMagnitude(value: number | null | undefined, unit: string | null | undefined) {
  if (value == null) return "--";
  return `${value}${unit === "in" ? "\"" : unit ? ` ${unit}` : ""}`;
}

function formatDistance(value: number | null | undefined) {
  return value == null ? "--" : `${value} mi`;
}

function formatProbability(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= -900) return "--";
  return String(parsed);
}

function formatDate(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" });
}

function formatModeledDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDate(value);
  return formatDate(`${value}T00:00:00Z`);
}

function formatSolarImageryDate(value: Record<string, unknown> | null | undefined) {
  if (!value) return "";
  const year = Number(value.year);
  const month = Number(value.month);
  const day = Number(value.day);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return "";
  return formatDate(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00Z`);
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toISOString().replace("T", " ").slice(0, 16);
}

function formatDuration(value: number | null | undefined) {
  if (value == null) return "--";
  if (value < 60) return `${value} min`;
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

function formatEventType(value: string | null | undefined) {
  return titleCase(String(value ?? "")
    .replace(/_/g, " ")
    .replace(/\bTstm\b/gi, "Thunderstorm")
    .replace(/\bWnd\b/gi, "Wind")
    .replace(/\bDmg\b/gi, "Damage")
    .trim());
}

function formatAreaType(value: WeatherStormArea["area_type"]) {
  if (value === "warning_polygon") return "Warning polygon";
  if (value === "mrms_mesh_contour") return "MRMS/MESH contour";
  if (value === "estimated_swath") return "Estimated swath";
  return "Point buffer";
}

function truncate(value: unknown, maxLength: number) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function chunk<T>(values: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function round(value: number) {
  return Math.round(value * 10000) / 10000;
}

function summarizeRecordCounts(report: WeatherReport) {
  return {
    radar: report.records.filter((record) => record.dataset === "nx3hail").length,
    mrms: report.records.filter((record) => record.dataset === "mrms_mesh").length,
    lsr: report.records.filter((record) => record.dataset === "iem_lsr").length,
    warnings: report.records.filter((record) => record.dataset === "iem_warning").length
  };
}

function titleCase(value: string) {
  return value.replace(/\b\w/g, (match) => match.toUpperCase());
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
