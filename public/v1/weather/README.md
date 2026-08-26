# FirstMate Weather API v1

Portable weather-report API scaffold for FirstMeasure add-on reports.

## Mount

The host mounts this module at:

```text
/v1/weather
```

The module is intentionally self-contained under `weather/` so it can be copied into a standalone Node/Fastify service later.

## Endpoints

```text
GET  /v1/weather
GET  /v1/weather/ping
GET  /v1/weather/sources
POST /v1/weather/data/pull
POST /v1/weather/reports
POST /v1/weather/reports/history
POST /v1/weather/reports/reviewed
POST /v1/weather/reports/complex
GET  /v1/weather/reports/:id
GET  /v1/weather/reports/:id/pdf
```

## Report Tiers

- `history`: broad event list for an address/date range.
- `reviewed`: date-of-loss focused report using NOAA hail signatures, local storm reports, and warnings when available.
- `complex`: expanded pull with storm structure/mesocyclone datasets plus NEXRAD/MRMS/IEM artifact links for deeper analysis.

None of the tiers claims meteorologist certification.

## Example

```bash
curl -X POST http://127.0.0.1:3111/v1/weather/reports/reviewed \
  -H "Content-Type: application/json" \
  -d '{
    "property": {
      "address": "80 E 5th St, Edmond, OK 73034",
      "lat": 35.649709,
      "lon": -97.480629
    },
    "date_of_loss": "2023-04-19T23:00:00Z",
    "peril": "hail",
    "radius_miles": 12,
    "include_ai_summary": false
  }'
```

## Environment

```text
WEATHER_STORAGE_ROOT=./storage/weather
GEMINI_API_KEY=
GOOGLE_GENERATIVE_AI_API_KEY=
GEMINI_MODEL=gemini-3.5-flash
```

Gemini is optional. If no key is present, reports use deterministic summary text.

## Data Sources

- NOAA SWDI web service: `https://www.ncei.noaa.gov/swdiws/`
- NOAA SWDI S3 fallback: `https://noaa-swdi-pds.s3.amazonaws.com/`
- IEM Local Storm Reports CSV: `https://mesonet.agron.iastate.edu/cgi-bin/request/gis/lsr.py`
- IEM NWS warning metadata CSV: `https://mesonet.agron.iastate.edu/cgi-bin/request/gis/watchwarn.py`
- IEM AFOS/NWS text product archive: `https://mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py`
- NEXRAD Level-II archive: `s3://unidata-nexrad-level2/`
- MRMS archive/product family: `s3://noaa-mrms-pds/`
- IEM warnings/text archives: `https://mesonet.agron.iastate.edu/`
- U.S. Census Geocoder: `https://geocoding.geo.census.gov/`

## Production Notes

For high volume, pre-index NOAA SWDI S3 monthly/annual files into a local spatial store such as SQLite RTree, PostGIS, DuckDB spatial, or flat partitioned Parquet. The API already returns normalized records and source metadata, so the provider implementation can be swapped without changing endpoint shape.

Weather PDFs are rendered with the same FirstMeasure-style left rail, default logo, Montserrat font assets, header, footer, and card system used by the FirstMeasure instant report renderer. Generated PDFs are stored under:

```text
storage/weather/pdfs
```
