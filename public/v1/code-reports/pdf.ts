import path from "node:path";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

import { isFirstMeasurePostgresEnabled } from "../src/database/postgres.js";
import { codeReportStorageRoot, readCodeReport } from "./storage.js";
import type { CodeReport } from "./types.js";
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

type CodePdfAssetPaths = {
  browserExecutablePath: string;
  defaultLogoPath: string;
  fontRegularPath: string;
  fontBoldPath: string;
};

let cachedAssetPathsPromise: Promise<CodePdfAssetPaths> | null = null;

export async function generateCodeReportPdf(reportId: string) {
  const report = await readCodeReport(reportId);
  const bytes = await renderCodeReportPdfDocument(report);
  const dir = path.join(codeReportStorageRoot(), "pdfs");
  const fileName = codeReportPdfFileName(report);
  const filePath = path.join(dir, fileName);
  if (!isFirstMeasurePostgresEnabled()) {
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, bytes);
  }
  return { report, bytes, fileName, filePath };
}

export async function renderCodeReportPdfDocument(report: CodeReport) {
  const assets = await loadCodePdfAssets();
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
    await page.setContent(buildCodeReportHtml(report, {
      logoDataUrl: `data:image/png;base64,${logo.toString("base64")}`,
      fontRegularDataUrl: `data:font/ttf;base64,${fontRegular.toString("base64")}`,
      fontBoldDataUrl: `data:font/ttf;base64,${fontBold.toString("base64")}`
    }), { waitUntil: "domcontentloaded" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => null);
    const pdf = await page.pdf({
      printBackground: true,
      width: `${PAGE_WIDTH_PX}px`,
      height: `${PAGE_HEIGHT_PX}px`,
      margin: { top: "0px", right: "0px", bottom: "0px", left: "0px" },
      preferCSSPageSize: true
    });
    const address = String(report.property.matched_address ?? report.property.input_address ?? "Property").trim() || "Property";
    return finalizeFirstMatePdf(pdf, {
      title: `${address} - FirstMate Code Report`,
      subject: "FirstMate property code report",
      keywords: ["building code", "roofing code", "report"]
    });
  } finally {
    await browser.close();
  }
}

export function codeReportPdfFileName(report: CodeReport) {
  const cityish = String(report.property.matched_address ?? report.property.input_address ?? "code-report")
    .split(",")[0]
    ?.replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "code-report";
  return `${cityish}-code-report-${report.id.slice(0, 8)}.pdf`;
}

function buildCodeReportHtml(report: CodeReport, assets: { logoDataUrl: string; fontRegularDataUrl: string; fontBoldDataUrl: string }) {
  const pages = [
    renderCoverPage(report, assets.logoDataUrl),
    renderRoofingSummaryPage(report, assets.logoDataUrl),
    renderRoofingRequirementsPage(report, assets.logoDataUrl),
    renderFirstMeasurePage(report, assets.logoDataUrl),
    renderSourcesPage(report, assets.logoDataUrl)
  ].join("");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(report.property.matched_address ?? "Code Report")}</title>
<style>
@page{size:${PAGE_WIDTH_PX}px ${PAGE_HEIGHT_PX}px;margin:0}
@font-face{font-family:Montserrat;src:url('${assets.fontRegularDataUrl}') format('truetype');font-weight:400}
@font-face{font-family:Montserrat;src:url('${assets.fontBoldDataUrl}') format('truetype');font-weight:700}
:root{--ink:#19202a;--muted:#68707c;--primary:#c82828;--secondary:#960000;--card:#fff;--border:#dcdcdc;--shadow:#ececec;--soft:#f6f7f9;--watch:#b05a00;--elevated:#9b1111}
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
.footer{position:absolute;left:${CONTENT_LEFT_PX}px;right:${CONTENT_RIGHT_PX}px;bottom:${Math.round(8 * PX_PER_MM)}px;display:flex;justify-content:space-between;color:#8a9099;font-size:16px}
.kicker{font-size:24px;font-weight:700;color:var(--primary);letter-spacing:.08em;text-transform:uppercase;margin:0 0 14px}
h1{font-size:64px;line-height:1.06;margin:0 0 16px;font-weight:700;letter-spacing:0}
h2{font-size:44px;line-height:1.15;margin:0 0 22px;font-weight:700;letter-spacing:0}
h3{font-size:25px;margin:0 0 13px;font-weight:700}
p{font-size:23px;line-height:1.5;margin:0 0 16px;color:#28313d}
.muted{color:var(--muted)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:32px}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}
.card{background:var(--card);border:3px solid var(--border);border-radius:${CARD_RADIUS_PX}px;box-shadow:12px 12px 0 var(--shadow);padding:30px}
.tight{padding:24px}
.stat .label{font-size:18px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:700;margin-bottom:10px}
.stat .value{font-size:39px;font-weight:700;color:var(--ink);line-height:1.1}
.stat .sub{font-size:20px;color:var(--muted);line-height:1.35;margin-top:10px}
.callout{border-left:7px solid var(--primary);padding:6px 0 6px 18px}
.sectionGap{margin-top:28px}
.table{width:100%;border-collapse:collapse;font-size:19px;table-layout:fixed}
.table th{font-size:14px;text-align:left;color:#68707c;text-transform:uppercase;letter-spacing:.05em;border-bottom:2px solid #d7dbe0;padding:0 8px 12px}
.table td{border-bottom:1px solid #e5e7eb;padding:13px 8px;vertical-align:top;line-height:1.35}
.pill{display:inline-block;background:#f7e8e8;color:#9b1111;font-weight:700;border-radius:999px;padding:7px 13px;font-size:18px}
.finding{border-left:7px solid #c4c9d0;padding:6px 0 6px 18px;margin-bottom:22px}
.finding.watch{border-color:var(--watch)}.finding.elevated{border-color:var(--elevated)}
.findingTitle{font-size:24px;font-weight:700;margin-bottom:8px}
.finding p{font-size:20px;margin:0 0 6px}
.reqGrid{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.reqItem{border:2px solid var(--border);border-left:7px solid var(--primary);border-radius:${CARD_RADIUS_PX}px;padding:16px;background:#fff}
.reqHead{font-size:19px;font-weight:700;margin-bottom:6px}
.reqMeta{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#68707c;font-weight:700;margin-bottom:7px}
.reqText{font-size:15px;line-height:1.32;color:#28313d;margin-bottom:7px}
.reqValue{font-size:14px;line-height:1.25;color:#4b5563}
.diagram{height:500px;background:linear-gradient(180deg,#f8fafc 0,#eef2f5 100%);border:3px solid var(--border);border-radius:${CARD_RADIUS_PX}px;position:relative;overflow:hidden}
.roof{position:absolute;left:220px;top:105px;width:520px;height:290px;background:#fff;border:5px solid #27313d;transform:skewY(-12deg);box-shadow:18px 18px 0 #d8dde3}
.roof::before{content:"";position:absolute;left:0;right:0;top:50%;border-top:5px solid var(--primary)}
.roof::after{content:"";position:absolute;top:0;bottom:0;left:50%;border-left:5px solid #27313d}
.pin{position:absolute;left:1180px;top:165px;width:150px;height:150px;border-radius:50%;background:#19202a;border:18px solid #fff;box-shadow:0 8px 24px rgba(0,0,0,.25)}
.pin::after{content:"";position:absolute;left:45px;top:45px;width:24px;height:24px;border-radius:50%;background:#c82828}
.source{font-size:20px;line-height:1.38}
.limitations li{font-size:22px;line-height:1.45;margin:0 0 12px;color:#3a4350}
</style>
</head>
<body>${pages}</body>
</html>`;
}

function renderPageShell(report: CodeReport, logoDataUrl: string, title: string, body: string, pageNumber: number) {
  return `<section class="page">
    <div class="linePrimary"></div><div class="lineSecondary"></div>
    <div class="brand"><img src="${logoDataUrl}" alt="FirstMeasure"></div>
    <div class="header">Code Report<br>${escapeHtml(report.design.reference_code)}<br>${escapeHtml(formatDate(report.generated_at))}</div>
    <main class="content">${body}</main>
    <div class="footer"><span>${escapeHtml(title)}</span><span>${pageNumber}</span></div>
  </section>`;
}

function renderCoverPage(report: CodeReport, logoDataUrl: string) {
  const elevated = report.findings.filter((finding) => finding.severity === "elevated").length;
  const body = `
    <div>
      <p class="kicker">Automated Code Report</p>
      <h1>Property Code & Hazard Summary</h1>
      <p class="muted">${escapeHtml(report.property.matched_address ?? report.property.input_address ?? "Coordinates supplied")}</p>
      <p class="muted">Prepared ${escapeHtml(formatDate(report.generated_at))} from public jurisdiction, seismic, flood, and FirstMeasure project data.</p>
    </div>
    <div class="grid3 sectionGap">
      ${statCard("Adopted Code", "2021 IRC", report.roofing.adopted_code_effective_date ? `Effective ${report.roofing.adopted_code_effective_date}` : "Local adoption")}
      ${statCard("Design Wind", `${report.roofing.local_design_criteria.design_wind_speed_mph ?? "--"} mph`, report.roofing.local_design_criteria.exposure ?? "Exposure by site")}
      ${statCard("Ground Snow", `${report.roofing.local_design_criteria.ground_snow_load_psf ?? "--"} psf`, "Local design criteria")}
    </div>
    <div class="grid2 sectionGap">
      <div class="card">
        <h2>Summary</h2>
        <p class="callout">${escapeHtml(report.summary.narrative)}</p>
      </div>
      <div class="card">
        <h3>Jurisdiction Context</h3>
        ${miniMetric("Likely AHJ", report.roofing.requirements[0]?.report_value ?? report.jurisdiction.authority ?? "--")}
        ${miniMetric("County", report.property.county ?? "--")}
        ${miniMetric("State / ZIP", `${report.property.state ?? "--"} ${report.property.postal_code ?? ""}`.trim())}
        ${miniMetric("Coordinates", `${formatNumber(report.property.lat, 5)}, ${formatNumber(report.property.lon, 5)}`)}
      </div>
    </div>`;
  return renderPageShell(report, logoDataUrl, "Roofing Code Summary", body, 1);
}

function renderRoofingSummaryPage(report: CodeReport, logoDataUrl: string) {
  const criteria = report.roofing.local_design_criteria;
  const required = report.roofing.requirements.filter((item) => item.status === "required");
  const body = `
    <h2>Local Roofing Code Basis</h2>
    <div class="grid3">
      ${statCard("Roof Covering", "Asphalt Shingle", "IRC R905.2")}
      ${statCard("Shingle Rating", report.roofing.assumptions.shingle_product_wind_rating, "Input / default product basis")}
      ${statCard("Required Items", String(required.length), "Roofing requirements flagged")}
    </div>
    <div class="grid2 sectionGap">
      <div class="card">
        <h3>Local Design Criteria</h3>
        ${valueTable([
          ["Adopted code", report.roofing.adopted_code],
          ["Effective date", report.roofing.adopted_code_effective_date ?? "--"],
          ["Design wind speed", `${criteria.design_wind_speed_mph ?? "--"} mph`],
          ["Exposure", criteria.exposure ?? "--"],
          ["Ground snow load", `${criteria.ground_snow_load_psf ?? "--"} psf`],
          ["Drainage rainfall", `${criteria.roof_drainage_rainfall_inches_per_hour ?? "--"} in/hr`],
          ["Frost line", `${criteria.frost_line_inches ?? "--"} in`],
          ["Seismic zone", criteria.seismic_zone ?? report.design.seismic.sdc ?? "--"]
        ])}
      </div>
      <div class="card">
        <h3>Hazard Cross-Check</h3>
        ${valueTable([
          ["USGS SDC", report.design.seismic.sdc ?? "--"],
          ["SDS", report.design.seismic.sds ?? "--"],
          ["SD1", report.design.seismic.sd1 ?? "--"],
          ["FEMA flood zone", report.design.flood.zone ?? "--"],
          ["FEMA subtype", report.design.flood.subtype ?? "--"],
          ["FIRM panel", report.design.flood.panel ?? "--"]
        ])}
        <p class="muted sectionGap">This page uses local adopted criteria where available, then cross-checks national seismic and flood datasets for documentation.</p>
      </div>
    </div>`;
  return renderPageShell(report, logoDataUrl, "Local Code Basis", body, 2);
}

function renderRoofingRequirementsPage(report: CodeReport, logoDataUrl: string) {
  const body = `
    <h2>Roofing Requirements</h2>
    <div class="card">
      <h3>Asphalt Shingle Scope</h3>
      <div class="reqGrid">
        ${report.roofing.requirements.map((item) => `<div class="reqItem">
          <div class="reqHead">${escapeHtml(item.category)}</div>
          <div class="reqMeta">${escapeHtml(item.code_reference)} · ${escapeHtml(item.status.toUpperCase())}</div>
          <div class="reqText">${escapeHtml(item.requirement)}</div>
          <div class="reqValue"><strong>Report value:</strong> ${escapeHtml(item.report_value)}</div>
        </div>`).join("")}
      </div>
    </div>`;
  return renderPageShell(report, logoDataUrl, "Roofing Requirements", body, 3);
}

function renderFirstMeasurePage(report: CodeReport, logoDataUrl: string) {
  const fm = report.firstmeasure;
  const rows = fm?.structures.map((structure) => [
    structure.label,
    sqft(structure.roof_area_sqft),
    sqft(structure.ground_area_sqft),
    structure.pitch_degrees == null ? "--" : `${structure.pitch_degrees} deg`,
    structure.segment_count ?? "--"
  ]) ?? [];
  const body = `
    <h2>FirstMeasure Geometry</h2>
    <div class="diagram"><div class="roof"></div><div class="pin"></div></div>
    <div class="grid3 sectionGap">
      ${statCard("Roof Area", fm ? sqft(fm.total_roof_area_sqft) : "--", "From FirstMeasure artifacts")}
      ${statCard("Roof Faces", fm?.roof_face_count == null ? "--" : String(fm.roof_face_count), "Model geometry")}
      ${statCard("Predominant Pitch", fm?.predominant_pitch ?? "--", fm?.imagery_date ? `Imagery ${fm.imagery_date}` : "No project supplied")}
    </div>
    <div class="card sectionGap">
      <h3>Structure Summary</h3>
      ${rows.length ? table(["Structure", "Roof area", "Ground area", "Pitch", "Segments"], rows) : `<p class="muted">Supply a FirstMeasure project ID to include measured roof geometry, imagery date, structure counts, and roof-area details.</p>`}
    </div>`;
  return renderPageShell(report, logoDataUrl, "FirstMeasure Geometry", body, 4);
}

function renderSourcesPage(report: CodeReport, logoDataUrl: string) {
  const body = `
    <h2>Sources & Limitations</h2>
    <div class="card">
      <h3>Data Sources</h3>
      ${report.sources.map((source) => `<p class="source"><strong>${escapeHtml(source.name)}</strong> <span class="pill">${escapeHtml(source.status)}</span><br>${escapeHtml(source.url)}${source.note ? `<br><span class="muted">${escapeHtml(source.note)}</span>` : ""}</p>`).join("")}
    </div>
    <div class="card sectionGap">
      <h3>Limitations</h3>
      <ul class="limitations">${report.summary.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    </div>`;
  return renderPageShell(report, logoDataUrl, "Sources", body, 5);
}

function statCard(label: string, value: string, sub: string) {
  return `<div class="card tight stat"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div><div class="sub">${escapeHtml(sub)}</div></div>`;
}

function miniMetric(label: string, value: string) {
  return `<div class="stat" style="margin-bottom:24px"><div class="label">${escapeHtml(label)}</div><div class="value" style="font-size:30px">${escapeHtml(value)}</div></div>`;
}

function valueTable(rows: Array<[string, unknown]>) {
  return table(["Value", "Result"], rows.map(([label, value]) => [label, value == null ? "--" : String(value)]));
}

function table(headers: string[], rows: Array<Array<unknown>>) {
  return `<table class="table"><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(String(cell ?? "--"))}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

async function loadCodePdfAssets() {
  const promise = cachedAssetPathsPromise ?? (cachedAssetPathsPromise = (async () => {
    const distRoot = path.resolve(MODULE_DIR, "..");
    const sourceRoot = path.resolve(MODULE_DIR, "..", "..");
    const candidatePublicRoots = [path.resolve(distRoot, ".."), path.resolve(sourceRoot, "..")];
    return {
      browserExecutablePath: await resolveBrowserExecutablePath(),
      defaultLogoPath: await resolveExistingPath(candidatePublicRoots.map((root) => path.join(root, "images", "logo_red.png")), "default FirstMeasure logo"),
      fontRegularPath: await resolveExistingPath(candidatePublicRoots.map((root) => path.join(root, "fonts", "Montserrat-Regular.ttf")), "Montserrat regular font"),
      fontBoldPath: await resolveExistingPath(candidatePublicRoots.map((root) => path.join(root, "fonts", "Montserrat-Bold.ttf")), "Montserrat bold font")
    } satisfies CodePdfAssetPaths;
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
      : ["/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium", "/snap/bin/chromium"];
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

function formatDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" });
}

function formatNumber(value: number, digits: number) {
  return Number.isFinite(value) ? value.toFixed(digits) : "--";
}

function sqft(value: number | null | undefined) {
  return value == null ? "--" : `${Math.round(value).toLocaleString("en-US")} sq ft`;
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
