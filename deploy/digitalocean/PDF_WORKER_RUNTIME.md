# Dedicated worker PDF runtime

The worker needs a non-Snap Chromium and its Linux libraries. Ubuntu's
chromium-browser launcher invokes Snap, which cannot run under the service's
read-only home/runtime restrictions. Do not remove service hardening to fix it.

From the worker's release `public/v1` directory, install the browser version
matched to that release's locked playwright-core package:

```sh
PLAYWRIGHT_BROWSERS_PATH=/opt/firstmeasure/browsers node node_modules/playwright-core/cli.js install chromium --only-shell
node node_modules/playwright-core/cli.js install-deps chromium
```

Set FIRSTMEASURE_PDF_BROWSER to the resulting chrome-headless-shell executable.
Set FIRSTMEASURE_PDF_RUNTIME_BASE_URL to the same environment's reachable
`/v1/firstmeasure/pdf-runtime` endpoint, never another environment or worker localhost.
The dev-only drop-in records the version installed on September 6, 2026; update
the executable path whenever Playwright's pinned browser revision changes.

Test `pdf-browser-smoke.mjs` under User=firstmeasure, NoNewPrivileges=true,
PrivateTmp=true, ProtectSystem=strict and ProtectHome=true before restarting.
Also run a real editor PDF sync: a simple smoke PDF does not test asset routing.
Worker execution must honor its configured runtime even for queued jobs whose
serialized asset URL came from a web node's localhost.

Only isolated dev worker 137.184.44.82 was changed in this repair. Production
still needs this provisioning requirement applied and verified before cutover.
