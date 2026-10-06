# Document templates on margin-fitted regions — October 6, 2026

Development only. Production was not activated.

Source commit `aad0ff4c25d5f64647dba50259c23d3bbfb6d421`, deployed as release
`3b661c1b66129b971ed8759e6a7fbb470960de8b` (the branch head at rollout, which
contains it) to worker, compatibility, web and pool, one role at a time.

Seeded document templates, except the one-page legal agreement, and the four
Instant roofing estimates now hold each page's content in one body region
fitted to the page style's margins. The Docs tab Theme menu re-fits those
regions when the style changes. The New Document dialog reads a template's
pinned workflow from its metadata. Preset revision 30 upgrades unedited
presets on the next template read; Instant roofing pack 2 republishes existing
packs. Three alias presets are archived. Documents created earlier keep their
pinned template version. See `public/v1/documents/README.md`.

## Verification

`npm run check` passed. Document API, versions, Instant roofing and paper-upload
suites: 33 passed. All 17 seeded layouts were rendered under the three page
styles through the PDF harness with no content outside the page. After
activation each role's 13 files matched the payload and reported ready with
development isolation; the public health endpoint returned the release id.
The Docs tab was not exercised in a hosted browser session.

## Rollback

Activate each role's previous release recorded in
`output/document-templates-20261006/manifest.json` using the normal development
procedure; verify current state first. Presets already upgraded stay at
revision 30 and remain valid for the earlier renderer except that row columns
lose their shared-width sizing.

## Followup: itemized roofing workflow

Release `5069ecd3ba17c58b84ad24b48d36e895b28c9e62`, same four roles, development
only. The itemized roofing proposal's workflow is now three steps: roof
measurements read from the project's selected measurement dataset, a priced
scope review, and a review step. Its scope piece is fixed to roof replacement.
Line-item rows indent by role instead of a printed bullet, empty optional text
lines collapse, and the itemized template prints each line's amount. The
workflow screen gained a hideable, resizable live preview and a single header
row. Preset revision 31 and Instant roofing pack 3 upgrade existing assets;
documents created earlier keep their pinned versions.

Document API, versions and Instant roofing suites: 36 passed. The workflow was
exercised in a local browser harness with stand-in services at three widths;
it was not exercised in a hosted browser session. Scope lines are still
generated in the browser by the legacy proposals module, which rounds
measurements to whole numbers. Rollback: the previous release per role is in
`output/document-workflow-20261006/manifest.json`.
