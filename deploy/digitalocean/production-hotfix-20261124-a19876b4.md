# Production release a19876b4 (FM-632 Greek report PDFs set in Noto Sans), November 24, 2026

Production runs `a19876b4ac9bb264b795666a72631e8612081242` on all 8 hosts (compatibility, worker, 6 web nodes).
Rollback target: `b3cd6f2077b94ffa47da859e2a5dfa5ca612f0ec` (FM-631), recorded on FM-632 before activation.

## What changed

Branch `claude/fm-632-greek-report-layout-prod2` = production's b3cd6f20 plus two cherry-picks (FM-633's rolled-back
`a16b0a05` is not an ancestor):

- `f50447c0` (dev `29a9c384`, platform-20261124011448-2e0a68c6): Noto Sans 2.004 (OFL) in `public/fonts/`
  (`NotoSans-Regular.ttf`, `NotoSans-Bold.ttf`, `NotoSans-OFL.txt`); the shared PDF runtime resolves and serves them
  (`firstmeasure/pdf_runtime.ts` assets `font-noto-regular`/`font-noto-bold`, `firstmeasure/api.ts` font route);
  test `tests/report-pdf-fonts.test.ts`.
- `a19876b4` (dev lane `c1744619`, measure-internal-20261124011608-c7b64039): `editor_scripts/pdf.js` sets el-GR
  reports, and reports whose address is in Greek, in Noto Sans (Montserrat has no Greek letters, so jsPDF printed them
  blank); box titles are capitalised in the report language; `exterior_pdf.js` stat titles likewise (one line, on
  production's copy). Every other language keeps Montserrat. Test `dev/pdf-greek-font.test.cjs`.

The archive (sha256 `2dae639dc52cce601e520df6b947aad841a7f4c17c765b810d801a56ac372d42`) differs from b3cd6f20's only in
those files plus their compiled `dist/` output and `release.env`. No data, environment, flag, NGINX or config-library
change. The four already-delivered Greek PDFs (all in the "4-26 TEST" organization) were not re-rendered: that is a
production data change and needs its own request.

## Rollout (full path: Node code and files Node reads change)

Scripts: `/srv/agents/work/fm-632-prodrun-scripts` on fm-agents-1 (FM-633's set, base b3cd6f20; rollback set in `rollback/`).

- Built on the dev worker (`build.sh`, 330 s). `release.sh install` on compatibility and worker.
- Worker activated 04:53:59 UTC (no running jobs). Web channel published with previous sha256 `bd9bff72…` (b3cd6f20).
- Web nodes one at a time 04:55–05:07 UTC, each drained, activated and checked before the next (file asserts for every
  release through FM-632; FM-632's: Noto Sans bytes, `/fonts/NotoSans-*.ttf` and the PDF runtime font route served by
  the node, `pdf.js` sha256 `269b384b…`, Node font route in `dist/`).
- Compatibility through the gate at 05:07:40 UTC (159 legacy-action/min, load 1.0): rolling replace, 0 500s, 0 exits.

## Checks

- `readlink -f /opt/firstmeasure/current` = a19876b4 on all 8 hosts; `/v1/health/ready` 10/10 ready on a19876b4.
- Through app.1m8.ai (4 requests each): `/fonts/NotoSans-{Regular,Bold}.ttf` and
  `/v1/firstmeasure/pdf-runtime/fonts/NotoSans-{Regular,Bold}.ttf` 200 with the commit's bytes (`89c3c497…`,
  `e83493c9…`); `/measure/internal/editor_scripts/pdf.js` sha256 `269b384b…`, `exterior_pdf.js` `144d1029…`.
- Worker in-process (read-only): the active PDF runtime resolves `font-noto-regular`/`font-noto-bold` to the release's
  Noto Sans files and `pdf` to `pdf.js` `269b384b…`.
- 5xx from 05:09:30 vs the 30 min before: web nodes 0–0.06 % (before 0.01–0.05 %), compatibility 0.24 % (1 request,
  the long-standing `top_view_reroll_proxy.php`; before 0.19 %).
- Worker jobs since activation: 38 completed (15 `pdf.sync`, 6 `report.delivery`, 14 `report.release`, 3
  `imagery.process`), 0 failed (24 h before: 0 failed).
- Compatibility watch from 05:08: no watchdog kills, no OOM, no Node 500s, no pool timeouts.
