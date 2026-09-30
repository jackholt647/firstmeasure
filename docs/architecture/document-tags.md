# Document tags

Document Studio exposes **Tags** immediately left of Brand Kit. The organization
catalog is shared by template, workflow, folder document and programmable module
pickers. Each picker supports multiple existing tags and quick creation.

`GET /v1/documents/organizations/:orgId/tags` returns `tags` with `id`, `label`,
`archived` and `revision`. Reads require Documents access and `view_documents`.
Creation and revision-checked updates require Studio access,
`manage_company_settings` and CSRF. Existing assignments are discovered without
writing catalog records. A discovered tag has revision zero until managed.

The normalized original tag is its stable ID. Rename changes only its display
label. Archive removes it from new selection while retaining existing assignments,
signed artifacts and notification selectors. Restore makes it selectable again.
There is deliberately no destructive delete or mass retagging operation.

New document instances inherit the union of selected template and workflow tags.
Programmable module instances capture definition tags and carry them into newly
materialized documents. Future template/module changes do not alter prior instances.
Document events expose `document_tags`, `template_id` and `workflow_id`; notification
filters compare stable tag IDs, never display labels or inferred business meaning.
Older untagged instances remain untagged and can be reviewed separately.
