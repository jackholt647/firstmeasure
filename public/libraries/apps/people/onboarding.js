/* public/libraries/apps/people/onboarding.js
 *
 * Outside companies: onboarding, their documents, and inviting them to link their own FirstMate organization.
 * See public/v1/connections/onboarding.ts. A company type says what onboarding a company of that type needs
 * (W-9, certificate of insurance, license, signed agreement...); each company keeps its own record in
 * metadata.onboarding, saved whole through connections.onboarding.save. Documents are media owned by the company.
 * Nothing here blocks work: a missing or expired item is a warning, in the window and in the list.
 *
 *   FirstMatePeople.onboarding.requirementsTab(typeId)   the Onboarding tab of a company type's window
 *   FirstMatePeople.onboarding.companyTab(companyId)     the Onboarding tab of a company's window
 *   FirstMatePeople.onboarding.status(company)           { state:'complete'|'attention'|'incomplete'|'none', items:[...] }
 *   FirstMatePeople.onboarding.mark(company)             the warning icon beside a company's name in lists, or null
 *   FirstMatePeople.onboarding.inviteSection(host, company, redraw)   invite them to link their organization
 */
(function(){
  'use strict';
  const People = window.FirstMatePeople = window.FirstMatePeople || {};
  if (People.onboarding) return;
  const kit = People.kit;
  const data = People.data;
  const pageKit = People.pageKit;
  const { esc, t, tip } = kit;
  const arr = (value) => Array.isArray(value) ? value : [];
  const obj = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const text = (...values) => { for (const value of values) { const clean = String(value ?? '').trim(); if (clean) return clean; } return ''; };
  const slug = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || `item_${Date.now().toString(36)}`;

  function ensureStyles(){
    People.lists?.ensureStyles?.();
    if (document.getElementById('pp_onboarding_css')) return;
    const style = document.createElement('style');
    style.id = 'pp_onboarding_css';
    style.textContent = `
      .pp-onb{display:grid;gap:14px}
      .pp-onb-list{display:grid;gap:6px;margin:0;padding:0;list-style:none}
      .pp-onb-item{display:grid;grid-template-columns:22px minmax(0,1fr) auto;gap:4px 10px;align-items:center;padding:9px 10px;border:1px solid var(--pp-line-soft);border-radius:10px;background:var(--pp-soft)}
      .pp-onb-item>i{justify-self:center;font-size:14px}
      .pp-onb-item[data-status="done"]>i{color:#16a34a}
      .pp-onb-item[data-status="missing"]>i,.pp-onb-item[data-status="expired"]>i{color:var(--pp-danger,#d92d20)}
      .pp-onb-item[data-status="expiring"]>i{color:var(--pp-warn,#b54708)}
      .pp-onb-item[data-status="optional"]>i{color:var(--pp-faint)}
      .pp-onb-name{display:grid;gap:1px;min-width:0}
      .pp-onb-name>b{font-size:13px;font-weight:650}
      .pp-onb-name>small{color:var(--pp-muted);font-size:11.5px}
      .pp-onb-tools{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}
      .pp-onb-tools input[type="date"]{width:auto;height:30px}
      .pp-onb-docs{grid-column:2/-1;display:grid;gap:4px;margin:0;padding:0;list-style:none}
      .pp-onb-doc{display:flex;align-items:center;gap:8px;min-width:0;font-size:12.5px}
      .pp-onb-doc>a{flex:1;min-width:0;overflow:hidden;color:var(--pp-text);text-overflow:ellipsis;white-space:nowrap}
      .pp-onb-doc input[type="date"]{width:auto;height:28px;font-size:12px}
      .pp-onb-file{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
      .pp-onb-empty{color:var(--pp-muted);font-size:12.5px;line-height:1.45}
      .pp-invite{display:grid;gap:10px;margin-top:18px;padding-top:14px;border-top:1px solid var(--pp-line-soft)}
      .pp-invite-state{display:flex;align-items:center;gap:8px;font-size:13px}
      .pp-invite-state small{color:var(--pp-muted);font-size:12px}
      .pp-invite-tools{display:flex;gap:8px;flex-wrap:wrap}
      [data-name-mark="onboarding-incomplete"]{color:var(--pp-danger,#d92d20)}
      [data-name-mark="onboarding-attention"]{color:var(--pp-warn,#b54708)}
      @media (max-width:640px){.pp-onb-item{grid-template-columns:22px minmax(0,1fr)}.pp-onb-tools{grid-column:2;justify-content:flex-start}}
    `;
    document.head.appendChild(style);
  }

  /* ---- reading: the same rules as connections/onboarding-contract.ts ---- */
  const KINDS = { document:() => t('onboarding_kind_document', 'Document'), date:() => t('onboarding_kind_date', 'Date'), check:() => t('onboarding_kind_check', 'Check') };
  const typeRequirements = (typeId) => arr(data.state.types.find((type) => type.kind === 'organization_connection' && String(type.id) === String(typeId))?.onboarding_requirements);
  function requirementsOf(company){
    const byId = new Map();
    data.companyTypeIds(company).forEach((typeId) => typeRequirements(typeId).forEach((requirement) => { if (!byId.has(requirement.id)) byId.set(requirement.id, { kind:'document', expires:false, required:true, ...requirement }); }));
    return [...byId.values()];
  }
  const recordOf = (company) => { const value = obj(obj(company?.metadata).onboarding); return { items:{ ...obj(value.items) }, documents:arr(value.documents).map((entry) => ({ ...entry })) }; };
  const isoDay = (date) => date.toISOString().slice(0, 10);
  function status(company, today = isoDay(new Date())){
    const requirements = requirementsOf(company);
    const record = recordOf(company);
    const soon = isoDay(new Date(Date.parse(`${today}T00:00:00Z`) + 30 * 86400000));
    const items = requirements.map((requirement) => {
      const item = obj(record.items[requirement.id]);
      const documents = record.documents.filter((entry) => entry.requirement_id === requirement.id);
      const latest = [...documents].sort((a, b) => text(b.expires_at, b.uploaded_at).localeCompare(text(a.expires_at, a.uploaded_at)))[0];
      const present = requirement.kind === 'document' ? documents.length > 0 : requirement.kind === 'date' ? !!item.date : item.done === true;
      const expiresAt = requirement.expires ? text(requirement.kind === 'document' ? text(latest?.expires_at, item.expires_at) : text(item.expires_at, item.date)) : '';
      let state = present ? 'done' : requirement.required ? 'missing' : 'optional';
      if (present && requirement.expires && expiresAt) { if (expiresAt < today) state = 'expired'; else if (expiresAt <= soon) state = 'expiring'; }
      if (present && requirement.expires && !expiresAt && requirement.kind === 'document') state = 'expiring';
      return { id:requirement.id, label:requirement.label, status:state, expires_at:expiresAt, requirement, documents };
    });
    const state = !requirements.length ? 'none' : items.some((item) => item.status === 'missing' || (item.status === 'expired' && item.requirement.required)) ? 'incomplete' : items.some((item) => item.status === 'expiring' || item.status === 'expired') ? 'attention' : 'complete';
    return { state, items };
  }
  /* The warning beside a company's name in lists. */
  function mark(company){
    if (!data.allows('companies.view')) return null;
    const result = status(company);
    const list = (states) => result.items.filter((item) => states.includes(item.status)).map((item) => item.label).join(', ');
    if (result.state === 'incomplete') return { id:'onboarding-incomplete', icon:'fa-circle-exclamation', label:t('onboarding_incomplete', 'Onboarding incomplete: {items}', { items:list(['missing', 'expired']) }) };
    if (result.state === 'attention') return { id:'onboarding-attention', icon:'fa-clock', label:t('onboarding_attention', 'Expiring soon: {items}', { items:list(['expiring', 'expired']) }) };
    return null;
  }

  /* ---- writing ---- */
  async function invokeOn(action, id, input){
    const api = window.PlatformAPI;
    try { return await api.publication.invoke(data.orgId(), action, { scope:'organization', organizationId:data.orgId(), id:String(id) }, input, { idempotencyKey:data.internal.newKey(action) }); }
    catch (error) { throw error instanceof Error ? error : new Error(text(error?.message, t('save_failed', 'Could not save'))); }
  }
  async function saveRecord(companyId, record){
    const company = data.company(companyId);
    if (!company) throw new Error(t('gone', 'This no longer exists.'));
    await invokeOn('connections.onboarding.save', companyId, { expected_revision:Number(company.revision || 1), onboarding:{ items:record.items, documents:record.documents.map((entry) => Object.fromEntries(Object.entries({ media_id:entry.media_id, requirement_id:entry.requirement_id, title:entry.title, expires_at:entry.expires_at, uploaded_at:entry.uploaded_at }).filter(([, value]) => value !== undefined && value !== ''))) } });
    await data.internal.reload({ type:'company', id:String(companyId) });
  }
  async function upload(companyId, file){
    const result = await window.PlatformAPI.media.upload(data.orgId(), file, { ownerType:'company', ownerId:String(companyId) });
    const media = obj(result?.media || result);
    if (!text(media.id)) throw new Error(t('upload_failed', 'Could not upload'));
    return media;
  }
  const fileUrl = (mediaId) => data.assetUrl(`organizations/${encodeURIComponent(data.orgId())}/media/${encodeURIComponent(mediaId)}/file`);

  /* ---- a company type's requirements ---- */
  const USUAL = () => [
    { id:'w9', label:t('onboarding_w9', 'W-9'), kind:'document', expires:false, required:true },
    { id:'insurance', label:t('onboarding_insurance', 'Certificate of insurance'), kind:'document', expires:true, required:true },
    { id:'license', label:t('onboarding_license', 'License'), kind:'document', expires:true, required:true },
    { id:'agreement', label:t('onboarding_agreement', 'Signed agreement'), kind:'document', expires:false, required:true }
  ];
  function requirementsTab(typeId){
    return { id:'onboarding', needs:'companies.view', label:t('onboarding', 'Onboarding'), icon:'fa-clipboard-check', tooltip:t('onboarding_type_tip', 'What a company of this type must provide, such as a W-9 or a certificate of insurance'), mount(panel){
      ensureStyles();
      const editable = data.allows('companies.onboarding_requirements');
      const type = () => data.state.types.find((entry) => entry.kind === 'organization_connection' && String(entry.id) === String(typeId));
      const save = (next) => data.saveType({ kind:'organization_connection', id:typeId, name:type()?.name || typeId, description:type()?.description || '', onboarding_requirements:next }).catch((error) => pageKit.failed(t('not_saved', 'Not saved'), error));
      const edit = (button, current) => kit.form(button, {
        title:current ? t('edit', 'Edit') : t('add_requirement', 'Add a requirement'), submitLabel:current ? t('save', 'Save') : t('add', 'Add'),
        fields:[
          { id:'label', label:t('name', 'Name'), value:current?.label || '', required:true },
          { id:'kind', label:t('onboarding_kind', 'Provided as'), type:'select', value:current?.kind || 'document', options:Object.entries(KINDS).map(([value, label]) => ({ value, label:label() })) },
          { id:'expires', label:t('onboarding_expires', 'Expires'), type:'select', value:current?.expires ? 'yes' : 'no', options:[{ value:'no', label:t('no', 'No') }, { value:'yes', label:t('yes_expiry', 'Yes, it has an expiry date') }] },
          { id:'required', label:t('onboarding_required', 'Needed'), type:'select', value:current?.required === false ? 'no' : 'yes', options:[{ value:'yes', label:t('required', 'Required') }, { value:'no', label:t('optional', 'Optional') }] }
        ],
        submit:async (values) => {
          const list = arr(type()?.onboarding_requirements).map((entry) => ({ ...entry }));
          const next = { id:current?.id || slug(values.label), label:String(values.label).trim(), kind:values.kind, expires:values.expires === 'yes', required:values.required !== 'no' };
          if (!current && list.some((entry) => entry.id === next.id)) next.id = `${next.id}_${list.length + 1}`;
          await data.saveType({ kind:'organization_connection', id:typeId, name:type()?.name || typeId, description:type()?.description || '', onboarding_requirements:current ? list.map((entry) => entry.id === current.id ? next : entry) : [...list, next] });
          return true;
        }
      });
      const draw = () => {
        const list = arr(type()?.onboarding_requirements);
        panel.innerHTML = `<div class="pp-onb"><div class="pp-tab-bar"><strong>${esc(kit.countPhrase([[list.length, t('requirement_one', 'requirement'), t('requirement_many', 'requirements')]]) || t('no_requirements', 'No requirements'))}</strong>${kit.info(t('onboarding_requirements_tip', 'Every company of this type is checked against these. A missing or expired item shows as a warning; it never stops work.'))}<span class="pp-spacer"></span>
          ${editable && !list.length ? `<button type="button" class="pp-btn" data-onb-usual><i class="fas fa-wand-magic-sparkles" aria-hidden="true"></i>${esc(t('onboarding_usual', 'Add the usual'))}</button>` : ''}
          ${editable ? `<button type="button" class="pp-btn primary" data-onb-add><i class="fas fa-plus" aria-hidden="true"></i>${esc(t('add_requirement', 'Add a requirement'))}</button>` : ''}</div>
          ${list.length ? `<div class="pp-types" role="list">${list.map((entry) => `<div class="pp-type" role="listitem" data-type-id="${esc(entry.id)}"><span class="pp-type-name">${esc(entry.label)}</span><div class="pp-chip-run">${kit.chip({ label:(KINDS[entry.kind] || KINDS.document)(), tone:'muted' })}${entry.expires ? kit.chip({ label:t('onboarding_expires', 'Expires'), tone:'muted', icon:'fa-clock' }) : ''}${entry.required === false ? kit.chip({ label:t('optional', 'Optional'), tone:'muted' }) : ''}</div>${editable ? `<button type="button" class="pp-icon-btn" data-onb-edit="${esc(entry.id)}" aria-label="${esc(t('edit', 'Edit'))}: ${esc(entry.label)}"${tip(t('edit', 'Edit'))}><i class="fas ${kit.ICONS.edit}" aria-hidden="true"></i></button><button type="button" class="pp-icon-btn danger" data-onb-remove="${esc(entry.id)}" aria-label="${esc(t('remove', 'Remove'))}: ${esc(entry.label)}"${tip(t('remove', 'Remove'))}><i class="fas fa-xmark" aria-hidden="true"></i></button>` : ''}</div>`).join('')}</div>`
            : `<p class="pp-onb-empty">${esc(t('onboarding_none_type', 'Companies of this type are asked for nothing yet.'))}</p>`}</div>`;
      };
      panel.addEventListener('click', (event) => {
        const button = event.target.closest('button');
        if (!button) return;
        const list = arr(type()?.onboarding_requirements);
        if (button.matches('[data-onb-add]')) edit(button, null);
        else if (button.matches('[data-onb-usual]')) save(USUAL());
        else if (button.dataset.onbEdit) edit(button, list.find((entry) => entry.id === button.dataset.onbEdit));
        else if (button.dataset.onbRemove) save(list.filter((entry) => entry.id !== button.dataset.onbRemove));
      });
      const typing = () => panel.contains(document.activeElement) && document.activeElement.matches('input,select,textarea');
      const unsubscribe = data.subscribe(() => { if (!typing()) draw(); });
      draw();
      return { refresh:draw, destroy:unsubscribe };
    } };
  }

  /* ---- a company's checklist and documents ---- */
  function companyTab(companyId){
    return { id:'onboarding', needs:'companies.view', label:t('onboarding', 'Onboarding'), icon:'fa-clipboard-check', tooltip:t('onboarding_company_tip', 'What its company types require, its documents and their expiry dates'), mount(panel){
      ensureStyles();
      const editable = data.allows('companies.onboarding');
      const company = () => data.company(companyId);
      let queue = Promise.resolve();
      let uploadFor = '';
      const change = (mutate, focus) => {
        queue = queue.then(async () => {
          const record = recordOf(company());
          mutate(record);
          try { await saveRecord(companyId, record); draw(); if (focus) panel.querySelector(focus)?.focus(); }
          catch (error) { pageKit.failed(t('not_saved', 'Not saved'), error); draw(); }
        });
        return queue;
      };
      const statusText = (item) => item.status === 'done' ? (item.expires_at ? t('onboarding_valid_until', 'Valid until {date}', { date:item.expires_at }) : t('done', 'Done'))
        : item.status === 'expiring' ? (item.expires_at ? t('onboarding_expires_on', 'Expires {date}', { date:item.expires_at }) : t('onboarding_no_expiry', 'Add the expiry date'))
        : item.status === 'expired' ? t('onboarding_expired_on', 'Expired {date}', { date:item.expires_at })
        : item.status === 'optional' ? t('optional', 'Optional') : t('missing', 'Missing');
      const ICON = { done:'fa-circle-check', missing:'fa-circle-exclamation', expired:'fa-circle-xmark', expiring:'fa-clock', optional:'fa-circle' };
      const docRow = (entry, expires) => `<li class="pp-onb-doc" data-onb-doc="${esc(entry.media_id)}"><i class="fas fa-file-lines" aria-hidden="true"></i><a href="${esc(fileUrl(entry.media_id))}" target="_blank" rel="noopener">${esc(entry.title || entry.media_id)}</a>${expires ? `<input class="pp-input" type="date" data-onb-doc-expiry="${esc(entry.media_id)}" value="${esc(entry.expires_at || '')}" aria-label="${esc(t('onboarding_expiry_of', 'Expiry date of {title}', { title:entry.title || '' }))}" ${editable ? '' : 'disabled'}>` : ''}${editable ? `<button type="button" class="pp-icon-btn danger" data-onb-doc-remove="${esc(entry.media_id)}" aria-label="${esc(t('remove', 'Remove'))}: ${esc(entry.title || '')}"${tip(t('remove', 'Remove'))}><i class="fas fa-xmark" aria-hidden="true"></i></button>` : ''}</li>`;
      function draw(){
        const current = company();
        if (!current) return;
        const result = status(current);
        const record = recordOf(current);
        const done = result.items.filter((item) => item.status === 'done' || item.status === 'expiring').length;
        const loose = record.documents.filter((entry) => !entry.requirement_id || !result.items.some((item) => item.id === entry.requirement_id));
        const stateChip = result.state === 'complete' ? kit.chip({ label:t('onboarding_complete', 'Complete'), tone:'role', icon:'fa-circle-check' }) : result.state === 'incomplete' ? kit.chip({ label:t('onboarding_incomplete_short', 'Incomplete'), tone:'danger', icon:'fa-circle-exclamation' }) : result.state === 'attention' ? kit.chip({ label:t('onboarding_attention_short', 'Expiring soon'), tone:'warn', icon:'fa-clock' }) : '';
        panel.innerHTML = `<div class="pp-onb"><div class="pp-tab-bar"><strong>${esc(result.items.length ? t('onboarding_progress', '{done} of {total} done', { done, total:result.items.length }) : t('onboarding', 'Onboarding'))}</strong>${stateChip}<span class="pp-spacer"></span>${editable ? `<button type="button" class="pp-btn" data-onb-upload=""><i class="fas fa-upload" aria-hidden="true"></i>${esc(t('upload_document', 'Upload a document'))}</button>` : ''}</div>
          ${result.items.length ? `<ul class="pp-onb-list">${result.items.map((item) => {
            const requirement = item.requirement;
            const value = obj(record.items[item.id]);
            const tools = !editable ? '' : requirement.kind === 'document'
              ? `<button type="button" class="pp-btn quiet" data-onb-upload="${esc(item.id)}"><i class="fas fa-upload" aria-hidden="true"></i>${esc(t('upload', 'Upload'))}</button>`
              : requirement.kind === 'date'
                ? `<input class="pp-input" type="date" data-onb-date="${esc(item.id)}" value="${esc(value.date || '')}" aria-label="${esc(requirement.expires ? t('onboarding_expiry_of', 'Expiry date of {title}', { title:item.label }) : item.label)}">`
                : `<button type="button" class="pp-switch" role="switch" data-onb-check="${esc(item.id)}" aria-checked="${value.done === true}" aria-label="${esc(item.label)}"></button>`;
            return `<li class="pp-onb-item" data-onb-item="${esc(item.id)}" data-status="${esc(item.status)}"><i class="fas ${ICON[item.status]}" aria-hidden="true"></i><div class="pp-onb-name"><b>${esc(item.label)}</b><small>${esc(statusText(item))}</small></div><div class="pp-onb-tools">${tools}</div>${item.documents.length ? `<ul class="pp-onb-docs">${item.documents.map((entry) => docRow(entry, requirement.expires)).join('')}</ul>` : ''}</li>`;
          }).join('')}</ul>` : `<p class="pp-onb-empty">${esc(t('onboarding_none_company', 'Its company types ask for nothing. Requirements are set on a company type.'))}</p>`}
          ${loose.length ? `<div><h5>${esc(t('other_documents', 'Other documents'))}</h5><ul class="pp-onb-docs">${loose.map((entry) => docRow(entry, true)).join('')}</ul></div>` : ''}
          <input type="file" class="pp-onb-file" data-onb-file accept="application/pdf,image/*" tabindex="-1" aria-hidden="true"></div>`;
      }
      panel.addEventListener('click', (event) => {
        const uploadButton = event.target.closest('[data-onb-upload]');
        if (uploadButton) { uploadFor = uploadButton.dataset.onbUpload; const input = panel.querySelector('[data-onb-file]'); input.value = ''; input.click(); return; }
        const check = event.target.closest('[data-onb-check]');
        if (check) { const id = check.dataset.onbCheck; change((record) => { record.items[id] = { ...obj(record.items[id]), done:check.getAttribute('aria-checked') !== 'true' }; }, `[data-onb-check="${CSS.escape(id)}"]`); return; }
        const remove = event.target.closest('[data-onb-doc-remove]');
        if (remove) change((record) => { record.documents = record.documents.filter((entry) => entry.media_id !== remove.dataset.onbDocRemove); });
      });
      panel.addEventListener('change', async (event) => {
        const file = event.target.closest('[data-onb-file]');
        if (file) {
          const chosen = file.files?.[0];
          if (!chosen) return;
          try {
            const media = await upload(companyId, chosen);
            await change((record) => { record.documents.push({ media_id:String(media.id), ...(uploadFor ? { requirement_id:uploadFor } : {}), title:text(chosen.name, media.file_name, t('document', 'Document')).slice(0, 200), uploaded_at:new Date().toISOString() }); });
            kit.toast(t('uploaded', 'Uploaded'), chosen.name, true);
          } catch (error) { pageKit.failed(t('upload_failed', 'Could not upload'), error); }
          return;
        }
        const date = event.target.closest('[data-onb-date]');
        if (date) { const id = date.dataset.onbDate; change((record) => { const next = { ...obj(record.items[id]) }; if (date.value) next.date = date.value; else delete next.date; record.items[id] = next; }, `[data-onb-date="${CSS.escape(id)}"]`); return; }
        const expiry = event.target.closest('[data-onb-doc-expiry]');
        if (expiry) { const id = expiry.dataset.onbDocExpiry; change((record) => { record.documents = record.documents.map((entry) => entry.media_id === id ? Object.fromEntries(Object.entries({ ...entry, expires_at:expiry.value || undefined }).filter(([, value]) => value !== undefined)) : entry); }, `[data-onb-doc-expiry="${CSS.escape(id)}"]`); }
      });
      const typing = () => panel.contains(document.activeElement) && document.activeElement.matches('input,select,textarea');
      const unsubscribe = data.subscribe(() => { if (!typing()) draw(); });
      draw();
      return { refresh(){ if (!typing()) draw(); }, destroy:unsubscribe };
    } };
  }

  /* ---- inviting a company to link its own FirstMate organization (collaboration partner invitations) ---- */
  const collaboration = (path, method = 'GET', body) => window.PlatformAPI.request(new URL(`/v1/collaboration/organizations/${encodeURIComponent(data.orgId())}${path}`, location.origin).href, { method, ...(body !== undefined ? { body } : {}) });
  function inviteState(company){
    const metadata = obj(company?.metadata);
    if (data.linkStatus(company) === 'linked') return { state:'linked', id:text(metadata.collaboration_invitation_id) };
    const id = text(metadata.collaboration_invitation_id);
    const state = text(metadata.collaboration_invitation_status);
    return { state:id && state === 'pending' ? 'pending' : id && state === 'revoked' ? 'revoked' : 'none', id, email:text(metadata.collaboration_invitation_email) };
  }
  async function invite(company, values){
    const created = await collaboration('/partner-invitations', 'POST', { name:values.name, email:values.email, workforce_connection_id:String(company.id) });
    const invitation = obj(created?.invitation);
    if (text(invitation.id)) await collaboration(`/invitations/${encodeURIComponent(invitation.id)}/send`, 'POST', {});
    await data.internal.reload({ type:'company', id:String(company.id) });
    return invitation;
  }
  async function resend(company){
    const { id } = inviteState(company);
    await collaboration(`/invitations/${encodeURIComponent(id)}/send`, 'POST', {});
  }
  async function revoke(company){
    const { id } = inviteState(company);
    const link = await collaboration(`/invitations/${encodeURIComponent(id)}/link`);
    await collaboration(`/invitations/${encodeURIComponent(id)}/revoke`, 'POST', { expected_revision:Number(obj(link?.invitation).revision || 1) });
    await data.internal.reload({ type:'company', id:String(company.id) });
  }
  function inviteSection(host, company){
    if (!host || !company || !data.allows('companies.invite')) return;
    ensureStyles();
    const section = document.createElement('section');
    section.className = 'pp-invite';
    section.setAttribute('data-company-invite', '');
    const contact = data.companyContact(company);
    const paint = () => {
    const { state, email } = inviteState(data.company(company.id) || company);
    const words = { linked:t('invite_linked', 'Linked to their FirstMate organization'), pending:t('invite_pending', 'Invited, waiting for them'), revoked:t('invite_revoked', 'Invitation withdrawn'), none:t('invite_none', 'Not invited') };
    section.innerHTML = `<h5>${esc(t('invite_heading', 'Their own FirstMate organization'))}</h5>
      <div class="pp-invite-state" data-invite-state="${esc(state)}"><i class="fas ${state === 'linked' ? 'fa-link' : state === 'pending' ? 'fa-paper-plane' : 'fa-link-slash'}" aria-hidden="true"></i><strong>${esc(words[state])}</strong>${email && state === 'pending' ? `<small>${esc(email)}</small>` : ''}</div>
      ${state === 'linked' ? '' : `<div class="pp-invite-tools">${state === 'pending'
        ? `<button type="button" class="pp-btn" data-invite-resend><i class="fas fa-paper-plane" aria-hidden="true"></i>${esc(t('invite_resend', 'Send again'))}</button><button type="button" class="pp-btn quiet" data-invite-revoke><i class="fas fa-ban" aria-hidden="true"></i>${esc(t('invite_revoke', 'Withdraw'))}</button>`
        : `<button type="button" class="pp-btn primary" data-invite-send><i class="fas fa-paper-plane" aria-hidden="true"></i>${esc(t('invite_send', 'Invite them to link'))}</button>`}</div>`}`;
    };
    paint();
    const unsubscribe = data.subscribe(() => { if (!section.isConnected) { unsubscribe(); return; } paint(); });
    section.addEventListener('click', async (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      const now = data.company(company.id) || company;
      if (button.matches('[data-invite-send]')) {
        kit.form(button, {
          title:t('invite_send', 'Invite them to link'), submitLabel:t('invite_send_short', 'Send invitation'),
          note:t('invite_note', 'They get an email to link their own FirstMate organization to this company, so work and messages can go to them there.'),
          fields:[{ id:'name', label:t('name', 'Name'), value:text(now.name), required:true }, { id:'email', label:t('email', 'Email'), type:'email', value:text(contact.email), required:true }],
          submit:(values) => invite(now, values)
        }).then((done) => { if (done) kit.toast(t('invite_sent', 'Invitation sent'), text(now.name), true); });
      } else if (button.matches('[data-invite-resend]')) {
        try { await resend(now); kit.toast(t('invite_sent', 'Invitation sent'), text(now.name), true); } catch (error) { pageKit.failed(t('not_sent', 'Not sent'), error); }
      } else if (button.matches('[data-invite-revoke]')) {
        if (!await kit.confirm(button, { title:t('invite_revoke_confirm', 'Withdraw the invitation to {name}?', { name:text(now.name) }), confirmLabel:t('invite_revoke', 'Withdraw'), tone:'danger' })) return;
        try { await revoke(now); } catch (error) { pageKit.failed(t('not_saved', 'Not saved'), error); }
      }
    });
    host.appendChild(section);
  }

  People.onboarding = { requirementsTab, companyTab, status, mark, inviteSection, requirementsOf, ensureStyles };
})();
