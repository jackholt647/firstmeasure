/* A customer's projected exterior design for a completed full-house report: the finish choices they are trying
   (wall material and colors, roof covering, trim and sticker colors) as a layer over the report's as-built finishes,
   with per-face overrides. It is presentation only: it never changes the report, its measurements or the editor. */
type Obj = Record<string, unknown>;

const object = (value: unknown): Obj => (value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {});
const color = (value: unknown): string | null => (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null);

// The editor's wall finishes (window.ExteriorMaterials) a customer may choose, and its roof coverings.
export const WALL_MATERIALS = ['unassigned', 'siding', 'siding-vertical', 'brick', 'masonry', 'stucco', 'stone', 'other'] as const;
export const ROOF_CATEGORIES = ['shingles', 'shake', 'slate', 'metal'] as const;
// ExteriorFinishes.stickerPieces ids.
export const STICKER_PIECES = ['doorTrim', 'doorMain', 'windowTrim', 'garageTrim', 'garageMain', 'untypedTrim', 'untypedMain'] as const;
const MAX_FACES = 2000;
const KEY = /^[A-Za-z0-9:|._-]{1,400}$/;

function defaults(value: unknown) {
  const d = object(value), roof = object(d.roof), stickers = object(d.stickers);
  const out: Obj = {};
  if ((WALL_MATERIALS as readonly string[]).includes(String(d.material))) out.material = String(d.material);
  if (color(d.color)) out.color = color(d.color);
  if (color(d.trimColor)) out.trimColor = color(d.trimColor);
  if ((ROOF_CATEGORIES as readonly string[]).includes(String(roof.category))) out.roof = { category: String(roof.category), ...(color(roof.color) ? { color: color(roof.color) } : {}) };
  const pieces = Object.fromEntries(STICKER_PIECES.flatMap(id => (color(stickers[id]) ? [[id, color(stickers[id])]] : [])));
  if (Object.keys(pieces).length) out.stickers = pieces;
  return out;
}

function overrides(value: unknown, fields: (entry: Obj) => Obj) {
  return Object.fromEntries(Object.entries(object(value)).slice(0, MAX_FACES).flatMap(([key, entry]) => {
    if (!KEY.test(key)) return [];
    const clean = fields(object(entry));
    return Object.keys(clean).length ? [[key, clean]] : [];
  }));
}

export function sanitizeExteriorDesign(value: unknown) {
  const design = object(value);
  return {
    version: 1,
    mode: design.mode === 'projected' ? 'projected' : 'built',
    defaults: defaults(design.defaults),
    // Walls by their report key: a material and/or a color.
    walls: overrides(design.walls, entry => ({
      ...((WALL_MATERIALS as readonly string[]).includes(String(entry.material)) ? { material: String(entry.material) } : {}),
      ...(color(entry.color) ? { color: color(entry.color) } : {})
    })),
    // Openings by their outline key: the main (door/garage) color and the trim color.
    openings: overrides(design.openings, entry => ({
      ...(color(entry.color) ? { color: color(entry.color) } : {}),
      ...(color(entry.trimColor) ? { trimColor: color(entry.trimColor) } : {})
    })),
    source: typeof design.source === 'string' ? design.source.slice(0, 200) : null,
    updatedAt: new Date().toISOString()
  };
}

export const EXTERIOR_DESIGN_ARTIFACT = 'exterior-design.json';
