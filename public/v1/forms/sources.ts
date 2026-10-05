import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "../src/config/env.js";
import type { JsonObject } from "../platform/storage.js";
import { measureSolarRoof, previewSolarProperty } from "./solar.js";

/**
 * Measurement sources turn something the visitor enters (today: an address)
 * into typed quantities a calculation can price. A property_measurement block
 * names one source; its values land in the answers under the block's key.
 * Provider credentials never leave the server.
 */

export type MeasurementFact = { label: string; value: string };
export type MeasurementResult = {
  ok: boolean;
  /** Numeric and categorical values exposed to the calculation. */
  values: JsonObject;
  /** Human-readable summary shown to the visitor. */
  facts: MeasurementFact[];
  formatted_address?: string;
  preview?: { image: string; mask: string };
  message?: string;
};
export type MeasurementSource = {
  id: string;
  label: string;
  description: string;
  industry?: string;
  /** Answer paths this source provides, for the pricing editor. */
  fields: Array<{ key: string; label: string; unit?: string; type: "number" | "category"; values?: string[] }>;
  measure: (input: { address: string; tint?: string; preview?: boolean }) => Promise<MeasurementResult>;
};

const sources = new Map<string, MeasurementSource>();

export function registerMeasurementSource(source: MeasurementSource) {
  if (!/^[a-z][a-z0-9_]{0,59}$/.test(source.id)) throw new Error(`Measurement source id '${source.id}' must be lowercase snake_case.`);
  sources.set(source.id, source);
}

export function measurementSource(id: string) {
  return sources.get(id) || null;
}

export function listMeasurementSources() {
  return [...sources.values()].map(({ measure: _measure, ...source }) => source);
}

const obj = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const str = (value: unknown) => String(value ?? "").trim();

function roofResult(measurement: JsonObject, extra: Partial<MeasurementResult> = {}): MeasurementResult {
  const area = Number(measurement.roof_area_sqft) || 0;
  const pitch = str(measurement.pitch_category);
  const flatPercent = Number(measurement.flat_roof_percent) || 0;
  if (!area) {
    return { ok: false, values: { status: "unavailable" }, facts: [], message: "We could not measure this roof from imagery. We will confirm measurements with you.", ...extra };
  }
  return {
    ok: true,
    values: {
      status: "measured",
      source: "google_solar",
      roof_area_sqft: area,
      pitch_category: pitch,
      predominant_pitch_degrees: Number(measurement.predominant_pitch_degrees) || 0,
      flat_roof_percent: flatPercent
    },
    facts: [
      { label: "Roof area", value: `${area.toLocaleString("en-US")} sq ft` },
      { label: "Steepness", value: pitch || "To be verified" },
      { label: "Flat roof", value: flatPercent > 0 ? `${flatPercent}%` : "None detected" }
    ],
    ...extra
  };
}

registerMeasurementSource({
  id: "solar_roof",
  label: "Roof from satellite imagery",
  description: "Measures roof area and steepness at the entered address.",
  industry: "roofing",
  fields: [
    { key: "roof_area_sqft", label: "Roof area", unit: "sq ft", type: "number" },
    { key: "pitch_category", label: "Roof steepness", type: "category", values: ["Flat", "Low", "Moderate", "Steep"] },
    { key: "flat_roof_percent", label: "Flat roof share", unit: "%", type: "number" }
  ],
  measure: async ({ address, tint, preview }) => {
    if (preview) {
      const rendered = obj(await previewSolarProperty({ address, tint }));
      const extra = {
        formatted_address: str(rendered.formatted_address) || address,
        ...(rendered.ok === true && str(rendered.image) ? { preview: { image: str(rendered.image), mask: str(rendered.mask) } } : {})
      };
      if (rendered.ok === true && rendered.measurement) return roofResult(obj(rendered.measurement), extra);
      // The imagery layer can fail where building insights still succeed.
      const measured = obj(await measureSolarRoof({ address }));
      return roofResult(measured.ok === true ? measured : {}, extra);
    }
    const measured = obj(await measureSolarRoof({ address }));
    return roofResult(measured.ok === true ? measured : {}, { formatted_address: str(measured.formatted_address) || address });
  }
});

// A measurement shown to the visitor is signed so the submission prices the
// same values without calling the provider a second time.
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const sign = (payload: string) => createHmac("sha256", env.platformSessionSecret).update(`form-measurement:${payload}`).digest("base64url");

export function signMeasurement(formId: string, itemId: string, address: string, values: JsonObject) {
  const payload = Buffer.from(JSON.stringify({ f: formId, i: itemId, a: address.toLowerCase(), v: values, t: Date.now() })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifyMeasurement(token: unknown, formId: string, itemId: string, address: string): JsonObject | null {
  const [payload, signature] = str(token).split(".");
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const data = obj(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    if (data.f !== formId || data.i !== itemId || data.a !== address.toLowerCase()) return null;
    if (Date.now() - Number(data.t) > TOKEN_TTL_MS) return null;
    return obj(data.v);
  } catch {
    return null;
  }
}
