/* public/libraries/platform-offline/contracts/documents.js
 *
 * Documents offline (docs/architecture/offline.md, "What works offline"): reading only.
 *
 * A document that was opened, or that belongs to a pinned project, can be read without a connection: its
 * record, its workflow, its sent versions and the resolved definition the browser renders. Creating, editing,
 * sending, signing and PDF need the server, and say so (documents-api.js). The doc lists what is missing before
 * a document can be made or changed on a device.
 */
(function () {
  'use strict';

  const DOCUMENTS = '/v1/documents/organizations/:org';
  const enc = encodeURIComponent;
  const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
  const text = (value) => String(value == null ? '' : value).trim();
  const list = (value) => (Array.isArray(value) ? value : []);
  const base = (ctx) => `/v1/documents/organizations/${enc(ctx.org)}`;

  /** Everything the tab, the preview and the editor read for one document. */
  function documentReads(ctx, document) {
    const id = enc(document.id);
    const reads = [
      `${base(ctx)}/documents/${id}`,
      `${base(ctx)}/documents/${id}/snapshots`,
      // What the browser renders: bindings and widget data resolved by the server, as the preview and editor ask for it.
      { url: `${base(ctx)}/documents/${id}/resolve`, body: {} }
    ];
    if (isObject(document.workflow_ref) && text(document.workflow_ref.workflow_id)) {
      reads.push(`${base(ctx)}/documents/${id}/workflow`, `${base(ctx)}/workflows/${enc(document.workflow_ref.workflow_id)}`);
    }
    if (isObject(document.template_ref) && text(document.template_ref.template_id) && document.template_ref.version != null) {
      reads.push(`${base(ctx)}/templates/${enc(document.template_ref.template_id)}/versions/${enc(document.template_ref.version)}`);
    }
    return reads;
  }

  FMOffline.contracts.add({
    id: 'documents',
    reads: [
      {
        // documents/api.ts resolve: the definition with its bindings and widget data filled in. Nothing is saved.
        id: 'documents.resolve',
        match: 'POST ' + DOCUMENTS + '/documents/:document/resolve',
        when: (ctx) => ctx.body == null || isObject(ctx.body),
        key: (ctx) => ({ document: ctx.params.document, body: isObject(ctx.body) ? ctx.body : {} })
      }
    ],
    prefetch: [
      (ctx) => [`${base(ctx)}/catalog`, `${base(ctx)}/templates`, `${base(ctx)}/document-types`],
      { url: '/v1/platform/me', each: (me, ctx) => [`${base(ctx)}/settings?branch_id=${enc(text(me && me.membership && me.membership.branch_id) || 'default')}`] },
      {
        url: (ctx) => `${base(ctx)}/projects/${enc(ctx.project)}/documents`,
        each: (json, ctx) => list(json && json.documents).filter((document) => isObject(document) && text(document.id)).flatMap((document) => documentReads(ctx, document))
      }
    ]
  });
})();
