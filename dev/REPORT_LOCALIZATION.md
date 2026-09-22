# Optional report units and language

This is a local implementation; no flags or production settings are changed by it.

## Enable an organization

The internal **Feature Flags** page has two new FirstMeasure flags, both false by default:

- `firstmeasure.metric_measurements`: use metric as the default for new orders.
- `firstmeasure.report_localization`: expose **Measurements** and **Report language** in **Company** settings and accept explicit order overrides.

Enable `report_localization` for a test organization, open Company, select Metric and English (United Kingdom), and save. Subsequent orders use those settings. The metric flag is an operator-set default; with customization enabled, a saved company choice or explicit order parameter takes precedence.

Company preferences are stored in the current branch's `data.report_preferences`, alongside the existing branch company settings:

```json
{
  "measurement_system": "metric",
  "report_language": "en-GB"
}
```

Order APIs accept those same optional fields. Supported values are `imperial` / `metric` and `en-US` / `en-GB`. The defaults are `imperial` and `en-US`. Language and units are independent. The internal full-house order page also has these selectors.

For organization orders, the server resolves flags and branch defaults; hiding the Company controls is not the access control. Disabled organizations cannot override their configured default through an order payload. Branch preference writes require the customization flag. Existing orders retain their saved preferences when company settings or flags change.

## Measurement and PDF contract

- Geometry remains in metres; existing roof takeoffs remain in feet, square feet, and roofing squares internally.
- Conversion happens at input/display boundaries. Metric distance entry uses metres, and trim inputs use millimetres. Rotation input remains degrees.
- Metric roof and exterior PDFs use metres and square metres. A roofing square is 100 square feet, or 9.290304 square metres; metric reports display the equivalent area instead of defining a different kind of square.
- Ventilation area uses square centimetres and liquid quantities use litres. Manufacturer package counts and physical product sizes remain the same products; their displayed dimensions are converted.
- US formatting branches return the original text and layout. Report-owned British English strings use the locale catalog; customer names, addresses, and notes are not rewritten.
- PDF sync snapshots freeze preferences. Browser previews, isolated browser rendering, and the server renderer load the same units module. XML geometry/export formats retain their existing contracts.
- Adding another language requires a catalog in `public/libraries/report-units.js`, a supported value in the server schemas, and a Company selector option, with rendering tests for that locale/font.

## Local checks

From the repository root:

```powershell
npm --prefix public/v1 run check
node --test dev/report-localization.test.cjs
node dev/report-localization.browser.cjs
```

From `public/v1`:

```powershell
node --experimental-sqlite --import tsx --test --test-force-exit tests/report-localization.test.ts
```

The browser fixture uses local Chrome (`CHROME_PATH` can override its path), intercepts every network request, and uses checked-in fonts/images. It writes local example PDFs under `output/report-localization`, checks byte identity between default and explicit US PDFs, and does not contact production. The backend test uses temporary isolated SQLite/platform stores.
