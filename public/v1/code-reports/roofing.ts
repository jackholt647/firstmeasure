import type { CodeReportDesignValues, CodeReportFirstMeasure, CodeReportProperty, CodeReportRoofingCode, CodeReportRoofingRequirement } from "./types.js";

export function buildRoofingCode(input: {
  property: CodeReportProperty;
  design: CodeReportDesignValues;
  firstmeasure: CodeReportFirstMeasure | null;
  eaveOverhangInches: number;
  shingleProductWindRating: string;
}): CodeReportRoofingCode {
  const local = resolveLocalRoofingContext(input.property);
  const pitch = input.firstmeasure?.predominant_pitch ?? null;
  const pitchDegrees = input.firstmeasure?.max_pitch_degrees ?? null;
  const iceCoverage = iceBarrierCoverage(input.eaveOverhangInches, pitchDegrees);
  const windClass = requiredWindClass(local.designWindSpeedMph ?? input.design.climate.wind_speed_mph);
  const requirements: CodeReportRoofingRequirement[] = [
    req("Adopted residential code", "WAC 51-51 / 2021 IRC", `${local.adoptedCode}. Local amendments and permit process apply.`, local.authority, "verify", local.source),
    req("Asphalt shingle slope", "IRC R905.2.2", "Asphalt shingles are permitted only on slopes of 2:12 or greater. Slopes from 2:12 up to 4:12 require double underlayment.", pitch ?? "No measured pitch supplied", pitchStatus(input.firstmeasure), "2021 IRC Chapter 9; Washington re-roof checklist"),
    req("Underlayment", "IRC Table R905.1.1(2), R905.2.7", underlaymentText(pitch), pitch ? `Predominant pitch ${pitch}` : "Use slope-specific application", "required", "2021 IRC Chapter 9; Washington re-roof checklist"),
    req("Ice barrier / ice & water", "IRC R905.1.2", `Where ice-dam history is designated, install two cemented underlayment layers or self-adhered polymer-modified bitumen from the lowest roof edge to at least 24 inches inside the exterior wall line. For the report assumption of ${input.eaveOverhangInches} inch eave overhang, estimated minimum along-slope coverage is ${iceCoverage}.`, "Use ice barrier at eaves unless AHJ confirms site is outside designated ice-dam area", "required", "2021 IRC R905.1.2"),
    req("Drip edge", "IRC R905.2.8.5", "Provide drip edge at eaves and rake edges. Lap adjacent pieces at least 2 inches, extend at least 1/4 inch below sheathing, extend at least 2 inches back onto roof deck, and fasten at not more than 12 inches o.c. Underlayment goes over drip edge at eaves and under drip edge at rakes.", "Required at all asphalt-shingle eaves and rakes", "required", "2021 IRC R905.2.8.5"),
    req("Shingle wind rating", "IRC R905.2.4.1", `Shingle packaging must show ASTM D7158 classification for the local wind speed. For ${local.designWindSpeedMph ?? input.design.climate.wind_speed_mph ?? "--"} mph design wind, require ${windClass}.`, input.shingleProductWindRating, windRatingStatus(input.shingleProductWindRating, windClass), "2021 IRC R905.2.4.1 and local design wind criteria"),
    req("Fasteners", "IRC R905.2.5, R905.2.6", "Use corrosion-resistant roofing nails with minimum 12-gage shank and 3/8 inch head. Fasteners must penetrate at least 3/4 inch into roof sheathing or through sheathing where sheathing is less than 3/4 inch. Use manufacturer nail pattern; high-wind installation commonly requires enhanced fastening.", "Verify product installation instructions for final nail count and zone", "required", "2021 IRC R905.2.5-R905.2.6"),
    req("Valley lining", "IRC R905.2.8.2", "Open valleys require approved corrosion-resistant metal or two-ply mineral-surfaced roll roofing; closed valleys require approved roll roofing or equivalent valley lining. Self-adhered ASTM D1970 material may be used where permitted by the section.", "Required where valleys exist", "verify", "2021 IRC R905.2.8.2"),
    req("Flashing and crickets", "IRC R903.2, R905.2.8.3-R905.2.8.4, R908.6", "Reconstruct flashings per manufacturer instructions. Use step flashing at vertical sidewalls. Install a cricket/saddle on the ridge side of chimneys or penetrations over 30 inches wide measured perpendicular to slope.", "Required at roof-wall transitions, penetrations, skylights, chimneys", "required", "2021 IRC; Washington re-roof checklist"),
    req("Sheathing", "IRC R803.2.1.1, R803.2.2", "Inspect for rot/delamination. Confirm span rating for rafter/truss spacing. Typical 7/16 inch OSB span-rated 24/16 does not require clips; sheathing less than 1/2 inch over rafters spaced more than 20 inches o.c. requires clips or blocked edges.", input.firstmeasure ? `${input.firstmeasure.roof_face_count ?? "--"} measured roof faces` : "Verify on site", "verify", "Washington re-roof checklist"),
    req("Roof drainage", "IRC R903.4 and WA amendment", `Roof drainage design rainfall: ${local.rainfallInchesPerHour ?? "--"} inches/hour where local criteria apply. Overflow drains/scuppers required where roof drains are used.`, "Verify low-slope/parapet roof drainage condition", "verify", local.source),
    req("Ventilation", "IRC R806", "Provide cross ventilation of enclosed attics/rafter bays. Net free vent area is typically 1/150 of attic area, reducible to 1/300 when code exception conditions are met.", "Verify intake/exhaust balance during final inspection", "verify", "2021 IRC R806; Washington re-roof checklist"),
    req("Inspections", "IRC R109.1.5 / local procedure", "Typical re-roof inspections include pre-inspection, nailing/progress inspection, and final. Nailing inspection is required before covering when sheathing is replaced or added over skip sheathing.", "Coordinate with AHJ permit process", "verify", "Washington re-roof checklist")
  ];

  return {
    roof_covering: "asphalt_shingle",
    adopted_code: local.adoptedCode,
    adopted_code_effective_date: local.effectiveDate,
    local_design_criteria: {
      design_wind_speed_mph: local.designWindSpeedMph ?? input.design.climate.wind_speed_mph,
      exposure: local.exposure,
      ground_snow_load_psf: local.groundSnowLoadPsf ?? input.design.climate.ground_snow_psf,
      roof_drainage_rainfall_inches_per_hour: local.rainfallInchesPerHour,
      frost_line_inches: local.frostLineInches ?? input.design.climate.frost_line_inches,
      seismic_zone: local.seismicZone
    },
    assumptions: {
      eave_overhang_inches: input.eaveOverhangInches,
      shingle_product_wind_rating: input.shingleProductWindRating
    },
    requirements
  };
}

function resolveLocalRoofingContext(property: CodeReportProperty) {
  const state = String(property.state ?? "").toUpperCase();
  const place = String(property.place ?? "").toLowerCase();
  const county = String(property.county ?? "").toLowerCase();
  if (state === "WA" && (place.includes("snohomish") || county.includes("snohomish"))) {
    return {
      authority: place.includes("snohomish") ? "City of Snohomish, WA" : "Snohomish County, WA",
      adoptedCode: "2021 International Residential Code as amended and adopted by Washington State",
      effectiveDate: "2024-03-15",
      designWindSpeedMph: 110,
      exposure: "B or C depending on location",
      groundSnowLoadPsf: 25,
      rainfallInchesPerHour: 2,
      frostLineInches: 18,
      seismicZone: "D, E",
      source: "City of Snohomish Building Code Information / Snohomish County Building Construction Codes"
    };
  }
  if (state === "WA") {
    return {
      authority: property.place ?? property.county ?? "Washington AHJ",
      adoptedCode: "2021 International Residential Code as amended and adopted by Washington State",
      effectiveDate: "2024-03-15",
      designWindSpeedMph: null,
      exposure: null,
      groundSnowLoadPsf: null,
      rainfallInchesPerHour: null,
      frostLineInches: null,
      seismicZone: null,
      source: "Washington State Building Code Council / local AHJ"
    };
  }
  return {
    authority: property.place ?? property.county ?? "Local AHJ",
    adoptedCode: "Locally adopted IRC/IBC family code",
    effectiveDate: null,
    designWindSpeedMph: null,
    exposure: null,
    groundSnowLoadPsf: null,
    rainfallInchesPerHour: null,
    frostLineInches: null,
    seismicZone: null,
    source: "Census geography plus model code baseline"
  };
}

function req(
  category: string,
  code_reference: string,
  requirement: string,
  report_value: string,
  status: CodeReportRoofingRequirement["status"],
  source: string
) {
  return { category, code_reference, requirement, report_value, status, source };
}

function pitchStatus(firstmeasure: CodeReportFirstMeasure | null) {
  if (!firstmeasure?.predominant_pitch) return "verify";
  const pitch = Number(firstmeasure.predominant_pitch.match(/(\d+)\s*deg/)?.[1] ?? NaN);
  return Number.isFinite(pitch) && pitch >= 9.5 ? "meets" : "verify";
}

function underlaymentText(pitch: string | null) {
  if (!pitch) return "Install underlayment by roof slope: double underlayment for asphalt-shingle slopes from 2:12 up to 4:12; standard shingle-fashion underlayment at 4:12 and steeper unless product instructions require more.";
  return pitch.includes("/ 2:12") || pitch.includes("/ 3:12")
    ? "Double underlayment required for the measured low-slope asphalt-shingle roof area."
    : "Predominant measured pitch is 4:12 or steeper, so standard shingle-fashion underlayment applies unless manufacturer/AHJ requires enhanced underlayment.";
}

function iceBarrierCoverage(eaveOverhangInches: number, pitchDegrees: number | null) {
  const degrees = pitchDegrees ?? 26.565;
  const alongSlope = (eaveOverhangInches + 24) / Math.cos(degrees * Math.PI / 180);
  return `${Math.ceil(alongSlope)} inches from eave edge along roof slope`;
}

function requiredWindClass(windSpeed: number | null | undefined) {
  if (windSpeed == null) return "ASTM D7158 classification matching AHJ design wind speed";
  if (windSpeed <= 110) return "ASTM D7158 Class D, G, or H";
  if (windSpeed <= 150) return "ASTM D7158 Class G or H";
  return "ASTM D7158 Class H or engineered/product-specific approval";
}

function windRatingStatus(productRating: string, required: string) {
  const rating = productRating.toUpperCase();
  if (required.includes("Class D") && /CLASS\s*[DGH]/.test(rating)) return "meets";
  if (required.includes("Class G") && /CLASS\s*[GH]/.test(rating)) return "meets";
  if (required.includes("Class H") && /CLASS\s*H/.test(rating)) return "meets";
  return "verify";
}
