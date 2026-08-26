import { asObject, cleanText, numericValue } from "./util.js";

type Attrs = Record<string, string>;

function attrs(tag: string): Attrs {
  const output: Attrs = {};
  for (const match of tag.matchAll(/([A-Za-z_:][A-Za-z0-9_:.-]*)="([^"]*)"/g)) {
    output[match[1] as string] = decodeXml(match[2] ?? "");
  }
  return output;
}

function decodeXml(value: string) {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

export function parseRoofplanMeasurementXml(xml: string) {
  const locationTag = xml.match(/<LOCATION\b[^>]*\/?>/i)?.[0] ?? "";
  const location = attrs(locationTag);
  const pointsById = new Map<string, Record<string, unknown>>();
  const points = Array.from(xml.matchAll(/<POINT\b[^>]*\/?>/gi)).map((match) => {
    const attr = attrs(match[0]);
    const [x, y, z] = cleanText(attr.data).split(",").map((part) => numericValue(part, 0));
    const point = {
      id: cleanText(attr.id),
      x,
      y,
      z,
      raw: attr
    };
    if (point.id) pointsById.set(point.id, point);
    return point;
  });

  const lines = Array.from(xml.matchAll(/<LINE\b[^>]*\/?>/gi)).map((match) => {
    const attr = attrs(match[0]);
    const [start, end] = cleanText(attr.path).split(",").map((part) => part.trim());
    return {
      id: cleanText(attr.id),
      type: cleanText(attr.type),
      start_point_id: start || null,
      end_point_id: end || null,
      width: attr.width == null ? null : numericValue(attr.width, 0),
      height: attr.height == null ? null : numericValue(attr.height, 0),
      raw: attr
    };
  });

  const faces = Array.from(xml.matchAll(/<FACE\b[^>]*>[\s\S]*?<POLYGON\b[^>]*\/?>[\s\S]*?<\/FACE>|<FACE\b[^>]*\/?>/gi)).map((match) => {
    const faceAttr = attrs(match[0].match(/<FACE\b[^>]*>/i)?.[0] ?? match[0]);
    const polygonAttr = attrs(match[0].match(/<POLYGON\b[^>]*\/?>/i)?.[0] ?? "");
    return {
      id: cleanText(faceAttr.id),
      type: cleanText(faceAttr.type),
      polygon_id: cleanText(polygonAttr.id) || null,
      line_ids: cleanText(polygonAttr.path).split(",").map((part) => part.trim()).filter(Boolean),
      pitch: polygonAttr.pitch == null ? null : numericValue(polygonAttr.pitch, 0),
      area: polygonAttr.size == null ? null : numericValue(polygonAttr.size, 0),
      raw: {
        face: faceAttr,
        polygon: polygonAttr
      }
    };
  });

  const lineTotals = new Map<string, number>();
  for (const line of lines) {
    const key = line.type || "UNKNOWN";
    lineTotals.set(key, (lineTotals.get(key) ?? 0) + 1);
  }

  const totalArea = faces.reduce((sum, face) => sum + numericValue(face.area), 0);
  return {
    schema_version: 1,
    source_format: "roofplan",
    location: {
      address: cleanText(location.address),
      city: cleanText(location.city),
      state: cleanText(location.state),
      postal: cleanText(location.postal),
      lat: cleanText(location.lat) || null,
      lng: cleanText(location.long) || null,
      raw: location
    },
    summary: {
      point_count: points.length,
      line_count: lines.length,
      face_count: faces.length,
      total_roof_area: Math.round(totalArea * 100) / 100,
      line_counts_by_type: Object.fromEntries(lineTotals)
    },
    points,
    lines,
    faces,
    raw: asObject({})
  };
}

