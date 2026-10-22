/* The completed full-house model a customer viewer draws: the published exterior report geometry (metres) and its
   areas and lengths (feet), with editor material keys so the viewer applies the editor's own finishes. Nothing here
   reaches editor state, QA data or images; a report without exterior geometry yields null. */
type Obj = Record<string, unknown>;
type Point = [number, number, number];

const object = (value: unknown): Obj => (value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const number = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const text = (value: unknown, max = 80): string | null => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
const color = (value: unknown): string | null => (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null);

// exterior_report_model.js publishes labels; the viewer needs the editor keys ExteriorFinishes understands.
const MATERIAL_KEYS: Record<string, string> = {
  'Soffit': 'soffit', 'Horizontal siding': 'siding', 'Vertical siding': 'siding-vertical', 'Horizontal trim': 'trim-horizontal',
  'Vertical trim': 'trim-vertical', 'Brick': 'brick', 'Masonry': 'masonry', 'Stucco': 'stucco', 'Stone': 'stone', 'Other': 'other',
  'Unassigned': 'unassigned', 'Chimney top': 'chimney-top', 'Roof trim': 'trim-horizontal'
};
const ROOF_CATEGORIES = new Set(['shingles', 'shake', 'slate', 'metal']);
const OPENING_TYPES = new Set(['window', 'door', 'garage', 'garageDoor', 'garage-door', 'vent', 'gableVent', 'gable-vent']);
const EDGE_TYPES = new Set(['Top', 'Bottom', 'Termination', 'Inside corner', 'Outside corner', 'Seam', 'Material transition', 'Edge']);
const MAX_ITEMS = 5000;

function point(value: unknown): Point | null {
  const p = object(value), xyz = [number(p.x), number(p.y), number(p.z)];
  return xyz.every(v => v !== null) ? xyz.map(v => Math.round((v as number) * 10000) / 10000) as Point : null;
}
function ring(value: unknown): Point[] | null {
  const points = list(value).map(point);
  return points.length >= 3 && points.length <= MAX_ITEMS && points.every(Boolean) ? points as Point[] : null;
}
function rings(value: unknown): Point[][] { return list(value).map(ring).filter(Boolean) as Point[][]; }
function surface(value: unknown) {
  const face = object(value), points = ring(face.points);
  return points ? { points, holes: rings(face.holes) } : null;
}
function materialKey(face: Obj): string {
  const explicit = text(face.materialKey, 40);
  if (explicit) return explicit;
  return MATERIAL_KEYS[String(face.material || '')] || 'unassigned';
}
function feet(value: unknown): number { const n = number(value); return n === null ? 0 : Math.round(n * 1000) / 1000; }

export function exteriorModelProjection(reportValue: unknown, metadataValue: unknown = {}) {
  const report = object(reportValue);
  const walled = object(object(metadataValue).exteriorsWalls), defaults = object(walled.finishDefaults), roof = object(defaults.roof);
  // The report bakes each face's resolved color in. A color equal to the default it resolved from is not a choice:
  // drop it, so finishes that look different when uncolored (brick photo color) render as they do in the editor.
  const explicit = (value: unknown, materialKey: string) => {
    const c = color(value), fallback = materialKey === 'chimney-top' ? '#d4d0c8' : materialKey.startsWith('trim') ? (color(defaults.trimColor) || '#f5f3ef') : (color(defaults.color) || '#80868b');
    return c && c !== fallback ? c : null;
  };
  const walls = list(report.walls).slice(0, MAX_ITEMS).flatMap(value => {
    const wall = object(value), shape = surface(wall);
    if (!shape) return [];
    const openings = list(wall.openings).slice(0, MAX_ITEMS).flatMap(item => {
      const opening = object(item), points = ring(opening.points), type = String(opening.type || '');
      if (!points || !OPENING_TYPES.has(type)) return [];
      const trimFaces = list(opening.trimFaces).slice(0, 128).flatMap(value => {
        const face = object(value), ring = list(face.points).map(point);
        return ring.length >= 3 && ring.every(Boolean) ? [{ points: ring as Point[], stickerType: text(face.stickerType, 20) || type, ownColor: color(face.trimOwnColor) }] : [];
      });
      return [{ id: text(opening.id, 40) || '', type, label: text(opening.label) || type, points, area: feet(opening.area), perimeter: feet(opening.perimeter), width: feet(opening.width), height: feet(opening.height), trimFaces }];
    });
    return [{
      id: text(wall.id, 40) || '', ...shape, material: text(wall.material) || 'Unassigned', materialKey: materialKey(wall), finishColor: explicit(wall.finishColor, materialKey(wall)),
      elevation: text(wall.elevation, 12) || '', chimney: wall.chimney === true, curved: !!wall.curvedSurface,
      gross: feet(wall.gross), net: feet(wall.net), openingArea: feet(wall.openingArea), width: feet(wall.width), height: feet(wall.height), openings
    }];
  });
  if (!walls.length) return null;
  const edges = list(report.edges).slice(0, MAX_ITEMS * 4).flatMap(value => {
    const edge = object(value), a = point(edge.a), b = point(edge.b), type = String(edge.type || '');
    if (!a || !b || !EDGE_TYPES.has(type)) return [];
    return [{ a, b, type, length: feet(edge.length), walls: list(edge.walls).map(id => text(id, 40)).filter(Boolean) }];
  });
  const finishes = (values: unknown) => list(values).slice(0, MAX_ITEMS).flatMap(value => {
    const face = object(value), shape = surface(face);
    return shape ? [{ ...shape, materialKey: materialKey(face), finishColor: explicit(face.finishColor, materialKey(face)) }] : [];
  });
  // The editor's own roof graph: ridge and hip caps, skylights and fascia are drawn from it exactly as the editor does.
  const source = object(walled.roof), sourcePoints = list(source.points).slice(0, MAX_ITEMS).map(point);
  const sourceRoof = sourcePoints.length && sourcePoints.every(Boolean) ? {
    points: sourcePoints as Point[],
    connections: list(source.connections).slice(0, MAX_ITEMS * 2).flatMap(value => {
      const c = object(value), start = number(c.startIdx), end = number(c.endIdx), type = text(object(c.type).id ?? c.type, 40);
      return start !== null && end !== null && start < sourcePoints.length && end < sourcePoints.length && type ? [{ startIdx: start, endIdx: end, type }] : [];
    })
  } : null;
  const trimEdges = Object.fromEntries(Object.entries(object(object(walled.roofTrim).edges)).slice(0, MAX_ITEMS)
    .flatMap(([key, value]) => { const height = number(object(value).height); return key.length <= 200 && height !== null ? [[key, { height }]] : []; }));
  const category = ROOF_CATEGORIES.has(String(roof.category)) ? String(roof.category) : null;
  const totals = Object.fromEntries(Object.entries(object(report.totals)).filter(([, v]) => number(v) !== null).map(([k, v]) => [k, feet(v)]));
  return {
    version: 1, units: { points: 'm', lengths: 'ft', areas: 'ft2' },
    walls, edges,
    base: list(report.base).map(surface).filter(Boolean),
    roof: list(report.roof).map(surface).filter(Boolean),
    roofTrim: finishes(report.roofTrim), caps: finishes(report.caps), returns: finishes(report.returns),
    reportHasTrim: Array.isArray(report.roofTrim), sourceRoof, roofTrimSettings: { edges: trimEdges },
    roofFinish: category ? { category, color: color(roof.color) } : null,
    defaults: { material: text(defaults.material, 40), color: color(defaults.color), trimColor: color(defaults.trimColor) },
    // The editor's finish defaults as ExteriorFinishes and ExteriorRendered read them (WallMode.finishDefaults).
    finishDefaults: {
      ...(text(defaults.material, 40) ? { material: text(defaults.material, 40) } : {}),
      ...(color(defaults.color) ? { color: color(defaults.color) } : {}),
      ...(color(defaults.trimColor) ? { trimColor: color(defaults.trimColor) } : {}),
      ...(category ? { roof: { category, ...(color(roof.color) ? { color: color(roof.color) } : {}) } } : {}),
      stickers: Object.fromEntries(Object.entries(object(defaults.stickers)).slice(0, 20).flatMap(([key, value]) => key.length <= 40 && color(value) ? [[key, color(value)]] : []))
    },
    totals
  };
}
