export type CodeReportSourceStatus = "ok" | "unavailable" | "not_applicable";

export type CodeReportSource = {
  id: string;
  name: string;
  url: string;
  status: CodeReportSourceStatus;
  note?: string;
  retrieved_at?: string;
};

export type CodeReportProperty = {
  input_address?: string | null;
  matched_address?: string | null;
  lat: number;
  lon: number;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  county?: string | null;
  county_geoid?: string | null;
  place?: string | null;
  census_tract?: string | null;
};

export type CodeReportDesignValues = {
  reference_code: string;
  risk_category: string;
  site_class: string;
  seismic: {
    ss: number | null;
    s1: number | null;
    sds: number | null;
    sd1: number | null;
    sdc: string | null;
    pgam: number | null;
    tl: number | null;
    model_version: string | null;
  };
  flood: {
    zone: string | null;
    subtype: string | null;
    panel: string | null;
    effective_date: string | null;
    nearest_feature_distance_meters: number | null;
  };
  climate: {
    ground_snow_psf: number | null;
    wind_speed_mph: number | null;
    roof_live_load_psf: number | null;
    frost_line_inches: number | null;
    source: string;
  };
};

export type CodeReportRoofingRequirement = {
  category: string;
  code_reference: string;
  requirement: string;
  report_value: string;
  status: "meets" | "required" | "verify" | "not_applicable";
  source: string;
};

export type CodeReportRoofingCode = {
  roof_covering: "asphalt_shingle";
  adopted_code: string;
  adopted_code_effective_date: string | null;
  local_design_criteria: {
    design_wind_speed_mph: number | null;
    exposure: string | null;
    ground_snow_load_psf: number | null;
    roof_drainage_rainfall_inches_per_hour: number | null;
    frost_line_inches: number | null;
    seismic_zone: string | null;
  };
  assumptions: {
    eave_overhang_inches: number;
    shingle_product_wind_rating: string;
  };
  requirements: CodeReportRoofingRequirement[];
};

export type CodeReportFirstMeasure = {
  project_id: string;
  address: string | null;
  status: string | null;
  total_roof_area_sqft: number | null;
  roof_face_count: number | null;
  roof_segment_count: number | null;
  predominant_pitch: string | null;
  max_pitch_degrees: number | null;
  imagery_date: string | null;
  structures: Array<{
    label: string;
    roof_area_sqft: number | null;
    ground_area_sqft: number | null;
    pitch_degrees: number | null;
    segment_count: number | null;
  }>;
};

export type CodeReportFinding = {
  title: string;
  severity: "info" | "watch" | "elevated";
  summary: string;
  basis: string;
};

export type CodeReport = {
  schema_version: 1;
  id: string;
  generated_at: string;
  request: Record<string, unknown>;
  property: CodeReportProperty;
  jurisdiction: {
    authority: string | null;
    likely_residential_code: string;
    adoption_note: string;
  };
  design: CodeReportDesignValues;
  roofing: CodeReportRoofingCode;
  firstmeasure: CodeReportFirstMeasure | null;
  findings: CodeReportFinding[];
  summary: {
    headline: string;
    narrative: string;
    limitations: string[];
  };
  sources: CodeReportSource[];
};
