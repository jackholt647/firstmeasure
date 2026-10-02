# Main assistant heading — October 2, 2026

Source and development web/pool release: `e662cfd26ac154ed2a7ef5fd7d7086f25531486b`.

The main conversation renders no heading in either the compact header or full workspace thread bar. Its Main thread entry remains in the conversation list. Side-chat names and agent/settings headings are preserved.

Only `public/libraries/platform-assistant/platform-assistant.js` was overlaid on each verified web baseline. Previous web release: `02cbae1bf38f0b3534d36c5087edfeeec828f61a`; previous pool release: `a8467b0f07a6940b624da6a9e360e4c5b788bce9`. Staging preserved all other node contents. Production, worker, compatibility and configuration were unchanged.

JavaScript syntax and local browser checks passed. After sequential activation, both nodes passed release/hash/readiness verification with development outbound isolation enforced. A fixture loading the actual public scripts verified blank main headings, the retained navigation entry, side-chat titles, return to main, desktop/mobile history toggles and global sidebar mounting.

Operational evidence and rollback baselines are in ignored `output/assistant-main-title-20261002/`. Before rollback, inspect for later releases; restore the appropriate prior node release only when no newer changes would be lost, otherwise apply a scoped reverse delta. No data migration is involved.
