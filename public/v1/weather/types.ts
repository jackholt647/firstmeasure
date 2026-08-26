import type { WeatherTier } from "./schemas.js";

export type GeoPoint = {
  lat: number;
  lon: number;
  address?: string | null;
  matched_address?: string | null;
};

export type WeatherSource = {
  id: string;
  name: string;
  url: string;
  accessed_at: string;
  status: "ok" | "partial" | "error" | "skipped";
  record_count?: number;
  error?: string;
};

export type WeatherRecord = {
  source: string;
  dataset: string;
  observed_at?: string | null;
  event_type?: string | null;
  magnitude?: number | null;
  magnitude_unit?: string | null;
  lat?: number | null;
  lon?: number | null;
  distance_miles?: number | null;
  raw: Record<string, string>;
};

export type WeatherFinding = {
  date: string;
  event_type: string;
  max_magnitude: number | null;
  magnitude_unit: string | null;
  record_count: number;
  nearest_distance_miles: number | null;
  confidence: "low" | "medium" | "high";
  basis: string[];
};

export type WeatherEventSummary = {
  id: string;
  date: string;
  event_type: "hail" | "wind" | "tornado" | "weather";
  start_at: string | null;
  end_at: string | null;
  duration_minutes: number | null;
  max_magnitude: number | null;
  magnitude_unit: string | null;
  nearest_distance_miles: number | null;
  record_count: number;
  sources: string[];
  basis: string[];
};

export type WeatherModeledHistoryEvent = {
  date: string;
  event_type: "Hail" | "Wind" | "Tornado" | "Weather";
  duration_minutes: number | null;
  magnitude: number | null;
  magnitude_unit: string | null;
  basis: string[];
};

export type WeatherStormArea = {
  id: string;
  date: string;
  event_type: string;
  area_type: "warning_polygon" | "mrms_mesh_contour" | "estimated_swath" | "point_buffer";
  source: string;
  dataset: string;
  magnitude: number | null;
  magnitude_unit: string | null;
  record_count: number;
  contains_property: boolean | null;
  nearest_distance_miles: number | null;
  confidence: "low" | "medium" | "high";
  basis: string[];
  coordinates: GeoPoint[];
};

export type WeatherSolarPreview = {
  status: string;
  source?: string | null;
  image?: string | null;
  mask?: string | null;
  formatted_address?: string | null;
  imagery_quality?: string | null;
  imagery_date?: Record<string, unknown> | null;
  error?: string | null;
};

export type WeatherReport = {
  id: string;
  tier: WeatherTier;
  generated_at: string;
  property: GeoPoint;
  request: Record<string, unknown>;
  sources: WeatherSource[];
  records: WeatherRecord[];
  findings: WeatherFinding[];
  storm_events?: WeatherEventSummary[];
  modeled_history_events?: WeatherModeledHistoryEvent[];
  storm_areas?: WeatherStormArea[];
  solar_preview?: WeatherSolarPreview | null;
  summary: {
    headline: string;
    narrative: string;
    limitations: string[];
  };
  artifacts: {
    nexrad_level2?: Array<{ label: string; url: string }>;
    mrms?: Array<{ label: string; url: string }>;
    iem?: Array<{ label: string; url: string }>;
  };
};
