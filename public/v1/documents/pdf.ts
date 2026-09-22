import { access } from "node:fs/promises";

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { chromium } from "playwright-core";

export type PaperDimensions = { w_pt: number; h_pt: number };

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function pdfFileName(title: unknown, fallback = "document") {
  return `${cleanText(title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || fallback}.pdf`;
}

/**
 * Locates a local Chrome/Edge executable for Playwright, mirroring the proven
 * proposals pipeline (`proposals/pdf.ts`). FIRSTMEASURE_PDF_BROWSER overrides.
 */
export async function resolveBrowserExecutablePath() {
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
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  throw new Error(`Unable to locate Chrome or Edge executable. Checked: ${candidates.join(", ")}`);
}

/**
 * Render harness HTML to a PDF. The harness (see render.ts) renders the
 * resolved DocModel with the shared renderer in static mode and flips
 * `window.__fmdocReady` when every image has decoded and every widget's static
 * render has resolved.
 */
export async function renderDocumentPdf(input: {
  html: string;
  paper: PaperDimensions;
  title?: string;
}) {
  const paper = input.paper ?? ({} as PaperDimensions);
  // Guard against callers passing a settings-style { size: "letter" } object:
  // a NaN viewport crashes Playwright with an opaque error.
  const widthPt = Number(paper.w_pt) > 0 ? Number(paper.w_pt) : 612;
  const heightPt = Number(paper.h_pt) > 0 ? Number(paper.h_pt) : 792;
  const widthIn = widthPt / 72;
  const heightIn = heightPt / 72;
  const browser = await chromium.launch({
    executablePath: await resolveBrowserExecutablePath(),
    headless: true,
    args: ["--disable-gpu", "--font-render-hinting=medium", "--disable-dev-shm-usage"]
  });
  try {
    const page = await browser.newPage({
      viewport: { width: Math.round(widthIn * 96), height: Math.round(heightIn * 96) },
      deviceScaleFactor: 1
    });
    await page.emulateMedia({ media: "print" });
    await page.setContent(input.html, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(async () => {
      await Promise.all(Array.from(document.images).map(async (image) => {
        if (!image.complete) {
          await new Promise<void>((resolve) => {
            image.addEventListener("load", () => resolve(), { once: true });
            image.addEventListener("error", () => resolve(), { once: true });
          });
        }
        if (typeof image.decode === "function") await image.decode().catch(() => undefined);
      }));
    });
    await page.waitForFunction(
      () => (window as Window & { __fmdocReady?: boolean }).__fmdocReady === true,
      undefined,
      { timeout: 20_000 }
    ).catch(() => null);
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => null);
    const pdf = await page.pdf({
      printBackground: true,
      width: `${widthIn}in`,
      height: `${heightIn}in`,
      margin: { top: "0px", right: "0px", bottom: "0px", left: "0px" },
      preferCSSPageSize: true
    });
    const renderedPageCount = await page.locator(".fmdoc-page").count().catch(() => 0);
    return {
      bytes: Buffer.from(pdf),
      fileName: pdfFileName(input.title),
      pageCount: renderedPageCount || 1
    };
  } finally {
    await browser.close();
  }
}

function wrapText(font: PDFFont, text: string, size: number, maxWidth: number) {
  const lines: string[] = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const words = rawLine.split(/\s+/).filter(Boolean);
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= maxWidth) {
        line = next;
      } else {
        if (line) lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

function drawTextBlock(page: PDFPage, text: string, options: {
  x: number;
  y: number;
  maxWidth: number;
  size: number;
  font: PDFFont;
  lineHeight?: number;
}) {
  const lineHeight = options.lineHeight ?? options.size + 5;
  let y = options.y;
  for (const line of wrapText(options.font, text, options.size, options.maxWidth)) {
    page.drawText(line || " ", {
      x: options.x,
      y,
      size: options.size,
      font: options.font,
      color: rgb(0.16, 0.18, 0.22)
    });
    y -= lineHeight;
  }
  return y;
}

/**
 * pdf-lib fallback when no render harness HTML is available (renderer library
 * missing, or a text-only summary is all that can be produced). Produces a
 * plain typed document, never a pixel-accurate render.
 */
export async function renderDocumentFallbackPdf(input: {
  title: string;
  paper: PaperDimensions;
  pages: Array<{ title?: string; body?: string }>;
  meta?: string;
}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const title = cleanText(input.title) || "Document";
  const entries = input.pages.length ? input.pages : [{ title, body: "Document content is available in the customer portal." }];
  entries.forEach((entry, index) => {
    const page = doc.addPage([input.paper.w_pt, input.paper.h_pt]);
    const { width, height } = page.getSize();
    page.drawRectangle({
      x: 34,
      y: 34,
      width: width - 68,
      height: height - 68,
      borderColor: rgb(0.82, 0.84, 0.88),
      borderWidth: 1,
      color: rgb(1, 1, 1)
    });
    page.drawText(index === 0 ? title : cleanText(entry.title) || `Page ${index + 1}`, {
      x: 56,
      y: height - 82,
      size: index === 0 ? 24 : 18,
      font: bold,
      color: rgb(0.08, 0.1, 0.14)
    });
    if (cleanText(input.meta)) {
      page.drawText(cleanText(input.meta), {
        x: 56,
        y: height - 106,
        size: 9,
        font,
        color: rgb(0.44, 0.48, 0.55)
      });
    }
    drawTextBlock(page, cleanText(entry.body) || "No visible text content on this page.", {
      x: 56,
      y: height - 142,
      maxWidth: width - 112,
      size: 11,
      lineHeight: 17,
      font
    });
    page.drawText(`${index + 1} / ${entries.length}`, {
      x: width - 86,
      y: 52,
      size: 9,
      font,
      color: rgb(0.44, 0.48, 0.55)
    });
  });
  return {
    bytes: Buffer.from(await doc.save()),
    fileName: pdfFileName(title),
    pageCount: entries.length
  };
}
