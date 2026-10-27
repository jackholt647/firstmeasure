# Markup on photos, files and project documents

Pen strokes, arrows and text that a person draws over a photo or a page are kept apart from the file they cover, as a
**markup layer**. There are two homes, chosen by whether the thing marked up is a media file.

## Media files (photos, uploaded PDFs)

A media file keeps its layers on the media record:
`GET`/`PUT`/`PATCH /v1/platform/organizations/:orgId/media/:mediaId/markup/:layerId`
(`readMediaMarkupLayer` / `saveMediaMarkupLayer` in `platform/storage.ts`, table `platform_media_markup` on Postgres),
with `PlatformAPI.media.getMarkup` / `saveMarkup`. The client prefixes the layer id (`media.markupLayerId`), so
`saveMarkup(org, media, 'document_markup', ...)` stores layer `markup_document_markup`. Photo markup
(`markup_photo_markup`) also refreshes the marked-up thumbnails.

## Project documents that are not media

A project's delivered measurement reports (Roof Measurement Report, Customer Report: URLs from the measurement order)
and other documents shown from a URL have no media id. Their markup is kept per project and **document key**
(`projects/document-markup.ts`):

- `GET /v1/platform/organizations/:orgId/projects/:projectId/document-markup/:docKey` answers
  `{ ok: true, layer: null }` or `{ ok: true, layer: { doc_key, data, revision, updated_at, updated_by_name? } }`.
- `PUT` the same path with `{ data, expected_revision? }` replaces it and answers the same shape. With
  `expected_revision` (0 for "none yet") a save from an older copy is refused with 409.
- Client: `PlatformAPI.projectDocumentMarkup.get(orgId, projectId, docKey)` and
  `.save(orgId, projectId, docKey, data, { expected_revision })`.

**Key.** `[a-z0-9_:.-]{1,100}`, lower-cased; anything else is refused, never rewritten. 100 is the router's path
parameter limit (longer answers 414). Use the document's identity in the Docs list (`roof_report_pdf`,
`customer_report_pdf`); add the report id (`roof_report_pdf:<id>`) where markup must not carry over to a re-measured
report.

**Data.** `{ schema: 1, pages: { "1": [item, ...], ... } }`: page keys are page numbers 1 to 5000 written as
strings, each page a list of plain objects, at most 512 KB of JSON. Items belong to the viewer and are not read by the
server.

**Who.** The route is gated to the apps that open project documents (the media markup apps plus `project.docs`,
`project.documents`, `project.materials`, `project.measurements`, `project.crew_materials`). The project is checked
with `readProjectForMedia` (`projects/media-assignment.ts`): reading needs a project the caller may see
(`view_projects`, branch and department rules; otherwise 404), saving needs `manage_projects` on it and the CSRF token.
The saver's name, email and user id come from the session and are stored in the record's metadata; only the name is
returned.

**Storage.** One record per project and key in the platform document store, collection `project_document_markup`, id
`pdm_` + sha256(project id, key). It is an ordinary collection (file store, or `platform_documents` on Postgres), so
there is no table or migration, and it is not in the generic collection API. A project merge moves the merged
project's records to the survivor's keys (reference adapter `project-document-markup` in `contacts/references.ts`);
where the survivor already has markup for a key, the survivor's stays.

**Not built.** The merge adapter reads the whole collection for the organization
([optimization backlog](../optimization-backlog.md#a-project-merge-reads-every-document-markup-record)).

Tests: `tests/project-document-markup.test.ts`.
