# Code Reports

Standalone property code and hazard report generator. It is intentionally separate from the weather report generator and the FirstMeasure report generator, but it can enrich a report with existing FirstMeasure project artifacts when a `firstmeasure_project_id` is supplied.

## Endpoints

- `GET /v1/code-reports/ping`
- `GET /v1/code-reports/sources`
- `POST /v1/code-reports/reports`
- `GET /v1/code-reports/reports/:id`
- `GET /v1/code-reports/reports/:id/pdf`

## Example

```json
{
  "property": { "address": "905 Ave A, Snohomish, WA 98290" },
  "firstmeasure_project_id": "0a80f61d26c0409183e669c3cc7c84e5",
  "roof_covering": "asphalt_shingle",
  "eave_overhang_inches": 12,
  "shingle_product_wind_rating": "ASTM D7158 Class H / ASTM D3161 Class F",
  "reference_code": "ASCE7-22",
  "risk_category": "II",
  "site_class": "D",
  "persist": true
}
```

## Public Sources

- U.S. Census Geocoder for coordinates and jurisdiction context.
- USGS Design Maps API for ASCE seismic design values.
- FEMA National Flood Hazard Layer ArcGIS REST service for point flood-zone screening.
- FirstMeasure project artifacts for roof geometry when available.

For Snohomish, WA / Snohomish County, the report includes local roofing design criteria and the adopted 2021 IRC with Washington amendments. The roofing section covers asphalt-shingle slope, underlayment, ice barrier coverage, drip edge, wind rating, fasteners, valleys, flashing/crickets, sheathing, roof drainage, ventilation, and inspections.

For other jurisdictions, the generator still produces a model-code roofing baseline and clearly identifies local criteria that have not yet been mapped. Add new jurisdictions in `roofing.ts` as official local sources are confirmed.
