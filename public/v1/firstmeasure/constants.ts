export const FIRSTMEASURE_SCHEMA_VERSION = 1;

export const FIRSTMEASURE_COMPLEXITY_POINT_VALUES: Record<string, number> = {
  "1": 2,
  "2": 3,
  "3": 4,
  "4": 6,
  "5": 10,
  very_simple: 2,
  very_simple_project: 2,
  simple: 3,
  simple_project: 3,
  standard: 4,
  standard_project: 4,
  complex: 6,
  complex_project: 6,
  very_complex: 10,
  very_complex_project: 10
} as const;

export function normalizeFirstMeasureComplexityKey(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  const raw = String(value).trim().toLowerCase();
  if (!raw) return null;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return String(Math.trunc(numeric));
  return raw.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function firstMeasurePointValueForComplexity(value: unknown): number | null {
  const key = normalizeFirstMeasureComplexityKey(value);
  if (!key) return null;
  return FIRSTMEASURE_COMPLEXITY_POINT_VALUES[key] ?? null;
}

export const FIRSTMEASURE_FILE_NAMES = {
  manifest: "manifest.json",
  appMetadata: "app_metadata.json",
  pdfState: "pdf_state.json",
  brandingDefaults: "branding_defaults.json",
  xmlStored: "model_data.xml",
  xmlGenerated: "model_data.generated.xml"
} as const;

export const PDF_FILE_NAMES = {
  report: "Report.pdf",
  main: "Report.pdf",
  summary: "Summary.pdf"
} as const;

export type PdfType = "report";
export type PdfSlot = "main" | "summary";

export const PAGE_KEYS = [
  "cover",
  "top_view",
  "elevations",
  "facets_3d",
  "pitch",
  "area",
  "layers",
  "structures",
  "project_summary",
  "materials",
  "ventilation",
  "gutters",
  "notes"
] as const;

export type PageKey = (typeof PAGE_KEYS)[number];

export const DEFAULT_REPORT_PAGE_ORDER: PageKey[] = [
  "cover",
  "top_view",
  "elevations",
  "facets_3d",
  "pitch",
  "area",
  "layers",
  "structures",
  "project_summary",
  "materials",
  "ventilation",
  "gutters",
  "notes"
];

export const PAGE_KEY_TO_FLAG: Partial<Record<PageKey, string>> = {
  top_view: "page_top_view",
  elevations: "page_elevations",
  facets_3d: "page_3d",
  pitch: "page_pitch",
  area: "page_area",
  layers: "page_layers",
  project_summary: "page_summary",
  materials: "page_materials",
  ventilation: "page_ventilation",
  gutters: "page_gutters",
  notes: "page_notes"
};

export const DEFAULT_PAGE_CONFIG = {
  cover_show_prepared_for: true,
  cover_show_customer: true,
  cover_show_squares: true,
  cover_show_waste: true,
  cover_show_breakdown: true,
  cover_show_pitch: true,
  cover_show_facets: true,
  page_top_view: true,
  page_elevations: true,
  page_3d: true,
  page_pitch: true,
  page_area: true,
  page_layers: true,
  page_summary: true,
  page_materials: true,
  page_ventilation: true,
  page_gutters: true,
  page_notes: true
} as const;
