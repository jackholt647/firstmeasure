# Measurements viewer and development report samples

Implemented locally October 2, 2026. Not deployed by this change.

The Measurements app has a **Model & photos** view for completed reports.
It reads stored Roofplan XML, renders a textured roof or the editor's colored
line types, and provides a line key, orbit/zoom and camera reset. It loads no
editor controls or height map. Textures are a neutral shingle material, not a
claim about the property's actual roof material. The solar RGB GeoTIFF becomes
a top-down image. Stored aerial imagery and customer-reference photos/videos
share the media library. Wide panes show media on the left and the model on the
right; panes narrower than 800 pixels use a viewer above a horizontal library.
Existing PDF, summary and download views remain available.

Overview offers **Order Measurements** after an address and property type have
been entered on a project without a report. It enters the existing workflow
and retains the platform project ID.

For authorized developers, an inline **FM** button chooses a random completed
report matching the current residential/commercial/multifamily and roof/full-house
selection. Unselected criteria default to residential/roof. It avoids the
previous report when another usable sample exists. No match leaves the address
unchanged. It validates file inventory rather than assuming an index flag proves
that a usable report exists.

Choosing an address never completes an ordinary order automatically. The
separate **Instant development report** checkbox defaults off. It appears only
for a selected sample whose address, property type and scope still match. It
reuses the stored PDFs and assets into a new measurement record; it does not
enter technician queues, charge credits, regenerate PDFs, or run delivery and
notification transitions. The source record is untouched. Existing PDFs retain
their original branding. The completion is linked through the normal project
order response.

The server requires `order_reports`, the development application environment,
and the development data environment. Developer authority uses the existing
`canManageTestAppFlags` operator gate; deployment-owned
`FIRSTMEASURE_DEVELOPER_EMAILS` or `EXPERIMENTAL_ACCOUNTS_ADMIN_EMAILS` can explicitly
grant it as well. An ordinary organization administrator is insufficient. A
signed selection token is bound to the current user, organization, report,
criteria and one-hour expiry, and submission rechecks the source state and
address. These dedicated development operations are not published to agents or
document modules. They preserve FirstMeasure's seven production permission keys.

## Read-only inventory, October 2

The live development environment and data environment both reported
`development`. Completed indexed records with Report.pdf, Summary.pdf and
model_data.xml flags:

| Property type | Usable artifact flags |
| --- | ---: |
| Residential | 44,688 |
| Commercial | 1,929 |
| Multifamily | 721 |
| Unspecified legacy type | 1,047 |

One sample per named property type was checked against its actual stored file
inventory and readable XML. Development has eight residential full-house drafts
marked ready and one queued, with no completed artifact sets. A read-only
production query found no records tagged `measurement_scope=full_house`.
No production data was copied. Full-house sampling currently returns no match.

## Verification

- TypeScript check.
- Browser checks for ordinary-project order entry, randomized address criteria,
  checkbox opt-in, changed criteria and no-match behavior.
- Browser checks for XML faces with reversed edges, WebGL rendering, texture/line
  modes, legend, solar TIFF decoding, image selection, wide/narrow pane layouts,
  and disposal. The viewer issues no write requests.
- Backend checks for selection, no-match results, developer/environment gates,
  signed-token tampering, expiry, organization binding, changed address/type and
  a separate completed copy with the source unchanged.
- Existing measurement reorder host tests.

The unrelated project-reorder-persistence test fails while initializing its
existing `project_viewer.js` harness because its fake window lacks
`addEventListener`; that source file is unchanged by this work. Browser evidence
is in ignored `output/measurements-viewer/`. Live authenticated rollout checks
remain for a development deployment.
