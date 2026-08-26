import type { CodeReportRequest } from "./schemas.js";
import { loadFirstMeasureEnrichment } from "./firstmeasure.js";
import { resolveCodeReportProperty } from "./geocode.js";
import { buildRoofingCode } from "./roofing.js";
import { fetchPublicDesignValues } from "./sources.js";
import { generateCodeReportId, saveCodeReport } from "./storage.js";
import type { CodeReport, CodeReportFinding, CodeReportSource } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export async function buildCodeReport(input: CodeReportRequest): Promise<{ report: CodeReport; stored_path: string | null }> {
  const timeoutMs = input.source_timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const resolved = await resolveCodeReportProperty(input.property, timeoutMs);
  const design = await fetchPublicDesignValues({
    property: resolved.property,
    referenceCode: input.reference_code,
    riskCategory: input.risk_category,
    siteClass: input.site_class,
    timeoutMs
  });
  const firstmeasure = await loadFirstMeasureEnrichment(input.firstmeasure_project_id);
  const roofing = buildRoofingCode({
    property: resolved.property,
    design: design.design,
    firstmeasure,
    eaveOverhangInches: input.eave_overhang_inches,
    shingleProductWindRating: input.shingle_product_wind_rating
  });
  const sources: CodeReportSource[] = [resolved.source, ...design.sources];
  const findings = buildFindings(design.design, firstmeasure, roofing);
  const report: CodeReport = {
    schema_version: 1,
    id: generateCodeReportId(),
    generated_at: new Date().toISOString(),
    request: input,
    property: resolved.property,
    jurisdiction: {
      authority: resolved.property.place ?? resolved.property.county ?? null,
      likely_residential_code: "IRC/IBC family, local adoption required",
      adoption_note: "This report identifies likely jurisdiction from Census geography. Adopted code year, amendments, permit thresholds, and product approvals must be confirmed with the authority having jurisdiction."
    },
    design: design.design,
    roofing,
    firstmeasure,
    findings,
    summary: buildSummary(resolved.property, findings, firstmeasure != null),
    sources
  };
  const storedPath = input.persist ? await saveCodeReport(report) : null;
  return { report, stored_path: storedPath };
}

function buildFindings(design: CodeReport["design"], firstmeasure: CodeReport["firstmeasure"], roofing: CodeReport["roofing"]): CodeReportFinding[] {
  const findings: CodeReportFinding[] = [];
  findings.push({
    title: "Local Roofing Code Identified",
    severity: "info",
    summary: `${roofing.adopted_code}${roofing.adopted_code_effective_date ? `, effective ${roofing.adopted_code_effective_date}` : ""}.`,
    basis: `AHJ context: ${roofing.requirements[0]?.report_value ?? "local jurisdiction"}.`
  });
  if (design.seismic.sdc && ["D", "E", "F"].includes(design.seismic.sdc)) {
    findings.push({
      title: "Elevated Seismic Design Category",
      severity: "elevated",
      summary: `USGS returned seismic design category ${design.seismic.sdc}.`,
      basis: `${design.reference_code}, risk category ${design.risk_category}, site class ${design.site_class}.`
    });
  } else {
    findings.push({
      title: "Seismic Values Captured",
      severity: "info",
      summary: "USGS design values were collected for screening and report documentation.",
      basis: `SDS ${display(design.seismic.sds)}, SD1 ${display(design.seismic.sd1)}, SDC ${display(design.seismic.sdc)}.`
    });
  }
  if (design.flood.zone && !["X", "AREA NOT INCLUDED"].includes(design.flood.zone.toUpperCase())) {
    findings.push({
      title: "Mapped Flood Hazard Zone",
      severity: "elevated",
      summary: `FEMA NFHL returned flood zone ${design.flood.zone}.`,
      basis: design.flood.subtype || "Flood Hazard Zones layer intersected the property coordinate."
    });
  } else {
    findings.push({
      title: "Flood Layer Screening",
      severity: "info",
      summary: design.flood.zone ? `FEMA NFHL returned zone ${design.flood.zone}.` : "No intersecting FEMA flood hazard zone was returned for the point query.",
      basis: "FEMA NFHL point query against Flood Hazard Zones layer."
    });
  }
  if (firstmeasure) {
    findings.push({
      title: "Roof Geometry Available",
      severity: "info",
      summary: `FirstMeasure enrichment found ${display(firstmeasure.total_roof_area_sqft)} sq ft of roof area and ${display(firstmeasure.roof_face_count)} roof faces.`,
      basis: `FirstMeasure project ${firstmeasure.project_id}.`
    });
  }
  const requiredItems = roofing.requirements.filter((item) => item.status === "required").length;
  findings.push({
    title: "Roofing Installation Requirements Included",
    severity: "info",
    summary: `${requiredItems} required roofing-code items are included for asphalt-shingle scope, including ice barrier, drip edge, wind rating, flashing, fasteners, and inspections.`,
    basis: roofing.adopted_code
  });
  return findings;
}

function buildSummary(property: CodeReport["property"], findings: CodeReportFinding[], hasFirstMeasure: boolean) {
  const elevated = findings.filter((finding) => finding.severity === "elevated");
  const headline = elevated.length
    ? `${elevated.length} elevated code/hazard item(s) identified for screening.`
    : "No elevated national hazard flags were identified in the automated screening.";
  const place = property.place ?? property.county ?? property.state ?? "the selected site";
  return {
    headline,
    narrative: `The automated code report assembled national public datasets for ${place}, including Census jurisdiction context, USGS seismic design values, FEMA flood hazard screening, and ${hasFirstMeasure ? "FirstMeasure roof geometry" : "optional FirstMeasure roof geometry when supplied"}. The output is intended for estimating, intake, and permit-prep review, not as a stamped design document.`,
    limitations: [
      "Confirm adopted code editions, amendments, permit thresholds, and product approval requirements with the local authority having jurisdiction.",
      "USGS seismic values depend on selected reference document, risk category, and site class.",
      "FEMA point queries are a screening tool; parcel-scale flood determinations should use official FIRM products or a flood professional.",
      "Climate values in this first version are screening estimates unless replaced by an official local/ASCE source."
    ]
  };
}

function display(value: unknown) {
  if (value == null || value === "") return "--";
  return String(value);
}
