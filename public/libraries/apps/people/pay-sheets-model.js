/* public/libraries/apps/people/pay-sheets-model.js
 *
 * What the pay sheet editor knows that is not drawing: the server calls, the words each kind of work speaks in, and
 * the sheet itself as a draft that a person edits (docs/architecture/pay-sheets.md). No DOM here.
 *
 *   FirstMatePeople.paySheetModel
 *     api                         list(org), overview(org), kinds(org), save(org, payload), archive(org, id, revision), tryOn(org, projectId, body), capabilities(org, assignee), searchProjects(org, q)
 *     vocabulary(kindsResponse)   -> vocab: { kinds, kind(id), definition(id), item(id), partitions }
 *     draftOf(sheet)              a deep copy the editor may change; entries and equipment get stable `_key`s
 *     starter(assignee, kindId, vocab, assigneeName)   a new sheet with one pay line sized by the kind's main measurement
 *     payload(draft)              what the server is sent: client-only fields stripped, inputs nobody reads that this editor made dropped
 *     ensureInput(draft, source, options) -> name     the input a pay line reads, made when a line first picks what it is "per"
 *     coverRoles(draft, vocab)    Map(entry -> Map(item -> 'counts'|'adjusts')), the same rule as labor/pay-sheets.ts paySheetCoverRoles
 *     workStates(draft, vocab)    Map(item -> 'paid'|'included'|'provided'|'adjusted'), as paySheetWork
 *     coverage(draft, vocab)      the kind of work's items, each with its state ('open' when nothing accounts for it)
 *     summary(draft, vocab)       one plain sentence: what it pays, what they bring, how long a typical job takes
 *     localIssues(draft, vocab, sheets)   problems that need no server to see; same shape as server issues
 *     issueText(issue, draft, vocab)      a server message with ids replaced by the words a person knows
 *     money(cents), unitWord(unit, n), perUnit(entry, draft, vocab)
 */
(function(){
  'use strict';
  const People = window.FirstMatePeople = window.FirstMatePeople || {};
  if (People.paySheetModel) return;
  const t = (key, fallback, values) => (People.kit?.t ? People.kit.t(key, fallback, values) : String(fallback).replace(/\{(\w+)\}/g, (m, name) => (values && values[name] != null ? String(values[name]) : m)));
  const text = (value) => String(value ?? '').trim();
  const arr = (value) => (Array.isArray(value) ? value : []);
  const copy = (value) => JSON.parse(JSON.stringify(value ?? null));
  const enc = (value) => encodeURIComponent(text(value));

  /* ---- Server ---- */
  function csrf(){
    try {
      const name = text(window.__APP?.platformSessionCookieName || 'fm_platform_session');
      const found = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${encodeURIComponent(`${name}_csrf`)}=`));
      return found ? decodeURIComponent(found.split('=').slice(1).join('=')) : '';
    } catch (_) { return ''; }
  }
  /* MaterialsAPI when the page has it; the same request by hand otherwise. */
  async function request(path, options = {}){
    const materials = window.MaterialsAPI;
    if (materials?.request) return materials.request(path, options);
    const base = text(window.__APP?.materialsApiBase) || `${location.origin}/v1/materials`;
    const method = text(options.method || 'GET').toUpperCase();
    const response = await fetch(`${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`, { method, credentials:'include', cache:'no-store', headers:{ Accept:'application/json', ...(options.body ? { 'Content-Type':'application/json' } : {}), ...(method !== 'GET' && csrf() ? { 'X-Platform-CSRF':csrf() } : {}) }, ...(options.body ? { body:JSON.stringify(options.body) } : {}) });
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (_) {}
    if (!response.ok || data?.ok === false) { const error = new Error(text(data?.message || data?.error) || `Request failed (${response.status})`); error.status = response.status; error.data = data; throw error; }
    return data;
  }
  const org = (orgId) => `/organizations/${enc(orgId)}`;
  /* A read through the published data layer, the way People reads everything else; anything but ready is an error. */
  async function published(orgId, provider, name, target, args){
    const read = window.PlatformAPI?.publication?.read;
    if (typeof read !== 'function') throw new Error(t('ps_unavailable', 'This list is not available here.'));
    const result = await read.call(window.PlatformAPI.publication, orgId, { provider, export:name, target, ...(args ? { args } : {}) });
    if (result && result.status !== undefined && result.status !== 'ready') { const error = new Error(text(result.message) || t('ps_unavailable', 'This list is not available here.')); error.code = result.code; throw error; }
    return result?.value;
  }
  /* Field types a project field can hold a number in: yes/no counts as 1 or 0, as pay sheets read it. */
  const NUMERIC_FIELD_TYPES = { number:'Number', integer:'Whole number', currency:'Amount', percentage:'Percentage', slider:'Number', boolean:'Yes or no', toggle:'Yes or no', formula:'Formula' };
  const api = {
    list:(orgId) => request(`${org(orgId)}/pay-sheets`).then((result) => arr(result?.pay_sheets)),
    overview:(orgId) => request(`${org(orgId)}/pay-sheets/overview`),
    kinds:(orgId) => request(`${org(orgId)}/pay-sheets/kinds-of-work`),
    save:(orgId, payload) => (payload.id ? request(`${org(orgId)}/pay-sheets/${enc(payload.id)}`, { method:'PATCH', body:payload }) : request(`${org(orgId)}/pay-sheets`, { method:'POST', body:payload })).then((result) => result?.pay_sheet),
    archive:(orgId, id, revision) => request(`${org(orgId)}/pay-sheets/${enc(id)}`, { method:'DELETE', body:revision !== undefined ? { expected_revision:revision } : {} }),
    tryOn:(orgId, projectId, body) => request(`${org(orgId)}/projects/${enc(projectId)}/pay-sheets/try`, { method:'POST', body }),
    /* The organization's price book products, by the item type pay sheets match on (materials-inputs.products). */
    async materialChoices(orgId){
      const products = arr(await published(orgId, 'materials-inputs', 'products', { scope:'organization', organizationId:orgId }));
      const types = new Map();
      const items = products.filter((item) => text(item.id)).map((item) => ({ id:text(item.id), name:text(item.name) || text(item.id), type:text(item.type || item.category), unit:text(item.unit) }));
      for (const item of items) {
        if (!item.type) continue;
        const entry = types.get(item.type.toLowerCase()) || { type:item.type, count:0, units:new Map() };
        entry.count += 1;
        entry.units.set(item.unit, (entry.units.get(item.unit) || 0) + 1);
        types.set(item.type.toLowerCase(), entry);
      }
      return {
        types:[...types.values()].map((entry) => ({ type:entry.type, label:/^[a-z0-9_]+$/.test(entry.type) ? entry.type.replace(/_/g, " ").replace(/^./, (first) => first.toUpperCase()) : entry.type, count:entry.count, unit:[...entry.units].sort((a, b) => b[1] - a[1])[0]?.[0] || '' })).sort((a, b) => a.label.localeCompare(b.label)),
        items:items.sort((a, b) => a.name.localeCompare(b.name))
      };
    },
    /*
     * The organization's project fields that hold a number (custom-fields-project.definitions, read for the organization).
     * Where that read is not available, a project's own field contract stands in: the given project, else a recent one.
     */
    async projectFieldChoices(orgId, projectId){
      let fields;
      try { fields = arr((await published(orgId, 'custom-fields-project', 'definitions', { scope:'organization', organizationId:orgId }))?.fields); }
      catch (_) {
        let id = text(projectId);
        if (!id) id = (await api.searchProjects(orgId, ''))[0]?.id || '';
        if (!id) throw new Error(t('ps_no_projects', 'There is no project to read fields from yet.'));
        fields = arr((await published(orgId, 'custom-fields-project', 'contract', { scope:'project', organizationId:orgId, projectId:id }))?.fields);
      }
      return fields.filter((field) => NUMERIC_FIELD_TYPES[field.type] && text(field.path)).map((field) => ({ key:text(field.path), label:text(field.label || field.name) || text(field.path), type:field.type, typeLabel:NUMERIC_FIELD_TYPES[field.type] })).sort((a, b) => a.label.localeCompare(b.label));
    },
    capabilities:(orgId, assignee) => request(`${org(orgId)}/assignees/${enc(assignee.type)}/${enc(assignee.id)}/capabilities`).then((result) => result?.capabilities || null),
    async searchProjects(orgId, query){
      const search = window.PlatformAPI?.search?.projectsAndContacts;
      if (typeof search !== 'function') return [];
      const result = await search.call(window.PlatformAPI.search, orgId, { q:query, types:'projects', limit:8 });
      return arr(result?.results).filter((row) => text(row.project_id || row.id)).map((row) => ({ id:text(row.project_id || row.id), title:text(row.title) || t('untitled_project', 'Untitled project'), subtitle:text(row.subtitle) }));
    }
  };

  /* ---- Words ---- */
  const UNITS = {
    roofing_square:{ one:'square', many:'squares', short:'sq' }, ft:{ one:'foot', many:'feet', short:'ft' }, ft2:{ one:'sq ft', many:'sq ft', short:'sq ft' },
    yd3:{ one:'yd³', many:'yd³', short:'yd³' }, job:{ one:'job', many:'jobs', short:'job' }, hour:{ one:'hour', many:'hours', short:'hr' }
  };
  const unitWord = (unit, count = 2, short = false) => { const known = UNITS[text(unit)]; if (!known) return text(unit); return short ? known.short : Number(count) === 1 ? known.one : known.many; };
  const money = (cents, options = {}) => {
    const value = Number(cents || 0) / 100;
    const whole = Number.isInteger(value) && !options.cents;
    return `$${value.toLocaleString(undefined, { minimumFractionDigits:whole ? 0 : 2, maximumFractionDigits:2 })}`;
  };
  const amount = (value) => Number(value).toLocaleString(undefined, { maximumFractionDigits:2 });
  const lowerFirst = (value) => { const words = text(value); return /^[A-Z][a-z]/.test(words) ? words[0].toLowerCase() + words.slice(1) : words; };
  const joinWords = (list) => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);
  const PAY_KINDS = Object.freeze([
    { id:'piece_rate', label:t('pay_kind_piece_rate', 'Per unit'), tooltip:t('pay_kind_piece_rate_tip', 'Paid for each unit of work, such as each roof square or each bundle laid.') },
    { id:'hourly', label:t('pay_kind_hourly', 'Per hour'), tooltip:t('pay_kind_hourly_tip', 'Paid for each hour, estimated from the work or typed in for each job.') },
    { id:'flat', label:t('pay_kind_flat', 'Flat amount'), tooltip:t('pay_kind_flat_tip', 'One amount for the job.') },
    { id:'cost_rate', label:t('pay_kind_cost_rate', 'Cost of salaried time'), tooltip:t('pay_kind_cost_rate_tip', 'Hours at what this time costs the business. It shows what the job costs; nobody is paid from it, because their pay is their salary.') },
    { id:'salary', label:t('pay_kind_salary', 'Salary (not charged to jobs)'), tooltip:t('pay_kind_salary_tip', 'Recorded on the sheet and paid through payroll. It is never charged to a job.') }
  ]);
  const STATES = Object.freeze({
    paid:{ label:t('state_paid', 'Paid'), tone:'ok', icon:'fa-circle-check', tooltip:t('state_paid_tip', 'A pay line pays for this work.') },
    included:{ label:t('state_included', 'Included'), tone:'ok', icon:'fa-gift', tooltip:t('state_included_tip', 'Done as part of the job at no separate charge.') },
    provided:{ label:t('state_provided', 'Provided'), tone:'ok', icon:'fa-truck', tooltip:t('state_provided_tip', 'Equipment they bring takes care of this.') },
    adjusted:{ label:t('state_adjusted', 'Only adjusted'), tone:'warn', icon:'fa-triangle-exclamation', tooltip:t('state_adjusted_tip', 'A line changes the price of this work, but no line pays for it.') },
    open:{ label:t('state_open', 'Open'), tone:'danger', icon:'fa-circle-exclamation', tooltip:t('state_open_tip', 'Nothing on this sheet accounts for it. Someone else has to do it, or add it here.') }
  });

  /* ---- Vocabulary ---- */
  function vocabulary(response = {}){
    const kinds = arr(response.kinds);
    const definitions = new Map();
    const items = new Map();
    kinds.forEach((kind) => {
      arr(kind.measurements).forEach((entry) => { if (!definitions.has(entry.definition)) definitions.set(entry.definition, entry); });
      arr(kind.work).forEach((entry) => { if (!items.has(entry.item)) items.set(entry.item, entry); });
    });
    const partitions = arr(response.partitions);
    return {
      kinds, partitions,
      kind:(id) => kinds.find((kind) => kind.id === id) || null,
      definition:(id) => definitions.get(id) || null,
      item:(id) => items.get(id) || null,
      kindTitle:(id) => kinds.find((kind) => kind.id === id)?.title || id
    };
  }
  const baseOf = (vocab, definition) => vocab.definition(definition)?.part_of?.base || definition;
  /* The measurements in a set that between them are all of a base: the base itself, or every part of one complete partition. */
  function wholeOf(vocab, base, definitions){
    const set = new Set(definitions.filter((id) => vocab.definition(id) && baseOf(vocab, id) === base));
    if (set.has(base)) return [base];
    for (const partition of vocab.partitions) {
      if (partition.of !== base || !partition.complete) continue;
      const parts = arr(partition.parts);
      if (parts.length && parts.every((id) => set.has(id))) return parts;
    }
    return [];
  }
  const measureOf = (vocab, schemaIds, item) => { for (const id of arr(schemaIds)) { const found = arr(vocab.kind(id)?.work).find((entry) => entry.item === item); if (found) return found.measure || ''; } return ''; };
  const offeredItems = (vocab, schemaIds) => { const seen = new Map(); arr(schemaIds).forEach((id) => arr(vocab.kind(id)?.work).forEach((entry) => { if (!seen.has(entry.item)) seen.set(entry.item, entry); })); return [...seen.values()]; };
  const offeredMeasurements = (vocab, schemaIds) => { const seen = new Map(); arr(schemaIds).forEach((id) => arr(vocab.kind(id)?.measurements).forEach((entry) => { if (!seen.has(entry.definition)) seen.set(entry.definition, entry); })); return [...seen.values()]; };

  /* ---- The draft ---- */
  let serial = 0;
  const newKey = (prefix) => `${prefix}_${Date.now().toString(36)}${(serial += 1).toString(36)}`;
  function draftOf(sheet = {}){
    const draft = copy({ id:sheet.id || '', revision:sheet.revision, subject:sheet.subject || null, name:sheet.name || '', schema_ids:arr(sheet.schema_ids), inputs:arr(sheet.inputs), entries:arr(sheet.entries), equipment:arr(sheet.equipment), work:arr(sheet.work), duration:sheet.duration ?? null });
    draft.entries.forEach((entry) => { entry._key = entry.id || newKey('line'); entry.covers = arr(entry.covers); });
    draft.equipment.forEach((item) => { item._key = item.id || newKey('equipment'); item.provides = arr(item.provides); if (item.included === undefined) item.included = true; });
    draft.inputs.forEach((input) => { if (input.required === undefined) input.required = true; });
    if (!draft.id) delete draft.id;
    if (draft.revision === undefined) delete draft.revision;
    return draft;
  }
  const slug = (label) => { let name = text(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50); if (!/^[a-z]/.test(name)) name = `n_${name}`.replace(/_+$/, ''); return name || 'number'; };
  function uniqueName(draft, label){
    const base = slug(label);
    let name = base;
    for (let index = 2; draft.inputs.some((input) => input.name === name); index += 1) name = `${base}_${index}`.slice(0, 60);
    return name;
  }
  const sameSource = (a, b) => a && b && a.kind === b.kind && (a.kind === 'measurement' ? a.definition === b.definition : a.kind === 'material' ? text(a.item_id) === text(b.item_id) && text(a.item_type).toLowerCase() === text(b.item_type).toLowerCase() : a.kind === 'field' ? a.key === b.key : a.kind === 'work_hours');
  /*
   * The input a pay line reads. A measurement, a material, a field or estimated hours is one input however many lines
   * read it; a number typed per job is its own input. Made here when a line first picks it, and marked so that it goes
   * again if nothing ends up reading it.
   */
  function ensureInput(draft, source, options = {}){
    if (source.kind !== 'manual') { const found = draft.inputs.find((input) => sameSource(input.source, source)); if (found) return found.name; }
    const label = text(options.label) || t('number', 'Number');
    const name = uniqueName(draft, label);
    draft.inputs.push({ name, label, source:copy(source), required:options.required !== false, ...(options.default !== undefined ? { default:options.default } : {}), _implicit:true });
    return name;
  }
  const inputNamed = (draft, name) => draft.inputs.find((input) => input.name === name) || null;
  const referenced = (draft) => new Set([...draft.entries.flatMap((entry) => [entry.input, entry.when]), draft.duration?.input].filter(Boolean));
  function payload(draft){
    const used = referenced(draft);
    const out = {
      ...(draft.id ? { id:draft.id } : {}), subject:copy(draft.subject), name:text(draft.name), schema_ids:[...arr(draft.schema_ids)],
      inputs:draft.inputs.filter((input) => !input._implicit || used.has(input.name)).map((input) => { const { _implicit, ...rest } = input; const clean = copy(rest); if (clean.default === undefined || clean.default === null || clean.default === '') delete clean.default; if (!clean.label) delete clean.label; if (clean.source?.kind === 'measurement' && !clean.source.per_structure) delete clean.source.per_structure; return clean; }),
      entries:draft.entries.map((entry) => { const { _key, ...rest } = entry; const clean = copy(rest); ['input', 'when', 'unit', 'role', 'id'].forEach((field) => { if (!clean[field]) delete clean[field]; }); ['multiplier', 'minimum_cents'].forEach((field) => { if (clean[field] === undefined || clean[field] === null || clean[field] === '' || Number.isNaN(clean[field])) delete clean[field]; }); clean.rate_cents = Math.max(0, Math.round(Number(clean.rate_cents) || 0)); clean.covers = arr(clean.covers); return clean; }),
      equipment:draft.equipment.map((item) => { const { _key, ...rest } = item; const clean = copy(rest); if (clean.included) delete clean.rate_cents; else clean.rate_cents = Math.max(0, Math.round(Number(clean.rate_cents) || 0)); if (!clean.id) delete clean.id; if (!clean.equipment_type_id) delete clean.equipment_type_id; clean.provides = arr(clean.provides).filter((entry) => entry.item).map((entry) => ({ item:entry.item, per_load:!!entry.per_load, ...(entry.capacity !== undefined && entry.capacity !== null && entry.capacity !== '' && Number.isFinite(Number(entry.capacity)) ? { capacity:Number(entry.capacity) } : {}) })); return clean; }),
      work:draft.work.filter((entry) => entry.included || (entry.hours_per_unit !== undefined && entry.hours_per_unit !== null && entry.hours_per_unit !== '')).map((entry) => ({ item:entry.item, included:!!entry.included, ...(entry.hours_per_unit !== undefined && entry.hours_per_unit !== null && entry.hours_per_unit !== '' && Number.isFinite(Number(entry.hours_per_unit)) ? { hours_per_unit:Number(entry.hours_per_unit) } : {}) })),
      duration:draft.duration ? copy(draft.duration) : null
    };
    if (draft.id && draft.revision !== undefined) out.expected_revision = Number(draft.revision);
    return out;
  }
  /* The measurement most of a kind of work's work is sized by (roof squares for roofing), else its first required one. */
  function mainMeasure(kind){
    if (!kind) return null;
    const count = (definition) => arr(kind.work).filter((item) => item.measure === definition).length;
    const whole = arr(kind.measurements).filter((entry) => !entry.part_of && count(entry.definition) > 0).sort((a, b) => count(b.definition) - count(a.definition));
    return whole[0] || arr(kind.measurements).find((entry) => entry.required) || null;
  }
  /* A new sheet: one pay line on the kind's main measurement, paying for the work that is sized by it. */
  function starter(assignee, kindId, vocab, assigneeName = ''){
    const kind = kindId ? vocab.kind(kindId) : null;
    const draft = draftOf({ subject:assignee, name:kind ? t('starter_name', '{name} {kind} pay', { name:assigneeName || t('assignee', 'Assignee'), kind:lowerFirst(kind.title) }).trim() : t('starter_name_hourly', '{name} hourly pay', { name:assigneeName || t('assignee', 'Assignee') }).trim(), schema_ids:kind ? [kind.id] : [] });
    if (!kind) {
      const hours = ensureInput(draft, { kind:'manual' }, { label:t('hours', 'Hours'), required:true });
      draft.entries.push({ _key:newKey('line'), label:t('hourly_labor', 'Hourly labor'), kind:'hourly', unit:'hour', rate_cents:0, input:hours, covers:[] });
      return draft;
    }
    const main = mainMeasure(kind);
    const sized = main ? arr(kind.work).filter((item) => item.kind === 'work' && item.measure === main.definition) : [];
    if (main) {
      const input = ensureInput(draft, { kind:'measurement', definition:main.definition }, { label:main.label, required:true });
      draft.entries.push({ _key:newKey('line'), label:sized.length ? joinWords(sized.map((item, index) => (index ? lowerFirst(item.label) : item.label))) : main.label, kind:'piece_rate', unit:unitWord(main.unit, 1, true), rate_cents:0, input, covers:sized.map((item) => item.item) });
    }
    return draft;
  }

  /* ---- Counting and adjusting: the same rule as labor/pay-sheets.ts ---- */
  function coverRoles(draft, vocab){
    const reads = (entry) => { const source = inputNamed(draft, entry.input)?.source; return source?.kind === 'measurement' ? source.definition : ''; };
    const roles = new Map();
    for (const item of new Set(draft.entries.flatMap((entry) => arr(entry.covers)))) {
      const measure = measureOf(vocab, draft.schema_ids, item);
      const covering = draft.entries.filter((entry) => arr(entry.covers).includes(item));
      const whole = measure ? wholeOf(vocab, measure, covering.filter((entry) => !entry.role).map(reads).filter(Boolean)) : [];
      for (const entry of covering) {
        const definition = reads(entry);
        const partOfMeasure = !!measure && !!definition && baseOf(vocab, definition) === measure;
        const role = entry.role || (partOfMeasure && !whole.includes(definition) ? 'adjusts' : 'counts');
        if (!roles.has(entry)) roles.set(entry, new Map());
        roles.get(entry).set(item, role);
      }
    }
    return roles;
  }
  function workStates(draft, vocab){
    const roles = coverRoles(draft, vocab);
    const states = new Map();
    for (const entry of draft.entries) for (const [item, role] of roles.get(entry) || []) if (role === 'counts' || !states.has(item)) states.set(item, role === 'counts' ? 'paid' : 'adjusted');
    for (const entry of draft.work) if (entry.included && states.get(entry.item) !== 'paid') states.set(entry.item, 'included');
    for (const item of draft.equipment) for (const entry of arr(item.provides)) if (entry.item && (!states.has(entry.item) || states.get(entry.item) === 'adjusted')) states.set(entry.item, 'provided');
    return states;
  }
  /* Why a line adjusts rather than pays, in words, or '' when it pays. */
  function adjustReason(entry, draft, vocab){
    const roles = coverRoles(draft, vocab).get(entry);
    const adjusted = [...(roles || [])].filter(([, role]) => role === 'adjusts').map(([item]) => item);
    if (!adjusted.length) return '';
    if (entry.role === 'adjusts') return t('adjusts_declared', 'Set to only change the price of {work}. Another line has to pay for it.', { work:joinWords(adjusted.map((item) => lowerFirst(vocab.item(item)?.label || item))) });
    const source = inputNamed(draft, entry.input)?.source;
    const part = vocab.definition(source?.definition);
    const measure = measureOf(vocab, draft.schema_ids, adjusted[0]);
    return t('adjusts_reason', '{part} are part of {whole}, which is what {work} is measured in. So this line changes the price of that work instead of paying for it a second time. Another line has to pay for it.', { part:part?.label || source?.definition || '', whole:lowerFirst(vocab.definition(measure)?.label || measure), work:joinWords(adjusted.map((item) => lowerFirst(vocab.item(item)?.label || item))) });
  }
  function coverage(draft, vocab){
    const states = workStates(draft, vocab);
    return offeredItems(vocab, draft.schema_ids).map((entry) => ({ ...entry, state:states.get(entry.item) || 'open', paidBy:draft.entries.filter((line) => coverRoles(draft, vocab).get(line)?.get(entry.item) === 'counts').map((line) => line.label), providedBy:draft.equipment.filter((item) => arr(item.provides).some((provided) => provided.item === entry.item)).map((item) => item.name) }));
  }

  /* ---- Reading a line in words ---- */
  function perUnit(entry, draft, vocab){
    if (entry.kind === 'hourly' || entry.kind === 'cost_rate') return 'hr';
    if (entry.kind === 'flat') return '';
    if (entry.kind === 'salary') return '';
    if (text(entry.unit)) return text(entry.unit);
    const source = inputNamed(draft, entry.input)?.source;
    const definition = source?.kind === 'measurement' ? vocab.definition(source.definition) : null;
    return definition ? unitWord(definition.unit, 1, true) : '';
  }
  function sourceWords(source, vocab, input){
    if (!source) return '';
    if (source.kind === 'measurement') return vocab.definition(source.definition)?.label || source.definition;
    if (source.kind === 'material') return source.item_type ? t('source_material_type', '{type} on the lists', { type:source.item_type }) : t('source_material_item', '{label} on the lists (one price book item)', { label:input?.label || t('ps_an_item', 'An item') });
    if (source.kind === 'field') return t('source_field', 'Project field {field}', { field:input?.label && input.label !== source.key ? `${input.label}` : source.key });
    if (source.kind === 'work_hours') return t('source_work_hours', 'Hours estimated from the work');
    return t('source_manual', '{label}, typed for each job', { label:input?.label || t('a_number', 'A number') });
  }
  function summary(draft, vocab, options = {}){
    const roles = coverRoles(draft, vocab);
    // What pays for the work first, then what adjusts it, then extras that cover nothing in particular.
    const parts = [];
    const adjustments = [];
    const extras = [];
    const costs = [];
    for (const entry of draft.entries) {
      if (entry.kind === 'salary') { extras.push(t('summary_salary', 'a salary of {amount} paid through payroll', { amount:money(entry.rate_cents) })); continue; }
      const per = perUnit(entry, draft, vocab);
      const rate = `${money(entry.rate_cents)}${per ? `/${per}` : ''}`;
      const gate = entry.when ? inputNamed(draft, entry.when) : null;
      const minimum = entry.minimum_cents ? t('summary_minimum', ' (at least {amount})', { amount:money(entry.minimum_cents) }) : '';
      const when = gate ? t('summary_when', ' when there is {what}', { what:lowerFirst(gate.label || gate.name) }) : '';
      const adjusts = [...(roles.get(entry) || [])].some(([, role]) => role === 'adjusts') && ![...(roles.get(entry) || [])].some(([, role]) => role === 'counts');
      if (adjusts) {
        const source = inputNamed(draft, entry.input)?.source;
        const part = vocab.definition(source?.definition);
        adjustments.push(`${lowerFirst(entry.label)} ${rate}${part ? t('summary_on', ' on {what}', { what:lowerFirst(part.label) }) : ''}${minimum}${when}`);
        continue;
      }
      const bucket = arr(entry.covers).length ? parts : extras;
      if (entry.kind === 'cost_rate') { costs.push(t('summary_cost_rate', 'salaried time costs {rate} (not paid out)', { rate })); continue; }
      if (entry.kind === 'flat') bucket.push(`${money(entry.rate_cents)} ${t('summary_flat', 'for')} ${lowerFirst(entry.label)}${when}`);
      else bucket.push(`${rate} ${t('summary_for', 'for')} ${lowerFirst(entry.label)}${minimum}${when}`);
    }
    const all = [...parts, ...adjustments, ...extras];
    const paid = all.length ? `${t('summary_pays', 'Pays')} ${all.length > 3 ? `${all.slice(0, 3).join(', ')} ${t('summary_more', 'and {count} more', { count:all.length - 3 })}` : joinWords(all)}` : '';
    // Salaried time is a cost of the job, not pay: it is said on its own.
    const costed = costs.length ? (paid ? costs.join(', ') : costs.join(', ').replace(/^./, (first) => first.toUpperCase())) : '';
    const pays = [paid, costed].filter(Boolean).join(', ') || t('summary_nothing', 'No pay lines yet');
    const article = (name) => (/^(a|an|the|their|his|her|its|our|two|three|\d)\b/i.test(name) ? name : `${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name}`);
    const brings = draft.equipment.filter((item) => text(item.name)).map((item) => {
      const provided = arr(item.provides)[0];
      const unit = provided ? vocab.item(provided.item)?.unit : '';
      const size = provided && provided.capacity ? ` (${amount(provided.capacity)} ${unitWord(unit, provided.capacity, true)}${provided.per_load ? t('summary_per_load', '/load') : ''})` : '';
      return item.included ? `${article(lowerFirst(item.name))}${size}` : `${article(lowerFirst(item.name))}${size} ${t('summary_for_charge', 'for {amount}', { amount:money(item.rate_cents) })}`;
    });
    const days = typicalDays(draft, vocab);
    const pieces = [pays, brings.length ? t('summary_brings', 'brings {what}', { what:joinWords(brings) }) : '', days ? days.text : ''].filter(Boolean);
    return options.parts ? { pays, brings, days } : `${pieces.join(', ')}.`.replace(/\.\.$/, '.');
  }
  /* About how many days a typical job takes: 30 squares, 150 feet, one job. Null when it cannot be said. */
  const SAMPLES = { roofing_square:30, ft:150, ft2:1500, job:1 };
  function sampleWords(unit, size){ return unit === 'roofing_square' ? t('sample_roof', 'a {size}-square roof', { size }) : unit === 'job' ? t('sample_job', 'a job') : t('sample_amount', '{size} {unit}', { size:amount(size), unit:unitWord(unit, size) }); }
  function typicalDays(draft, vocab){
    const duration = draft.duration;
    if (!duration) return null;
    const half = (value) => Math.ceil(value * 2) / 2;
    if (duration.input) {
      const source = inputNamed(draft, duration.input)?.source;
      const definition = source?.kind === 'measurement' ? vocab.definition(source.definition) : null;
      const size = definition ? SAMPLES[definition.unit] : null;
      if (!size || !(Number(duration.units_per_day) > 0)) return null;
      const days = half(size / Number(duration.units_per_day));
      return { days, size, unit:definition.unit, text:t('summary_days', '~{days} for {sample}', { days:dayWords(days), sample:sampleWords(definition.unit, size) }) };
    }
    if (duration.hours_per_day) {
      const items = offeredItems(vocab, draft.schema_ids);
      const main = items.find((item) => item.unit === 'roofing_square') ? 'roofing_square' : '';
      if (!main) return null;
      let hours = 0;
      for (const entry of draft.work) {
        const item = items.find((candidate) => candidate.item === entry.item);
        const per = Number(entry.hours_per_unit);
        if (!item || !Number.isFinite(per)) continue;
        if (item.unit === 'roofing_square') hours += per * SAMPLES.roofing_square;
        else if (item.unit === 'job') hours += per;
      }
      if (!hours) return null;
      const days = half(hours / Number(duration.hours_per_day));
      return { days, size:SAMPLES.roofing_square, unit:main, hours, text:t('summary_days', '~{days} for {sample}', { days:dayWords(days), sample:sampleWords(main, SAMPLES.roofing_square) }) };
    }
    return null;
  }
  const dayWords = (days) => (Number(days) === 1 ? t('one_day', '1 day') : t('n_days', '{n} days', { n:amount(days) }));

  /* ---- Problems ---- */
  function localIssues(draft, vocab, sheets = []){
    const issues = [];
    const add = (path, message) => issues.push({ path, message, local:true });
    if (!text(draft.name)) add(['name'], t('issue_name', 'Give the sheet a name.'));
    const offered = new Set(offeredMeasurements(vocab, draft.schema_ids).map((entry) => entry.definition));
    draft.inputs.forEach((input, index) => {
      if (input.source?.kind === 'measurement' && referenced(draft).has(input.name) && !offered.has(input.source.definition)) add(['inputs', index, 'source', 'definition'], draft.schema_ids.length ? t('issue_not_in_kind', '{what} is not something {kind} measures.', { what:vocab.definition(input.source.definition)?.label || input.source.definition, kind:vocab.kindTitle(draft.schema_ids[0]) }) : t('issue_needs_kind', '{what} is a measurement, so choose the kind of work first.', { what:input.label || input.name }));
      if (input.source?.kind === 'material' && !text(input.source.item_type) && !text(input.source.item_id)) add(['inputs', index, 'source'], t('issue_material', 'Say which item type on the lists this counts.'));
      if (input.source?.kind === 'field' && !text(input.source.key)) add(['inputs', index, 'source'], t('issue_field', 'Say which project field this reads.'));
    });
    draft.entries.forEach((entry, index) => {
      if (!text(entry.label)) add(['entries', index, 'label'], t('issue_label', 'Say what this line is for.'));
      if ((entry.kind === 'piece_rate' || entry.kind === 'hourly' || entry.kind === 'cost_rate') && !entry.input) add(['entries', index, 'input'], t('issue_per', 'Choose what this line is paid per.'));
      if (!(Number(entry.rate_cents) >= 0) || !Number.isFinite(Number(entry.rate_cents))) add(['entries', index, 'rate_cents'], t('issue_rate', 'Enter an amount.'));
    });
    draft.equipment.forEach((item, index) => { if (!text(item.name)) add(['equipment', index, 'name'], t('issue_equipment_name', 'Name the equipment.')); });
    if (draft.subject) {
      const mine = sheets.filter((sheet) => sheet.id !== draft.id && sheet.subject?.type === draft.subject.type && sheet.subject?.id === draft.subject.id);
      const clash = draft.schema_ids.length ? mine.find((sheet) => arr(sheet.schema_ids).some((id) => draft.schema_ids.includes(id))) : mine.find((sheet) => !arr(sheet.schema_ids).length);
      if (clash) add(['schema_ids'], draft.schema_ids.length ? t('issue_overlap', '{name} already prices {kind} for this assignee.', { name:clash.name, kind:lowerFirst(vocab.kindTitle(draft.schema_ids[0])) }) : t('issue_overlap_none', '{name} already prices work that names no kind of work.', { name:clash.name }));
    }
    const hoursInput = draft.inputs.some((input) => input.source?.kind === 'work_hours' && referenced(draft).has(input.name));
    const anyHours = draft.work.some((entry) => entry.hours_per_unit !== undefined && entry.hours_per_unit !== null && entry.hours_per_unit !== '');
    if (hoursInput && !anyHours) add(['work'], t('issue_hours', 'Hours are estimated from the work, so give at least one piece of work its hours.'));
    if (draft.duration?.hours_per_day && !anyHours) add(['duration', 'hours_per_day'], t('issue_duration_hours', 'Give at least one piece of work its hours, so days can be worked out.'));
    if (draft.duration && 'input' in draft.duration && !draft.duration.input) add(['duration', 'input'], t('issue_duration_input', 'Choose what is counted per day.'));
    return issues;
  }
  /* Server words with the ids a person never sees put back into the words they know. */
  function issueText(issue, draft, vocab){
    let message = text(issue?.message);
    const swaps = [];
    vocab.kinds.forEach((kind) => { swaps.push([kind.id, kind.title]); arr(kind.measurements).forEach((entry) => swaps.push([entry.definition, entry.label])); arr(kind.work).forEach((entry) => swaps.push([entry.item, entry.label])); });
    draft.inputs.forEach((input) => swaps.push([input.name, input.label || input.name]));
    swaps.sort((a, b) => b[0].length - a[0].length).forEach(([id, label]) => { if (id && id !== label) message = message.replace(new RegExp(`(^|[^A-Za-z0-9_.])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'g'), `$1${label}`); });
    return message
      .replace(/^Piece rate (.+) needs the input it is paid on\.$/, (m, label) => t('issue_per_named', '{label} needs what it is paid per.', { label }))
      .replace(/^Entry (.+) reads (.+), which is not a declared input\.$/, (m, label, what) => t('issue_reads_named', '{label} reads {what}, which this sheet does not have.', { label, what }))
      .replace(/is not something (.+) requires\./, (m, kind) => t('issue_not_required', 'is not part of {kind} work.', { kind:lowerFirst(kind) }))
      .replace(/^There is no measurement schema called (.+)\.$/, (m, kind) => t('issue_no_kind', 'There is no kind of work called {kind}.', { kind }));
  }

  People.paySheetModel = {
    api, request, vocabulary, draftOf, starter, mainMeasure, payload, ensureInput, inputNamed, referenced, sameSource, newKey,
    coverRoles, workStates, coverage, adjustReason, summary, typicalDays, localIssues, issueText, perUnit, sourceWords,
    offeredItems, offeredMeasurements, measureOf, baseOf,
    money, amount, unitWord, lowerFirst, joinWords, dayWords, PAY_KINDS, STATES, UNITS
  };
})();
