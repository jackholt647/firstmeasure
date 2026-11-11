import { createHash } from "node:crypto";

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

const KEEP_FOREVER = "private, max-age=31536000, immutable";
const REVALIDATE = "private, no-cache";

/** The id a slot upload (`replace_slot`: a logo, an avatar) gets: the slot, so the next upload replaces it. */
function slotMediaId(owner: JsonObject) {
  return `${String(owner.type ?? "")}_${String(owner.id ?? "")}_${String(owner.slot ?? "")}`.trim().toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/**
 * How a browser may keep one variant of a media file (docs/architecture/offline.md#saved-reads).
 * Always `private`: the file was read with a session.
 *
 * `etag` changes whenever the bytes the variant serves can have changed: a new upload under
 * the same id (a new `created_at`) or a markup thumbnail rendered again (a new revision). It
 * does not change when the record is only renamed or tagged.
 *
 * Kept for a year without asking again only where the URL can never mean other bytes:
 * - a rendition (`thumb_320`, `display_2400`): made once, at upload, and never rewritten;
 * - a markup thumbnail whose URL names the revision it shows (`&v=<markup revision>`).
 * Asked about every time (a 304 when nothing changed):
 * - the original, because a later upload under the same id replaces it;
 * - any variant of a slot record, whose id is the slot and is replaced by design;
 * - a markup thumbnail without its revision in the URL, or with another value there.
 * Null when the record has no such variant.
 */
export function mediaFileCaching(metadataValue: unknown, requestedVariant: string, urlRevision = ""): { etag: string; cacheControl: string } | null {
  const metadata = asObject(metadataValue);
  const variant = requestedVariant || "original";
  const entry = mediaVariantEntry(metadata, variant);
  if (!Object.keys(entry).length) return null;
  const stamp = [metadata.id, variant, entry.path, entry.size_bytes, entry.markup_revision, entry.updated_at, metadata.created_at, metadata.size_bytes, metadata.content_type]
    .map((value) => String(value ?? "")).join("|");
  const etag = `"${createHash("sha256").update(stamp).digest("base64url").slice(0, 22)}"`;
  if (variant === "original") return { etag, cacheControl: REVALIDATE };
  if (String(metadata.id ?? "") === slotMediaId(asObject(metadata.owner))) return { etag, cacheControl: REVALIDATE };
  if (/^thumb_\d+_markup$/.test(variant)) {
    const revision = entry.markup_revision === undefined || entry.markup_revision === null ? "" : String(entry.markup_revision);
    return { etag, cacheControl: revision !== "" && urlRevision === revision ? KEEP_FOREVER : REVALIDATE };
  }
  return { etag, cacheControl: KEEP_FOREVER };
}
