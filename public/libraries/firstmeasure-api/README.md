# FirstMeasure API Browser Client

`firstmeasure-api.js` is the frontend client for `/v1/firstmeasure`.

Frontend library location: `public/libraries/firstmeasure-api/firstmeasure-api.js`.
Backend API implementation: `public/v1/firstmeasure/api.ts`, with related modules in `public/v1/firstmeasure/*.ts`.

Load it before Platform app scripts that need measurement/report data:

```html
<script src="../libraries/firstmeasure-api/firstmeasure-api.js"></script>
```

It creates `window.FirstMeasureAPI`:

- `FirstMeasureAPI.configure({ baseUrl })`: override the FirstMeasure API base URL.
- `FirstMeasureAPI.url(path)`: build a URL under `/v1/firstmeasure`.
- `FirstMeasureAPI.request/get/post/put/patch`: JSON request wrappers.
- `FirstMeasureAPI.projects`: project queue/list/detail/editor/processing helpers.
- `FirstMeasureAPI.artifacts`: report, summary, XML, thumbnail, and upload helpers.
- `FirstMeasureAPI.pdfs`: PDF state/generation/render helpers.
- `FirstMeasureAPI.xml`: XML URL and assembly helpers.
- `FirstMeasureAPI.queue`: internal queue helpers.

Backend implementation lives in `v1/firstmeasure/api.ts` and related `v1/firstmeasure/*.ts` files. Do not put Platform-owned organization/customer/project data calls here; those belong in `../platform-api/platform-api.js`.
