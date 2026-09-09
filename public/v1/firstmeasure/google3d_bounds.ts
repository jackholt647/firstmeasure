export type EcefPoint = { x: number; y: number; z: number };

/** The capture radius is a ground footprint, not a sphere at ellipsoid height 0. */
export function google3dFootprint(lat: number, lon: number, origin: EcefPoint) {
  const phi = lat * Math.PI / 180;
  const lambda = lon * Math.PI / 180;
  const up = { x: Math.cos(phi) * Math.cos(lambda), y: Math.cos(phi) * Math.sin(lambda), z: Math.sin(phi) };
  return { origin, up };
}

export type Google3dFootprint = ReturnType<typeof google3dFootprint>;

export function google3dBoxFootprintDistance(box: number[], footprint: Google3dFootprint) {
  const { origin, up } = footprint;
  const [x = 0, y = 0, z = 0] = box;
  const dx = x - origin.x, dy = y - origin.y, dz = z - origin.z;
  const height = dx * up.x + dy * up.y + dz * up.z;
  return Math.hypot(dx - height * up.x, dy - height * up.y, dz - height * up.z);
}

export function google3dBoxIntersectsFootprint(box: number[], footprint: Google3dFootprint, radius: number) {
  // A conservative enclosing sphere handles arbitrary box orientation. Ignore
  // height when testing the footprint, but never select the opposite hemisphere.
  if (box.length !== 12 || box.some(value => !Number.isFinite(value))) return true;
  const [x = 0, y = 0, z = 0] = box;
  const r = Math.hypot(...box.slice(3, 6)) + Math.hypot(...box.slice(6, 9)) + Math.hypot(...box.slice(9, 12));
  const { up } = footprint;
  if (x * up.x + y * up.y + z * up.z + r < 0) return false;
  return google3dBoxFootprintDistance(box, footprint) <= r + radius;
}
