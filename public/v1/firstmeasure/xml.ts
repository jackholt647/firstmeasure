import { FIRSTMEASURE_FILE_NAMES } from "./constants.js";
import { badRequest } from "./errors.js";
import type { ProjectManifest } from "./storage.js";

export const XML_EXPORT_FORMATS = [
  "roofplan",
  "esx",
  "applicad",
  "firstmeasure"
] as const;

export type XmlExportFormat = (typeof XML_EXPORT_FORMATS)[number];
export type XmlExportImplementation = XmlExportFormat;
export type XmlExportPayloadSource = "stored" | "transformed" | "generated";

type XmlExportResolution = {
  requestedFormat: XmlExportFormat;
  resolvedFormat: XmlExportImplementation;
  defaulted: boolean;
};

type XmlExportPayload = {
  content: string;
  contentType: string;
  fileName: string;
  payloadSource: XmlExportPayloadSource;
};

type RoofplanLocation = {
  address: string;
  city: string;
  state: string;
  postal: string;
  lat: string;
  long: string;
};

type RoofplanPoint = {
  id: string;
  x: number;
  y: number;
  z: number;
  index: number;
};

type RoofplanLine = {
  id: string;
  startId: string;
  endId: string;
  type: string;
  width: number | null;
  height: number | null;
  index: number;
};

type RoofplanFace = {
  id: string;
  polygonId: string;
  pathLineIds: string[];
  pitch: number | null;
  size: number | null;
  index: number;
};

type RoofplanModel = {
  location: RoofplanLocation;
  points: RoofplanPoint[];
  lines: RoofplanLine[];
  faces: RoofplanFace[];
};

type NormalizedPoint = RoofplanPoint & {
  xNorm: number;
  yNorm: number;
  zNorm: number;
  xMm: number;
  yMm: number;
  zMm: number;
};

type NormalizedGeometry = {
  points: NormalizedPoint[];
  pointIndexById: Map<string, number>;
  lineIndexById: Map<string, number>;
};

const XML_EXPORT_FORMAT_ALIAS_MAP: Record<string, XmlExportFormat> = {
  roofplan: "roofplan",
  "roof-plan": "roofplan",
  roof_plan: "roofplan",
  "roof plan": "roofplan",
  xml: "roofplan",
  roofplanxml: "roofplan",
  "roofplan-xml": "roofplan",
  roofplan_xml: "roofplan",
  "roofplan xml": "roofplan",
  "roof plan xml": "roofplan",
  symbility: "roofplan",
  cotality: "roofplan",
  hover: "roofplan",
  esx: "esx",
  "esx xml": "esx",
  xactimate: "esx",
  "xactimate esx": "esx",
  xactware: "esx",
  applicad: "applicad",
  "applicad xml": "applicad",
  "appli-cad": "applicad",
  "appli cad": "applicad",
  rxf: "applicad",
  firstmeasure: "firstmeasure",
  "first-measure": "firstmeasure",
  first_measure: "firstmeasure",
  custom: "firstmeasure",
  internal: "firstmeasure",
  legacy: "firstmeasure"
};

export function resolveXmlExportFormat(value: unknown): XmlExportResolution {
  const normalized = normalizeXmlExportFormatKey(value);
  const requestedFormat = XML_EXPORT_FORMAT_ALIAS_MAP[normalized] ?? "roofplan";
  return {
    requestedFormat,
    resolvedFormat: requestedFormat,
    defaulted: normalized.length === 0 || !(normalized in XML_EXPORT_FORMAT_ALIAS_MAP)
  };
}

export function buildXmlExportPayload(input: {
  format: XmlExportFormat;
  manifest: ProjectManifest;
  storedRoofplanXml?: string | null;
  options?: Record<string, unknown>;
}): XmlExportPayload {
  const storedRoofplanXml = input.storedRoofplanXml ?? null;

  if (input.format === "roofplan") {
    return {
      content: requireStoredRoofplanXml(storedRoofplanXml),
      contentType: "application/xml; charset=utf-8",
      fileName: FIRSTMEASURE_FILE_NAMES.xmlStored,
      payloadSource: "stored"
    };
  }

  if (input.format === "firstmeasure") {
    return {
      content: assembleProjectXml(input.manifest, {
        format: input.format,
        options: input.options
      }),
      contentType: "application/xml; charset=utf-8",
      fileName: FIRSTMEASURE_FILE_NAMES.xmlGenerated,
      payloadSource: "generated"
    };
  }

  const model = parseRoofplanXml(requireStoredRoofplanXml(storedRoofplanXml));

  if (input.format === "applicad") {
    return {
      content: serializeApplicadRxf(model, input.manifest),
      contentType: "text/plain; charset=utf-8",
      fileName: "model_data.rxf",
      payloadSource: "transformed"
    };
  }

  return {
    content: serializeEsx(model, input.manifest),
    contentType: "application/xml; charset=utf-8",
    fileName: "model_data.esx",
    payloadSource: "transformed"
  };
}

export function assembleProjectXml(
  manifest: ProjectManifest,
  input: {
    format?: string;
    options?: Record<string, unknown>;
  }
) {
  const options = input.options ?? {};
  const includeGutters = options.include_gutters !== false && options.include_gutter_measurements !== false;
  const includeMeasurements = options.include_measurements !== false;

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<firstmeasure-project id="${escapeXml(manifest.id)}" format="${escapeXml(input.format ?? "model_data")}">`,
    `  <address>${escapeXml(manifest.address)}</address>`,
    `  <status>${escapeXml(String(manifest.status))}</status>`,
    `  <projectType>${escapeXml(String(manifest.project_type))}</projectType>`,
    `  <coordinates lat="${escapeXml(String(manifest.lat ?? ""))}" lng="${escapeXml(String(manifest.lng ?? ""))}" />`,
    `  <storedFile>${FIRSTMEASURE_FILE_NAMES.xmlStored}</storedFile>`,
    includeMeasurements ? `  <measurements enabled="true" />` : `  <measurements enabled="false" />`,
    `  <gutterMeasurementsRequested enabled="${escapeXml(String(includeGutters && manifest.include_gutter_measurements))}" />`,
    `</firstmeasure-project>`
  ].join("\n");
}

function requireStoredRoofplanXml(value: string | null) {
  if (value && value.trim()) return value;
  throw badRequest(
    "missing_stored_roofplan_xml",
    "A stored Roofplan XML document is required before this export can be generated."
  );
}

function serializeEsx(model: RoofplanModel, manifest: ProjectManifest) {
  const geometry = normalizeGeometry(model);
  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<ESX version="1.0" generator="FirstMeasure">`,
    `  <PROJECT id="${escapeXml(manifest.id)}" address="${escapeXml(model.location.address || manifest.address)}" city="${escapeXml(model.location.city)}" state="${escapeXml(model.location.state)}" postal="${escapeXml(model.location.postal)}" lat="${escapeXml(model.location.lat || String(manifest.lat ?? ""))}" long="${escapeXml(model.location.long || String(manifest.lng ?? ""))}" projectType="${escapeXml(String(manifest.project_type))}" gutters="${escapeXml(String(Boolean(manifest.include_gutter_measurements)))}">`,
    `    <POINTS>`
  ];

  for (const point of geometry.points) {
    lines.push(
      `      <POINT index="${point.index}" id="${escapeXml(point.id)}" x="${formatNumber(point.xNorm)}" y="${formatNumber(point.yNorm)}" z="${formatNumber(point.zNorm)}" units="ft" />`
    );
  }

  lines.push(`    </POINTS>`);
  lines.push(`    <LINES>`);
  for (const line of model.lines) {
    const startIndex = geometry.pointIndexById.get(line.startId) ?? 0;
    const endIndex = geometry.pointIndexById.get(line.endId) ?? 0;
    lines.push(
      `      <LINE index="${line.index}" id="${escapeXml(line.id)}" start="${startIndex}" end="${endIndex}" type="${escapeXml(line.type)}" width="${escapeXml(String(line.width ?? ""))}" height="${escapeXml(String(line.height ?? ""))}" />`
    );
  }
  lines.push(`    </LINES>`);
  lines.push(`    <SURFACES>`);
  for (const face of model.faces) {
    const lineIndexes = face.pathLineIds
      .map((lineId) => geometry.lineIndexById.get(lineId))
      .filter((value): value is number => typeof value === "number");
    lines.push(
      `      <SURFACE index="${face.index}" id="${escapeXml(face.id)}" polygon="${escapeXml(face.polygonId)}" pitch="${escapeXml(String(face.pitch ?? ""))}" area="${escapeXml(String(face.size ?? ""))}" line_indexes="${escapeXml(lineIndexes.join(","))}" />`
    );
  }
  lines.push(`    </SURFACES>`);
  lines.push(`  </PROJECT>`);
  lines.push(`</ESX>`);
  return lines.join("\n");
}

function serializeApplicadRxf(model: RoofplanModel, manifest: ProjectManifest) {
  const geometry = normalizeGeometry(model);
  const rows: string[] = [
    `#RXF File - Exported from FirstMeasure`,
    `#Project ${manifest.id} ${sanitizeCommentText(model.location.address || manifest.address)}`,
    `#All coordinates are normalized to the local model origin and converted from feet to millimeters`
  ];

  for (const point of geometry.points) {
    rows.push(`P ${formatNumber(point.xMm)} ${formatNumber(point.yMm)} ${formatNumber(point.zMm)}`);
  }

  for (const line of model.lines) {
    const startIndex = geometry.pointIndexById.get(line.startId) ?? 0;
    const endIndex = geometry.pointIndexById.get(line.endId) ?? 0;
    rows.push(`L ${startIndex} ${endIndex} 1 ${mapApplicadLineType(line.type, manifest.include_gutter_measurements)}`);
  }

  for (const face of model.faces) {
    const lineIndexes = face.pathLineIds
      .map((lineId) => geometry.lineIndexById.get(lineId))
      .filter((value): value is number => typeof value === "number");
    if (lineIndexes.length < 3) continue;
    rows.push(`S ${lineIndexes.length} ${lineIndexes.join(" ")} 1 NONE`);
  }

  return rows.join("\n");
}

function parseRoofplanXml(xml: string): RoofplanModel {
  const location = parseLocation(xml);
  const roofMatches = Array.from(xml.matchAll(/<ROOF\b[^>]*>([\s\S]*?)<\/ROOF>/gi));
  const points: RoofplanPoint[] = [];
  const lines: RoofplanLine[] = [];
  const faces: RoofplanFace[] = [];

  for (const roofMatch of roofMatches) {
    const roofBody = roofMatch[1] ?? "";

    for (const pointMatch of roofBody.matchAll(/<POINT\b([^>]*)\/?>/gi)) {
      const attrs = parseXmlAttributes(pointMatch[1] ?? "");
      const coords = String(attrs.data ?? "")
        .split(",")
        .map((value) => Number.parseFloat(String(value).trim()));
      if (coords.length < 3 || coords.some((value) => Number.isNaN(value))) continue;
      const [x, y, z] = coords as [number, number, number];
      points.push({
        id: String(attrs.id ?? `P${points.length + 1}`),
        x,
        y,
        z,
        index: points.length + 1
      });
    }

    for (const lineMatch of roofBody.matchAll(/<LINE\b([^>]*)\/?>/gi)) {
      const attrs = parseXmlAttributes(lineMatch[1] ?? "");
      const pointIds = String(attrs.path ?? "")
        .split(",")
        .map((value) => String(value).trim())
        .filter(Boolean);
      if (pointIds.length < 2) continue;
      const [startId, endId] = pointIds as [string, string];
      lines.push({
        id: String(attrs.id ?? `L${lines.length + 1}`),
        startId,
        endId,
        type: String(attrs.type ?? "NONE").trim().toUpperCase(),
        width: parseNumberOrNull(attrs.width),
        height: parseNumberOrNull(attrs.height),
        index: lines.length + 1
      });
    }

    for (const faceMatch of roofBody.matchAll(/<FACE\b([^>]*)>([\s\S]*?)<\/FACE>/gi)) {
      const faceAttrs = parseXmlAttributes(faceMatch[1] ?? "");
      const polygonMatch = /<POLYGON\b([^>]*)\/?>/i.exec(faceMatch[2] ?? "");
      if (!polygonMatch) continue;
      const polygonAttrs = parseXmlAttributes(polygonMatch[1] ?? "");
      const pathLineIds = String(polygonAttrs.path ?? "")
        .split(",")
        .map((value) => String(value).trim())
        .filter(Boolean);
      faces.push({
        id: String(faceAttrs.id ?? `F${faces.length + 1}`),
        polygonId: String(polygonAttrs.id ?? `P${faces.length + 1}`),
        pathLineIds,
        pitch: parseNumberOrNull(polygonAttrs.pitch),
        size: parseNumberOrNull(polygonAttrs.size),
        index: faces.length + 1
      });
    }
  }

  if (points.length === 0 || lines.length === 0 || faces.length === 0) {
    throw badRequest(
      "invalid_roofplan_xml",
      "Stored Roofplan XML is missing points, lines, or faces required for export."
    );
  }

  return { location, points, lines, faces };
}

function parseLocation(xml: string): RoofplanLocation {
  const match = /<LOCATION\b([^>]*)\/?>/i.exec(xml);
  const attrs = parseXmlAttributes(match?.[1] ?? "");
  return {
    address: String(attrs.address ?? ""),
    city: String(attrs.city ?? ""),
    state: String(attrs.state ?? ""),
    postal: String(attrs.postal ?? ""),
    lat: String(attrs.lat ?? ""),
    long: String(attrs.long ?? "")
  };
}

function normalizeGeometry(model: RoofplanModel): NormalizedGeometry {
  const minX = Math.min(...model.points.map((point) => point.x));
  const minY = Math.min(...model.points.map((point) => point.y));
  const minZ = Math.min(...model.points.map((point) => point.z));
  const points = model.points.map((point) => {
    const xNorm = point.x - minX;
    const yNorm = point.y - minY;
    const zNorm = point.z - minZ;
    return {
      ...point,
      xNorm,
      yNorm,
      zNorm,
      xMm: feetToMillimeters(xNorm),
      yMm: feetToMillimeters(yNorm),
      zMm: feetToMillimeters(zNorm)
    };
  });
  return {
    points,
    pointIndexById: new Map(points.map((point) => [point.id, point.index])),
    lineIndexById: new Map(model.lines.map((line) => [line.id, line.index]))
  };
}

function mapApplicadLineType(type: string, includeGutters: boolean) {
  switch (String(type).trim().toUpperCase()) {
    case "EAVE":
      return includeGutters ? "FASCIA" : "FASCIA-ONLY";
    case "RAKE":
      return "GABLE";
    case "HIP":
      return "HIP";
    case "RIDGE":
      return "RIDGE";
    case "VALLEY":
      return "VALLEY";
    case "STEPFLASH":
      return "STEP";
    case "SIDE_WALL":
    case "END_WALL":
    case "HEAD_WALL":
    case "WALL":
      return "WALL-TOP";
    default:
      return "NONE";
  }
}

function parseXmlAttributes(source: string) {
  const attrs: Record<string, string> = {};
  for (const match of source.matchAll(/([A-Za-z0-9_:-]+)="([^"]*)"/g)) {
    const key = match[1];
    const value = match[2];
    if (!key || value == null) continue;
    attrs[key] = unescapeXml(value);
  }
  return attrs;
}

function parseNumberOrNull(value: unknown) {
  const num = Number.parseFloat(String(value ?? "").trim());
  return Number.isFinite(num) ? num : null;
}

function feetToMillimeters(value: number) {
  return value * 304.8;
}

function formatNumber(value: number) {
  if (!Number.isFinite(value)) return "0.000000";
  return value.toFixed(6);
}

function sanitizeCommentText(value: string) {
  return value.replace(/\s+/g, " ").trim().replace(/#/g, "");
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function unescapeXml(value: string) {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function normalizeXmlExportFormatKey(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\/]+/g, " ");
}
