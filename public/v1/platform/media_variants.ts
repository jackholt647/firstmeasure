type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};

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
