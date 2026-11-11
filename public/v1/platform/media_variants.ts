type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};

/**
 * An encoder quality from 1 to 100. Browser code sends the canvas scale
 * (`quality: 0.88`), so a value of 1 or less is a fraction of 100; read as a
 * percentage it would round to 1 and be raised to the lowest quality allowed.
 */
export function mediaQuality(value: unknown, fallback: number, min: number, max: number) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const percent = parsed > 0 && parsed <= 1 ? parsed * 100 : parsed;
  return Math.max(min, Math.min(max, Math.round(percent)));
}

/**
 * The stored rendition that serves a requested variant. Thumbnails are only
 * rendered for large images, so a thumbnail request for a smaller image (or a
 * GIF, which is never resized) serves the original, which is already small.
 * "display" serves the original when no screen-sized copy exists, and a
 * markup thumbnail falls back to the plain thumbnail. Anything else must exist.
 */
export function mediaVariantEntry(metadataValue: unknown, variant: string): JsonObject {
  const metadata = asObject(metadataValue);
  const variants = asObject(metadata.variants);
  const requested = asObject(variants[variant]);
  if (Object.keys(requested).length) return requested;
  const original = asObject(variants.original);
  const markupSize = variant.match(/^thumb_(\d+)_markup$/)?.[1] || "";
  if (markupSize) return asObject(variants[`thumb_${markupSize}`] || variants.original);
  if (variant === "display") return original;
  if (/^thumb_\d+$/.test(variant)) {
    const contentType = String(original.content_type || metadata.content_type || "").toLowerCase();
    if (contentType.startsWith("image/")) return original;
  }
  return {};
}
