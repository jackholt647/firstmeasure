/* public/libraries/platform-offline/contracts/contacts.js
 *
 * Contacts offline (docs/architecture/offline.md, "What works offline"): a new contact, edits to one, and the
 * contacts of a project.
 *
 * The page makes a contact's id (`contact_<time>_<random>`); the server answers a repeat with 409
 * `contact_exists`, which here means the first try arrived. An edit carries `expected_revision` and is merged
 * per field when the contact changed meanwhile. A project's contacts are a list of links
 * (`PUT .../projects/:project/contacts`); the server keeps the project's own copy of names and numbers.
 */
(function () {
  'use strict';

  const ORG = '/v1/platform/organizations/:org';
  const enc = encodeURIComponent;
  const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
  const text = (value) => String(value == null ? '' : value).trim();
  const list = (value) => (Array.isArray(value) ? value : []);
  const iso = (ctx) => new Date(ctx.now).toISOString();
  const contactUrl = (ctx, id) => `/v1/platform/organizations/${enc(ctx.org)}/contacts/${enc(id)}`;
  const projectUrl = (ctx, id) => `/v1/platform/organizations/${enc(ctx.org)}/projects/${enc(id)}`;
  const idOf = (body) => text(body && (body.id || body.contact_id));
  const nameOf = (contact) => text(contact && contact.name) || [text(contact && contact.first_name), text(contact && contact.last_name)].filter(Boolean).join(' ');

  const point = (kind, value) => ({ kind, value, normalized: kind === 'email' ? value.toLowerCase() : '', label: '', primary: true });

  /** The contact the create route answers with, as far as the device can know it (the server normalizes numbers). */
  function madeContact(ctx, body) {
    const at = iso(ctx);
    const email = text(body.email).toLowerCase(), phone = text(body.phone), address = text(body.address);
    return {
      id: idOf(body), contact_kind: text(body.contact_kind) || 'human', name: nameOf(body), first_name: text(body.first_name), last_name: text(body.last_name),
      email, phone, address,
      emails: email ? [point('email', email)] : [], phones: phone ? [point('phone', phone)] : [], addresses: address ? [point('address', address)] : [],
      branch_ids: list(body.branch_ids).length ? list(body.branch_ids) : ['default'], tags: list(body.tags), time_zone: text(body.time_zone),
      custom_field_values: isObject(body.custom_field_values) ? body.custom_field_values : {}, profile_media_id: '',
      company: text(body.company), notes: text(body.notes), birthday: text(body.birthday),
      imported_at: '', import_id: '', import_source: '', merged_into: '', revision: 0, created_at: at, updated_at: at
    };
  }

  /** The fields of an edit: the route takes them under `contact`, or as the body itself. */
  const patchOf = (body) => {
    const fields = Object.assign({}, isObject(body.contact) ? body.contact : body);
    delete fields.expected_revision;
    return fields;
  };

  /** A contact with an edit applied: the single email, phone and address are also its first points. */
  function edited(contact, fields, at) {
    const next = Object.assign({}, contact, fields, { updated_at: at });
    if (!text(fields.name) && ('first_name' in fields || 'last_name' in fields)) next.name = nameOf({ first_name: next.first_name, last_name: next.last_name }) || next.name;
    for (const [field, kind, many] of [['email', 'email', 'emails'], ['phone', 'phone', 'phones'], ['address', 'address', 'addresses']]) {
      if (!(field in fields) || many in fields) continue;
      const value = text(fields[field]);
      next[many] = value ? [point(kind, kind === 'email' ? value.toLowerCase() : value), ...list(contact && contact[many]).filter((item) => item && !item.primary && text(item.value) !== value)] : list(contact && contact[many]).filter((item) => item && !item.primary);
    }
    return next;
  }

  const byName = (a, b) => nameOf(a).toLowerCase().localeCompare(nameOf(b).toLowerCase()) || text(a.id).localeCompare(text(b.id));

  /** A whole contact list (no search, no later page) shows a new contact; a filtered or later page does not. */
  const wholeList = (read) => !text(read.query.q) && !text(read.query.tag) && !text(read.query.after);

  // --- a project's contacts -----------------------------------------------------------------------------------

  /** One link of a project to a contact, as the route answers it. */
  const linkOf = (entry) => ({ id: text(entry.contact_id || entry.id), contact_id: text(entry.contact_id || entry.id), role: text(entry.role), primary: entry.primary === true });
  function linksOf(entries) {
    const links = list(entries).filter(isObject).map(linkOf).filter((link) => link.id);
    if (links.length && !links.some((link) => link.primary)) links[0].primary = true;
    return links;
  }

  /** The project's own copy of a linked contact (contacts/records.ts projection). */
  function projected(link, known) {
    const contact = known || {};
    return {
      id: link.contact_id, contact_id: link.contact_id, contact_kind: text(contact.contact_kind) || 'human', name: nameOf(contact), first_name: text(contact.first_name), last_name: text(contact.last_name),
      email: text(contact.email), phone: text(contact.phone),
      phones: list(contact.phones).map((item) => (isObject(item) ? text(item.value) : text(item))).filter(Boolean),
      emails: list(contact.emails).map((item) => (isObject(item) ? text(item.value) : text(item))).filter(Boolean),
      address: text(contact.address), default_address: text(contact.default_address || contact.address), role: link.role,
      company: text(contact.company), notes: text(contact.notes), birthday: text(contact.birthday), tags: list(contact.tags), time_zone: text(contact.time_zone),
      profile_media_id: text(contact.profile_media_id), custom_field_values: isObject(contact.custom_field_values) ? contact.custom_field_values : {},
      imported_at: text(contact.imported_at), import_id: text(contact.import_id), import_source: text(contact.import_source),
      primary: link.primary, contact_revision: Number(contact.contact_revision || contact.revision) || 0
    };
  }

  /** A project's data with its contacts replaced by `people` (the projection keys the server writes). */
  function withContacts(data, people) {
    const primary = people.find((person) => person.primary) || people[0] || null;
    return Object.assign({}, data, {
      contacts: people, contact_id: primary ? primary.contact_id : '', primary_contact_id: primary ? primary.contact_id : '', contact_ids: people.map((person) => person.contact_id),
      customer_name: primary ? primary.name : '', primary_contact_name: primary ? primary.name : '',
      customer_email: primary ? primary.email : '', primary_contact_email: primary ? primary.email : '',
      customer_phone: primary ? primary.phone : '', primary_contact_phone: primary ? primary.phone : ''
    });
  }

  /** Each linked contact as the device knows it: the entry that was sent, the project's copy, or the contact itself. */
  async function knownPeople(ctx) {
    const sent = new Map(list(ctx.body.contacts).filter(isObject).map((entry) => [text(entry.contact_id || entry.id), entry]));
    const project = await ctx.saved(projectUrl(ctx, ctx.params.project));
    const copies = new Map(list(project && project.document && project.document.data && project.document.data.contacts).map((entry) => [text(entry.contact_id || entry.id), entry]));
    const people = [];
    for (const link of linksOf(ctx.body.contacts)) {
      const record = await ctx.saved(contactUrl(ctx, link.contact_id));
      const entry = sent.get(link.contact_id) || {};
      const carried = nameOf(entry) || text(entry.email) || text(entry.phone) ? entry : null;
      people.push(projected(link, Object.assign({}, copies.get(link.contact_id), record && record.contact, carried)));
    }
    return people;
  }

  FMOffline.contracts.add({
    id: 'contacts',
    prefetch: [
      // The contacts of a pinned project, each with its own record.
      {
        url: (ctx) => projectUrl(ctx, ctx.project),
        each: (json, ctx) => list(json && json.document && json.document.data && json.document.data.contacts).map((entry) => text(entry && (entry.contact_id || entry.id))).filter(Boolean).map((id) => contactUrl(ctx, id))
      }
    ],
    writes: [
      {
        id: 'contact.create',
        match: 'POST ' + ORG + '/contacts',
        when: (ctx) => isObject(ctx.body) && !!idOf(ctx.body) && !!(nameOf(ctx.body) || text(ctx.body.email) || text(ctx.body.phone)),
        kind: 'create',
        scope: (ctx) => 'contact:' + idOf(ctx.body),
        records: (ctx) => [idOf(ctx.body)],
        label: (ctx) => (FMOffline.label('sync_contact_new', 'New contact', nameOf(ctx.body) || text(ctx.body.email) || text(ctx.body.phone))),
        respond: (ctx) => ({ ok: true, contact: madeContact(ctx, ctx.body) }),
        duplicate: (ctx, answer) => answer.status === 409 && answer.code === 'contact_exists',
        effects: (ctx) => {
          const contact = ctx.response.contact;
          return [
            { match: 'GET ' + ORG + '/contacts/:contact', when: (m) => m.contact === contact.id, seed: () => ({ ok: true, contact, reference: { contact_id: contact.id }, revision: 0, project_ids: [] }) },
            {
              match: 'GET ' + ORG + '/contacts', when: (m, read) => wholeList(read) && (!text(read.query.kind) || text(read.query.kind) === contact.contact_kind),
              apply: (json) => (json && Array.isArray(json.contacts) && !json.contacts.some((item) => item && item.id === contact.id) ? Object.assign({}, json, { contacts: [...json.contacts, contact].sort(byName) }) : json)
            }
          ];
        }
      },
      {
        id: 'contact.patch',
        match: 'PATCH ' + ORG + '/contacts/:contact',
        when: (ctx) => isObject(ctx.body) && Object.keys(patchOf(ctx.body)).length > 0,
        kind: 'patch',
        scope: (ctx) => 'contact:' + ctx.params.contact,
        records: (ctx) => [ctx.params.contact],
        label: async (ctx) => {
          const saved = await ctx.saved(contactUrl(ctx, ctx.params.contact));
          return FMOffline.label('sync_contact_edit', 'Contact change', nameOf(Object.assign({}, saved && saved.contact, patchOf(ctx.body))));
        },
        respond: async (ctx) => {
          const saved = await ctx.saved(contactUrl(ctx, ctx.params.contact));
          return { ok: true, contact: edited(Object.assign({ id: ctx.params.contact }, saved && saved.contact), patchOf(ctx.body), iso(ctx)) };
        },
        effects: (ctx) => {
          const change = (contact) => edited(contact, patchOf(ctx.body), iso(ctx));
          return [
            { match: 'GET ' + ORG + '/contacts/:contact', when: (m) => m.contact === ctx.params.contact, apply: (json) => (json && json.contact ? Object.assign({}, json, { contact: change(json.contact) }) : json) },
            { match: 'GET ' + ORG + '/contacts', apply: (json) => (json && Array.isArray(json.contacts) && json.contacts.some((item) => item && item.id === ctx.params.contact) ? Object.assign({}, json, { contacts: json.contacts.map((item) => (item && item.id === ctx.params.contact ? change(item) : item)) }) : json) }
          ];
        },
        conflict: {
          current: (ctx) => contactUrl(ctx, ctx.params.contact),
          pick: (json) => ({ doc: json && json.contact ? json.contact : null, revision: json && json.contact ? json.contact.revision : undefined }),
          fields: (ctx) => Object.keys(patchOf(ctx.body)),
          mine: (ctx, base) => Object.assign({}, base, patchOf(ctx.body)),
          send: (ctx, merged, revision) => Object.assign({ contact: merged }, revision ? { expected_revision: revision } : {})
        }
      },
      {
        // The contacts of a project, as one list of links. A link list the server changed meanwhile is merged by
        // contact; the same link changed differently on both sides is asked about.
        id: 'project.contacts',
        match: 'PUT ' + ORG + '/projects/:project/contacts',
        when: (ctx) => isObject(ctx.body) && Array.isArray(ctx.body.contacts),
        kind: 'patch',
        scope: (ctx) => 'project:' + ctx.params.project,
        records: (ctx) => [ctx.params.project],
        label: async (ctx) => (FMOffline.label('sync_project_contacts', 'Project contacts', (await knownPeople(ctx)).map((person) => person.name).filter(Boolean).join(', '))),
        respond: (ctx) => ({ ok: true, contacts: linksOf(ctx.body.contacts).map((link) => ({ contact_id: link.contact_id, role: link.role, primary: link.primary })) }),
        effects: async (ctx) => {
          const people = await knownPeople(ctx);
          const change = (document) => Object.assign({}, document, { data: withContacts(document.data, people) });
          return [
            { match: 'GET ' + ORG + '/projects/:project', when: (m) => m.project === ctx.params.project, apply: (json) => (json && json.document ? Object.assign({}, json, { document: change(json.document) }) : json) },
            { match: 'GET ' + ORG + '/projects', apply: (json) => (json && Array.isArray(json.documents) && json.documents.some((item) => item && item.id === ctx.params.project) ? Object.assign({}, json, { documents: json.documents.map((item) => (item && item.id === ctx.params.project ? change(item) : item)) }) : json) },
            ...people.map((person) => ({ match: 'GET ' + ORG + '/contacts/:contact', when: (m) => m.contact === person.contact_id, apply: (json) => (json && Array.isArray(json.project_ids) && !json.project_ids.includes(ctx.params.project) ? Object.assign({}, json, { project_ids: [...json.project_ids, ctx.params.project] }) : json) }))
          ];
        },
        conflict: {
          current: (ctx) => projectUrl(ctx, ctx.params.project),
          pick: (json) => ({ doc: { contacts: linksOf(json && json.document && json.document.data && json.document.data.contacts) }, revision: undefined }),
          fields: () => ['contacts'],
          mine: (ctx) => ({ contacts: linksOf(ctx.body.contacts) }),
          // The merged links, each with what the page sent for it. A contact that was made on this device and is
          // not sent yet goes along with its name and numbers, so the link does not depend on which is sent first.
          send: async (ctx, merged) => {
            const sent = new Map(list(ctx.body.contacts).filter(isObject).map((entry) => [text(entry.contact_id || entry.id), entry]));
            const contacts = [];
            for (const link of linksOf(merged.contacts)) {
              const entry = Object.assign({}, sent.get(link.contact_id));
              if (!nameOf(entry) && !text(entry.email) && !text(entry.phone) && (await ctx.queued(link.contact_id)).length) {
                const record = await ctx.saved(contactUrl(ctx, link.contact_id));
                const known = (record && record.contact) || {};
                for (const field of ['contact_kind', 'name', 'first_name', 'last_name', 'email', 'phone', 'address']) if (text(known[field])) entry[field] = known[field];
              }
              contacts.push(Object.assign(entry, { contact_id: link.contact_id, role: link.role, primary: link.primary }));
            }
            return { contacts };
          }
        }
      }
    ]
  });
})();
