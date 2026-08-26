import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import {
  DEFAULT_REPORT_PAGE_ORDER,
  DEFAULT_PAGE_CONFIG,
  PAGE_KEY_TO_FLAG,
  PDF_FILE_NAMES,
  type PageKey
} from "./constants.js";
import type { ProjectManifest } from "./storage.js";
import { setFirstMatePdfMetadata } from "../src/pdf_metadata.js";

type RenderInput = {
  page_config?: Record<string, unknown>;
  branding?: Record<string, unknown>;
  prepared_for?: Record<string, unknown>;
  pages?: Array<Record<string, unknown>>;
  page?: Record<string, unknown>;
};

type PageRequest = {
  key: PageKey;
  page_number?: number;
  show_page_number?: boolean;
};

export async function renderProjectPdf(
  manifest: ProjectManifest,
  input: RenderInput,
  options: {
    wholeDocument: boolean;
    storedFileName?: string;
    title?: string;
  }
) {
  const doc = await PDFDocument.create();
  setFirstMatePdfMetadata(doc, {
    title: options.title ?? "FirstMate FirstMeasure Report",
    subject: "FirstMate FirstMeasure roof measurement report",
    keywords: ["FirstMeasure", "roof measurement", "report"]
  });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);

  const pageConfig = {
    ...DEFAULT_PAGE_CONFIG,
    ...(isRecord(input.page_config) ? input.page_config : {})
  };
  const branding = isRecord(input.branding) ? input.branding : {};
  const preparedFor = isRecord(input.prepared_for) ? input.prepared_for : {};
  const showPreparedFor = shouldShowPreparedFor(preparedFor, pageConfig);
  const pages = resolvePages(input, pageConfig);

  pages.forEach((pageRequest, index) => {
    const page = doc.addPage([612, 792]);
    const { width, height } = page.getSize();

    page.drawRectangle({
      x: 32,
      y: 32,
      width: width - 64,
      height: height - 64,
      color: rgb(0.985, 0.972, 0.95),
      borderColor: rgb(0.72, 0.62, 0.5),
      borderWidth: 1
    });

    page.drawText(options.title ?? "FirstMeasure Report", {
      x: 48,
      y: height - 72,
      size: 22,
      font: boldFont,
      color: rgb(0.32, 0.16, 0.06)
    });

    const lines = [
      `Project: ${manifest.address}`,
      `Project ID: ${manifest.id}`,
      `Status: ${manifest.status}`,
      `Gutter measurements requested: ${manifest.include_gutter_measurements ? "yes" : "no"}`,
      `Page key: ${pageRequest.key}`,
      `Branding: ${describeBrandingVariant(branding)}`,
      `Prepared for: ${showPreparedFor ? describePreparedFor(preparedFor) : "not included"}`
    ];

    let cursorY = height - 116;
    for (const line of lines) {
      page.drawText(line, {
        x: 48,
        y: cursorY,
        size: 11,
        font,
        color: rgb(0.18, 0.18, 0.18)
      });
      cursorY -= 18;
    }

    page.drawText("This is the current API placeholder PDF renderer.", {
      x: 48,
      y: cursorY - 10,
      size: 11,
      font: boldFont,
      color: rgb(0.48, 0.12, 0.1)
    });

    const explicitPageNumber = pageRequest.page_number;
    const shouldShowPageNumber = options.wholeDocument
      ? pageRequest.show_page_number !== false
      : pageRequest.show_page_number === true || explicitPageNumber !== undefined;

    if (shouldShowPageNumber) {
      const printedNumber = explicitPageNumber ?? index + 1;
      page.drawText(String(printedNumber), {
        x: width - 72,
        y: 44,
        size: 10,
        font,
        color: rgb(0.3, 0.3, 0.3)
      });
    }
  });

  return {
    bytes: await doc.save(),
    fileName: options.storedFileName ?? PDF_FILE_NAMES.report,
    pageCount: pages.length,
    pages
  };
}

function resolvePages(
  input: RenderInput,
  pageConfig: Record<string, unknown>
): PageRequest[] {
  if (input.page && isRecord(input.page)) {
    return [normalizePageRequest(input.page)];
  }

  if (Array.isArray(input.pages) && input.pages.length > 0) {
    return input.pages.filter(isRecord).map(normalizePageRequest);
  }

  return DEFAULT_REPORT_PAGE_ORDER
    .filter((pageKey) => isPageEnabled(pageKey, pageConfig))
    .map((pageKey) => ({ key: pageKey }));
}

function isPageEnabled(pageKey: PageKey, pageConfig: Record<string, unknown>) {
  const flag = PAGE_KEY_TO_FLAG[pageKey];
  if (!flag) {
    return true;
  }
  return pageConfig[flag] !== false;
}

function normalizePageRequest(page: Record<string, unknown>): PageRequest {
  return {
    key: String(page.key) as PageKey,
    page_number: typeof page.page_number === "number" ? page.page_number : undefined,
    show_page_number: typeof page.show_page_number === "boolean" ? page.show_page_number : undefined
  };
}

function describeBrandingVariant(value: unknown) {
  if (!isRecord(value)) {
    return "default";
  }
  const logo = typeof value.logo_url === "string" ? value.logo_url : "none";
  const primary = typeof value.primary_color === "string" ? value.primary_color : "default";
  const secondary = typeof value.secondary_color === "string" ? value.secondary_color : "default";
  return `logo=${logo} primary=${primary} secondary=${secondary}`;
}

function describePreparedFor(value: Record<string, unknown>) {
  const pieces = [
    value.name,
    value.company,
    value.address_line_1,
    value.city,
    value.state,
    value.postal_code
  ].filter((piece) => typeof piece === "string" && piece.trim().length > 0);

  return pieces.length > 0 ? pieces.join(", ") : "included";
}

function shouldShowPreparedFor(preparedFor: Record<string, unknown>, pageConfig: Record<string, unknown>) {
  const hasPreparedFor = Object.values(preparedFor).some((value) => typeof value === "string" && value.trim().length > 0);
  return hasPreparedFor && pageConfig.cover_show_prepared_for !== false && pageConfig.cover_show_customer !== false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
