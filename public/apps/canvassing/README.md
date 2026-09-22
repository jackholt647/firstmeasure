# Standalone Canvassing App

This directory is the standalone web wrapper for the canvassing mobile app.

Important boundaries:

- Authentication/login/signup lives here in `apps/canvassing/app.js`.
- Shared map/pin/manager UI lives in `libraries/canvassing-app/canvassing-app.js`.
- Canvassing API calls go through `libraries/canvassing-api/canvassing-api.js`.
- Platform auth/session/org creation goes through `libraries/platform-api/platform-api.js`.

Do not add core map behavior, pin rendering, status legend behavior, or manager/user rendering directly here. Put reusable UI behavior in `libraries/canvassing-app` so the future Platform mobile shell can mount the same renderer.

URL from Platform should point to `/apps/canvassing/`.
