import { access } from "node:fs/promises";

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { chromium } from "playwright-core";

import { normalizeProposalScope, publicScopeLineItems } from "./scope.js";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
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

function plainText(value: unknown) {
  return cleanText(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function numberValue(value: unknown) {
  const cleaned = cleanText(value).replace(/[^0-9.-]/g, "");
  return Number(cleaned) || 0;
}

function money(value: unknown) {
  return `$${numberValue(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function wrapText(font: PDFFont, text: string, size: number, maxWidth: number) {
  const lines: string[] = [];
  const rawLines = String(text || "").split(/\r?\n/);
  for (const rawLine of rawLines) {
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

function proposalContent(source: JsonObject) {
  const content = asObject(source.content);
  const editable = asObject(source.editable);
  return Object.keys(content).length ? content : editable;
}

const PROPOSAL_PAPER_SIZES = {
  letter: { key: "letter", widthIn: 8.5, heightIn: 11, cssWidth: "8.5in", cssHeight: "11in" },
  legal: { key: "legal", widthIn: 8.5, heightIn: 14, cssWidth: "8.5in", cssHeight: "14in" },
  a4: { key: "a4", widthIn: 210 / 25.4, heightIn: 297 / 25.4, cssWidth: "210mm", cssHeight: "297mm" }
} as const;

function proposalPaperDimensions(source: JsonObject, content: JsonObject) {
  const raw = cleanText(content.paper_size || content.paperSize || source.paper_size || source.paperSize).toLowerCase();
  const key = raw === "legal" || raw === "us-legal" ? "legal" : raw === "a4" || raw === "iso-a4" ? "a4" : "letter";
  return PROPOSAL_PAPER_SIZES[key];
}

function pageTitle(page: JsonObject, index: number) {
  return plainText(page.title || page.heading || page.kicker || `Page ${index + 1}`) || `Page ${index + 1}`;
}

function pageBody(page: JsonObject) {
  const kind = cleanText(page.kind).toLowerCase();
  if (kind === "pricing") {
    const items = Array.isArray(page.line_items) ? page.line_items.map(asObject) : Array.isArray(page.lineItems) ? page.lineItems.map(asObject) : [];
    const lines = items.map((item) => {
      const label = plainText(item.label || item.name || "Line item");
      const qty = plainText(item.quantity || "1");
      const amount = money(item.amount || item.total || 0);
      return `${label} (${qty}) - ${amount}`;
    });
    const notes = plainText(page.notes);
    return [...lines, notes].filter(Boolean).join("\n");
  }
  if (kind === "signature") {
    return [
      plainText(page.summary),
      `${plainText(page.paymentScheduleTitle || "Payment Schedule")}`,
      `${plainText(page.depositLabel || "Deposit Amount")}: ${money(page.depositAmount || 0)}`,
      `${plainText(page.completionLabel || "Balance During Completion")}: ${money(page.completionAmount || 0)}`,
      `${plainText(page.financedLabel || "Amount Financed")}: ${money(page.financedAmount || 0)}`
    ].filter(Boolean).join("\n");
  }
  if (kind === "fine_print") return plainText(page.body || page.summary);
  const blocks = Array.isArray(page.blocks) ? page.blocks.map(asObject).map((block) => plainText(block.text)).filter(Boolean) : [];
  return [plainText(page.body || page.summary || page.description), ...blocks].filter(Boolean).join("\n\n");
}

export async function renderProposalPdf(input: {
  proposal: JsonObject;
  snapshot?: JsonObject | null;
  title?: string;
  html?: string;
}) {
  const proposal = asObject(input.proposal);
  const snapshot = asObject(input.snapshot);
  const source = Object.keys(snapshot).length ? snapshot : proposal;
  const content = proposalContent(source);
  const paper = proposalPaperDimensions(source, content);
  const scope = normalizeProposalScope(content.scope);
  const pages = Array.isArray(content.pages) ? content.pages.map(asObject).map((page) => {
    if (cleanText(page.kind).toLowerCase() !== "pricing") return page;
    const scopeView = asObject(page.scope_view || {
      root_item_id: cleanText(page.scope_root_id || "root") || "root",
      render_depth: Number(page.render_depth ?? 1) || 1,
      show_included_items: page.show_included_items !== false
    });
    const lineItems = publicScopeLineItems(scope, scopeView);
    return lineItems.length ? { ...page, line_items: lineItems } : page;
  }) : [];
  const title = cleanText(input.title || source.title || proposal.title || content.title || "Proposal") || "Proposal";
  const html = cleanText(input.html);
  if (html) {
    const browser = await chromium.launch({
      executablePath: await resolveBrowserExecutablePath(),
      headless: true,
      args: ["--disable-gpu", "--font-render-hinting=medium", "--disable-dev-shm-usage"]
    });
    try {
      const page = await browser.newPage({
        viewport: { width: Math.round(paper.widthIn * 96), height: Math.round(paper.heightIn * 96) },
        deviceScaleFactor: 1
      });
      await page.emulateMedia({ media: "screen" });
      await page.setContent(html, { waitUntil: "domcontentloaded" });
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
        await Promise.all(Array.from(document.querySelectorAll<HTMLVideoElement>("video.r-proposal-video-print-fallback")).map((video) => new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          const captureFrame = () => {
            try {
              if (Number.isFinite(video.duration) && video.duration > 0.1) video.currentTime = Math.min(0.1, video.duration / 2);
            } catch {
              finish();
              return;
            }
            if (video.seeking) video.addEventListener("seeked", finish, { once: true });
            else finish();
          };
          if (video.readyState >= 2) captureFrame();
          else {
            video.addEventListener("loadeddata", captureFrame, { once: true });
            video.addEventListener("error", finish, { once: true });
            video.load();
          }
          setTimeout(finish, 3_000);
        })));
      });
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => null);
      await page.waitForFunction(
        () => (window as Window & { __proposalPdfCanvasReady?: boolean }).__proposalPdfCanvasReady !== false,
        undefined,
        { timeout: 15_000 }
      ).catch(() => null);
      const pdf = await page.pdf({
        printBackground: true,
        width: paper.cssWidth,
        height: paper.cssHeight,
        margin: { top: "0px", right: "0px", bottom: "0px", left: "0px" },
        preferCSSPageSize: true
      });
      const renderedPageCount = await page.locator(".r-proposal-page").count().catch(() => 0);
      return {
        bytes: Buffer.from(pdf),
        fileName: `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "proposal"}.pdf`,
        pageCount: renderedPageCount || pages.length || 1
      };
    } finally {
      await browser.close();
    }
  }

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pageEntries = pages.length ? pages : [{ kind: "summary", title, body: "Proposal content is available in the customer portal." }];

  pageEntries.forEach((entry, index) => {
    const page = doc.addPage([paper.widthIn * 72, paper.heightIn * 72]);
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
    page.drawText(index === 0 ? title : pageTitle(entry, index), {
      x: 56,
      y: height - 82,
      size: index === 0 ? 24 : 18,
      font: bold,
      color: rgb(0.08, 0.1, 0.14)
    });
    const meta = [
      cleanText(source.project_id || proposal.project_id) ? `Project: ${cleanText(source.project_id || proposal.project_id)}` : "",
      cleanText(source.snapshot_number) ? `Snapshot: ${cleanText(source.snapshot_number)}` : "",
      cleanText(source.created_at || proposal.created_at) ? `Created: ${cleanText(source.created_at || proposal.created_at).slice(0, 10)}` : ""
    ].filter(Boolean).join("  ");
    if (meta) {
      page.drawText(meta, {
        x: 56,
        y: height - 106,
        size: 9,
        font,
        color: rgb(0.44, 0.48, 0.55)
      });
    }
    const body = pageBody(entry) || "No visible text content on this page.";
    drawTextBlock(page, body, {
      x: 56,
      y: height - 142,
      maxWidth: width - 112,
      size: 11,
      lineHeight: 17,
      font
    });
    page.drawText(`${index + 1} / ${pageEntries.length}`, {
      x: width - 86,
      y: 52,
      size: 9,
      font,
      color: rgb(0.44, 0.48, 0.55)
    });
  });

  return {
    bytes: Buffer.from(await doc.save()),
    fileName: `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "proposal"}.pdf`,
    pageCount: pageEntries.length
  };
}
