export const PRICEBOOK_SCHEMA_VERSION = 1;
export const DEFAULT_TEMPLATE_KEY = "default";

export const PRICEBOOK_FILE_NAMES = {
  manifest: "manifest.json",
  catalog: "catalog.json"
} as const;

export const PRICEBOOK_CATEGORIES = [
  "misc",
  "disposal",
  "shingle_roofs",
  "leak_barriers",
  "flashing",
  "accessories",
  "gutters",
  "flat_roofs",
  "flat_roof_accessories"
] as const;

export const PRICEBOOK_UNITS = [
  "sq",
  "lf",
  "ea",
  "bundle",
  "hour"
] as const;

export const PRICEBOOK_FORMULA_TOKEN_TYPES = [
  "measurement",
  "number",
  "operator",
  "paren"
] as const;

export const PRICEBOOK_OPERATORS = ["+", "-", "*", "/"] as const;
export const PRICEBOOK_PARENS = ["(", ")"] as const;

export const PRICEBOOK_MANUFACTURERS = [
  "all",
  "generic",
  "gaf",
  "owens_corning",
  "malarkey",
  "certainteed",
  "atlas",
  "iko"
] as const;

export const PRICEBOOK_SEGMENTS = [
  "all",
  "sloped",
  "flat",
  "other"
] as const;

export const MEASUREMENT_FIELDS = [
  { key: "roofSquares", label: "Roof Squares (Total)" },
  { key: "shingleSquares", label: "Shingle Squares" },
  { key: "flatRoofSquares", label: "Flat Roof Squares (2/12 and below)" },
  { key: "pitch2to4Squares", label: "Squares at 2/12 - 4/12" },
  { key: "pitch4to6Squares", label: "Squares at 4/12 - 6/12" },
  { key: "pitch6to8Squares", label: "Squares at 6/12 - 8/12" },
  { key: "pitch9to12Squares", label: "Squares at 9/12 - 12/12" },
  { key: "pitch13PlusSquares", label: "Squares at 13/12 and above" },
  { key: "wastePercent", label: "Waste %" },
  { key: "eavesLf", label: "Eaves" },
  { key: "rakesLf", label: "Rakes" },
  { key: "hipsLf", label: "Hips" },
  { key: "ridgesLf", label: "Ridges" },
  { key: "valleyLf", label: "Valleys" },
  { key: "transitionsLf", label: "Transitions" },
  { key: "sideWallLf", label: "Side Wall" },
  { key: "headWallLf", label: "Head Wall" },
  { key: "gutterLf", label: "Gutters" },
  { key: "downspoutLf", label: "Downspouts" },
  { key: "structures", label: "Structures" },
  { key: "chimneysEa", label: "Chimneys" },
  { key: "skylightsEa", label: "Skylights" }
] as const;

export type PricebookCategory = (typeof PRICEBOOK_CATEGORIES)[number];
export type PricebookUnit = (typeof PRICEBOOK_UNITS)[number];
export type PricebookFormulaTokenType = (typeof PRICEBOOK_FORMULA_TOKEN_TYPES)[number];
export type PricebookManufacturer = (typeof PRICEBOOK_MANUFACTURERS)[number];
export type PricebookSegment = (typeof PRICEBOOK_SEGMENTS)[number];
