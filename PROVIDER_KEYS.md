# Provider credentials

Live Google and Gemini credentials are stored in `private/provider-keys.json`, outside the Nginx `public/` web root. The real file is intentionally ignored by Git. `private/provider-keys.example.json` documents every supported key slot.

The application currently supports a shared Google key for simple deployments. Put the existing key in `google.shared_api_key`; every empty purpose-specific slot falls back to it. Later, keys can be split without code changes:

- `browser_api_key`: common fallback for browser keys.
- `customer_browser_api_key`: customer portal Maps JavaScript/Places key.
- `internal_browser_api_key`: internal editor and production portal browser key. The remaining legacy editor-side Solar/3D tools also use this key.
- `territory_browser_api_key`: territory builder Maps JavaScript/Places key.
- `server_api_key`: fallback for server-side Google web-service requests.
- `solar_api_key`: Solar API and Solar data-layer downloads.
- `maps_static_api_key`: Maps Static API.
- `map_tiles_api_key`: Photorealistic 3D Tiles / Map Tiles API.
- `places_api_key`: server-side Places API used by territory tools.
- `gemini.api_key`: server-side Gemini requests.
- `application.internal_api_secret`: authenticates calls made internally between the Node API modules. Generate a long random value and never expose it to a browser.

For deployment, copy the real file to `<project-root>/private/provider-keys.json` as a separate deployment secret. Do not put it under `public/` or commit it. On Linux, make it readable only by the application account, for example `chmod 600 private/provider-keys.json`.

The Node loader discovers the project root in both TypeScript source and compiled `public/v1/dist` layouts. `PROVIDER_KEYS_PATH` can override the location when a deployment uses a different filesystem layout.

After changing the file, restart the Node process. PHP reads the file once per request; Node loads it at startup.
