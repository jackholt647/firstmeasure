# Production hotfix f4b74de0: Quad views retired (1M8-233), October 23, 2026

Jack approved this release in the conversation ("let's just get it turned off"). It is production `9c022473` plus `45d01e14` from `claude/gifted-golick-0122af`. The dev rollout record commit was skipped because of a `DEPLOYMENT.md` conflict.

Roof PDFs drew a "North, South, East, West" Elevations page whenever a technician uploaded a Quad screenshot: about 18% of reports, with broken, repeated or wrong-property images. The October 14 settings change only hid the option. Now:

- The Quad button and step are always hidden.
- A saved quad crop is neither loaded nor uploaded.
- A saved `pdf_state` quad image is dropped.
- The Elevations page is never drawn in the PDF, the report preview or QA.

The 735 existing reports that carry the page are unchanged until they are regenerated.

## Checks

All pass:

- `quad-views-retired`, `report-header` and `portal-regressions`: 22 of 22.
- `pdf-cricket-labels` and `pdf-obstacle-count`: 3 of 3.
- `pdf-worker-runtime` and `report-tabs-real-clicks`: 8 of 8.

The editor scripts are versioned by content hash and `qa.js` by time, so no cache bump was needed.

**Build:** archive `cc525af4…`, verified.

## Rollout

- Compatibility (0 errors and 0 crashes in the next 20 s), worker, the signed channel (against `9f39f64c…`, `9c022473`) and six web nodes activated.
- Public readiness returned `f4b74de0` 10 out of 10 times.
- The served `pdf.js` carries the change.

## Rollback

Every role keeps `9c022473`. Republish it (`9f39f64c…`) to the channel before rolling back a web node.
