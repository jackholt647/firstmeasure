import type { JsonObject } from "../platform/storage.js";
import { readBranchModule, readDocument, readGlobal, readOrganization } from "../platform/storage.js";

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    const text = cleanText(value);
    if (text) return text;
  }
  return "";
}

/** Company Settings branding, layered global -> org -> branch -> presentation. */
export async function organizationBranding(orgId: string, branchId = "default") {
  const resolvedBranchId = cleanText(branchId) || "default";
  const [org, globalDoc, branch, style] = await Promise.all([
    readOrganization(orgId).catch(() => ({} as JsonObject)),
    readGlobal(orgId).catch(() => ({} as JsonObject)),
    readDocument(orgId, "branch", resolvedBranchId).catch(() => null),
    readBranchModule(orgId, resolvedBranchId, "presentation_style").catch(() => null)
  ]);
  const layers = [
    asObject(asObject(asObject(globalDoc).data).branding),
    asObject(asObject(org).branding),
    asObject(asObject(asObject(branch).data).branding),
    asObject(asObject(asObject(style).data).branding)
  ];
  let branding: JsonObject = { colors: {}, typography: {} };
  for (const layer of layers) {
    if (!Object.keys(layer).length) continue;
    branding = {
      ...branding,
      ...layer,
      colors: { ...asObject(branding.colors), ...asObject(layer.colors) },
      typography: { ...asObject(branding.typography), ...asObject(layer.typography) }
    };
  }

  // This older setting is still the saved company document-font choice.
  const styleData = asObject(asObject(style).data);
  const proposalDefaults = asObject(styleData.proposal_defaults);
  const documentFont = firstText(
    asObject(branding.typography).document_font_family,
    proposalDefaults.font_family,
    styleData.proposal_font_family,
    styleData.font_family
  );
  if (documentFont) branding.typography = { ...asObject(branding.typography), document_font_family: documentFont };
  return branding;
}

/**
 * Snapshot company defaults into a new theme. Literal values are deliberate:
 * later Company Settings changes do not enforce a rebrand on existing themes.
 */
export function applyOrganizationThemeDefaults(definition: JsonObject, brandingValue: JsonObject) {
  const definitionCopy = JSON.parse(JSON.stringify(asObject(definition))) as JsonObject;
  const branding = asObject(brandingValue);
  const brandColors = asObject(branding.colors);
  const savedPalette = Array.isArray(brandColors.palette)
    ? brandColors.palette.map(cleanText).filter(Boolean).slice(0, 6)
    : [];
  const primary = firstText(savedPalette[0], brandColors.primary, branding.primary, brandColors.accent, branding.accent);
  const secondary = firstText(savedPalette[1], brandColors.secondary, branding.secondary);
  // Doc Studio's two main theme controls intentionally mirror Company
  // Settings: Primary = company primary, Accent = company secondary.
  const accent = firstText(secondary, brandColors.accent, branding.accent, primary);

  const tokens = asObject(definitionCopy.tokens);
  const colors: JsonObject = { ...asObject(tokens.colors) };
  if (primary) colors.primary = primary;
  if (secondary) colors.secondary = secondary;
  if (accent) colors.accent = accent;
  savedPalette.forEach((color, index) => { colors[`palette_${index + 1}`] = color; });

  const typography = asObject(branding.typography);
  const sharedFont = firstText(typography.document_font_family, typography.font_family, typography.primary_font_family, branding.font_family);
  const displayFont = firstText(typography.display_font_family, typography.heading_font_family, typography.primary_font_family, sharedFont);
  const bodyFont = firstText(typography.body_font_family, typography.secondary_font_family, sharedFont);
  const fonts: JsonObject = { ...asObject(tokens.fonts) };
  if (displayFont) fonts.display = displayFont;
  if (bodyFont) fonts.body = bodyFont;

  definitionCopy.tokens = { ...tokens, colors, fonts };
  return definitionCopy;
}

export async function themeDefinitionWithOrganizationDefaults(orgId: string, definition: JsonObject, branchId = "default") {
  return applyOrganizationThemeDefaults(definition, await organizationBranding(orgId, branchId));
}

/** Repair only v1 themes produced by the short-lived palette[2] accent bug. */
export function repairIncorrectCompanyAccent(definition: JsonObject) {
  const copy = JSON.parse(JSON.stringify(asObject(definition))) as JsonObject;
  const tokens = asObject(copy.tokens);
  const colors = asObject(tokens.colors);
  const primary = cleanText(colors.primary);
  const secondary = cleanText(colors.secondary);
  const accent = cleanText(colors.accent);
  const palette1 = cleanText(colors.palette_1);
  const palette2 = cleanText(colors.palette_2);
  const palette3 = cleanText(colors.palette_3);
  if (!palette1 || !palette2 || !palette3 || primary !== palette1 || secondary !== palette2 || accent !== palette3 || palette2 === palette3) {
    return null;
  }
  copy.tokens = { ...tokens, colors: { ...colors, accent: palette2 } };
  return copy;
}
