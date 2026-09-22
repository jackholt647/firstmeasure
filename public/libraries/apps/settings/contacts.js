/* public/libraries/apps/settings/contacts.js
 * Contacts settings: mass contact import (vCard / CSV) and import history.
 * Mounted by company settings as window.FirstMateContactsSettings.mount(host, options).
 */
(function(root){
  'use strict';

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const text = (...values) => String(values.find((value) => value != null && String(value).trim()) ?? '').trim();
  const array = (value) => Array.isArray(value) ? value : [];
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

  const MAPPING_FIELD_LABELS = {
    name: 'Full name', first_name: 'First name', middle_name: 'Middle name', last_name: 'Last name',
    email: 'Email', phone: 'Phone', address: 'Address (full)', street: 'Street', city: 'City',
    state: 'State / region', postal_code: 'Postal code', country: 'Country', company: 'Company',
    notes: 'Notes', birthday: 'Birthday', tags: 'Tags / groups', ignore: 'Do not import'
  };

  function dateLabel(value){
    const ms = Date.parse(text(value));
    return Number.isFinite(ms)
      ? new Date(ms).toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' })
      : '';
  }

  function injectCss(){
    if (document.getElementById('fmContactsSettingsCss')) return;
    const style = document.createElement('style');
    style.id = 'fmContactsSettingsCss';
    style.textContent = `
      .cti-page{color:#17212b;min-height:640px}.cti-page *{box-sizing:border-box}
      .cti-subtabs{display:flex;gap:4px;border-bottom:1px solid #e3e7ec;margin:-4px 0 22px}.cti-subtab{appearance:none;border:0;border-bottom:3px solid transparent;background:transparent;padding:11px 14px 10px;font:900 13px/1 inherit;color:#697586;cursor:pointer}.cti-subtab.active{color:#18222d;border-bottom-color:var(--primary-readable,var(--primary,#d93025))}
      .cti-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:18px}.cti-kicker{margin-bottom:5px;color:#667085;font-size:10px;font-weight:950;letter-spacing:.08em;text-transform:uppercase}.cti-head h3{margin:0;font-size:24px;line-height:1.15;letter-spacing:-.02em}.cti-head p{max-width:720px;margin:6px 0 0;color:#667085;font-size:12px;line-height:1.5}
      .cti-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
      .cti-btn{appearance:none;border:1px solid #d6dce3;background:#fff;color:#263442;border-radius:7px;padding:9px 12px;font:900 12px/1 inherit;cursor:pointer;display:inline-flex;align-items:center;gap:7px}.cti-btn:hover{background:#f7f9fb}.cti-btn.primary{border-color:var(--primary-readable,var(--primary,#d93025));background:var(--primary-readable,var(--primary,#d93025));color:#fff}.cti-btn.primary:hover{filter:brightness(.97);background:var(--primary-readable,var(--primary,#d93025))}.cti-btn.danger{color:#b42318}.cti-btn:disabled{opacity:.55;cursor:not-allowed}
      .cti-block{border:1px solid #dde2e8;border-radius:11px;background:#fff;padding:18px;margin-bottom:14px}.cti-block h4{font-size:15px;margin:0 0 5px}.cti-block>p{font-size:12px;color:#697586;margin:0 0 13px;line-height:1.45}
      .cti-drop{border:2px dashed #ccd4dd;border-radius:12px;background:#fbfcfd;padding:40px 24px;text-align:center;cursor:pointer;transition:border-color .14s ease,background .14s ease}
      .cti-drop:hover,.cti-drop.dragging{border-color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),.03)}
      .cti-drop i{font-size:26px;color:#98a2b3}.cti-drop strong{display:block;margin-top:10px;font-size:14px;color:#344054}.cti-drop span{display:block;margin-top:5px;font-size:11.5px;color:#697586}
      .cti-formats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin-top:14px}
      .cti-format{border:1px solid #e4e7ec;border-radius:9px;background:#fff;padding:12px;display:flex;gap:10px;align-items:flex-start}
      .cti-format i{color:#667085;margin-top:2px}.cti-format strong{display:block;font-size:12px;color:#344054}.cti-format span{display:block;margin-top:3px;font-size:10.5px;line-height:1.4;color:#697586}
      .cti-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;margin-bottom:14px}
      .cti-stat{position:relative;overflow:hidden;border:1px solid #e4e7ec;border-radius:11px;background:#fff;padding:13px 14px}.cti-stat:before{content:'';position:absolute;inset:0 auto 0 0;width:3px;background:#98a2b3}.cti-stat.new:before{background:#12b76a}.cti-stat.duplicate:before{background:#f79009}.cti-stat.invalid:before{background:#d92d20}
      .cti-stat span{display:block;color:#667085;font-size:10px;font-weight:850}.cti-stat strong{display:block;margin-top:5px;font-size:22px;line-height:1;font-weight:950;font-variant-numeric:tabular-nums}
      .cti-field{display:grid;gap:6px;min-width:0}.cti-field>span{font-size:11px;font-weight:950;color:#526171}
      .cti-input,.cti-select{width:100%;border:1px solid #ccd4dd;border-radius:7px;background:#fff;color:#18222d;padding:9px 10px;font:800 12.5px/1.3 inherit;outline:none}
      .cti-input:focus,.cti-select:focus{border-color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 0 0 2px rgba(var(--primary-rgb,217,48,37),.11)}
      .cti-option-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}
      .cti-option{appearance:none;border:1px solid #d6dce3;border-radius:9px;background:#fff;padding:12px;text-align:left;display:flex;flex-direction:column;gap:4px;cursor:pointer;color:#263442}
      .cti-option strong{font-size:12px}.cti-option span{font-size:10.5px;line-height:1.35;color:#697586}
      .cti-option.active{border-color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),.05);box-shadow:0 0 0 2px rgba(var(--primary-rgb,217,48,37),.10)}
      .cti-option.active strong{color:var(--primary-readable,var(--primary,#d93025))}
      .cti-tag-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
      .cti-tag{display:inline-flex;align-items:center;gap:6px;border:1px solid #e4e7ec;border-radius:999px;background:#f8fafc;color:#344054;font-size:11px;font-weight:900;padding:5px 10px;line-height:1.2}
      .cti-tag button{border:0;background:none;color:#98a2b3;cursor:pointer;padding:0;display:inline-flex;font-size:10px}.cti-tag button:hover{color:#b42318}
      .cti-tag-input{border:1px dashed #ccd4dd;border-radius:999px;background:#fff;min-width:120px;font:900 11px/1.2 inherit;color:#18222d;padding:5px 11px;outline:none}
      .cti-tag-input:focus{border-color:var(--primary-readable,var(--primary,#d93025))}
      .cti-tag-suggest{border:1px dashed #ccd4dd;border-radius:999px;background:#fff;color:#697586;font:900 11px/1.2 inherit;padding:5px 10px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
      .cti-tag-suggest:hover{color:var(--primary-readable,var(--primary,#d93025));border-color:var(--primary-readable,var(--primary,#d93025))}
      .cti-map-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:9px}
      .cti-map-row{border:1px solid #e4e7ec;border-radius:8px;background:#fbfcfd;padding:9px;display:grid;gap:6px}
      .cti-map-row>strong{font-size:11px;color:#344054;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .cti-table-wrap{border:1px solid #e5e7eb;border-radius:9px;overflow:auto;max-height:380px}
      .cti-table{width:100%;border-collapse:collapse;font-size:12px}
      .cti-table th{position:sticky;top:0;background:#f9fafb;border-bottom:1px solid #e5e7eb;padding:8px 10px;text-align:left;color:#667085;font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap}
      .cti-table td{border-bottom:1px solid #f0f2f5;padding:8px 10px;color:#344054;font-weight:800;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .cti-table tr:last-child td{border-bottom:0}
      .cti-badge{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:3px 9px;font-size:10px;font-weight:950}
      .cti-badge.new{background:#ecfdf3;color:#067647}.cti-badge.duplicate{background:#fffaeb;color:#b54708}.cti-badge.invalid{background:#fef3f2;color:#b42318}
      .cti-badge.committed{background:#ecfdf3;color:#067647}.cti-badge.pending{background:#eff8ff;color:#175cd3}.cti-badge.undone{background:#f2f4f7;color:#475467}
      .cti-warnings{display:grid;gap:6px;margin-bottom:13px}
      .cti-warning{border:1px solid #fedf89;border-radius:8px;background:#fffcf5;padding:9px 11px;color:#b54708;font-size:11px;font-weight:850}
      .cti-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:4px}
      .cti-status{font-size:12px;font-weight:850;color:#697586;min-height:16px}
      .cti-history-row{display:grid;grid-template-columns:minmax(220px,1.4fr) minmax(160px,1fr) minmax(150px,1fr) auto;gap:12px;align-items:center;border:1px solid #e4e7ec;border-radius:10px;background:#fff;padding:13px 14px;margin-bottom:8px}
      .cti-history-main strong{display:block;font-size:13px;color:#101828}
      .cti-history-main span{display:block;margin-top:3px;font-size:11px;color:#667085;font-weight:800}
      .cti-history-counts{font-size:11.5px;font-weight:850;color:#475467;line-height:1.5}
      .cti-empty{padding:26px;text-align:center;color:#7b8794;font-size:12px;border:1px dashed #ccd4dd;border-radius:9px}
      .cti-loading{display:grid;place-items:center;min-height:280px;color:#667085;font-size:12px;font-weight:850}
      .cti-error{border:1px solid #fecdca;border-radius:10px;background:#fef3f2;padding:12px;color:#b42318;font-size:11px;font-weight:850}
      .cti-done{display:grid;place-items:center;text-align:center;padding:44px 20px}
      .cti-done i{font-size:34px;color:#12b76a}.cti-done h4{margin:14px 0 4px;font-size:18px}.cti-done p{margin:0 0 18px;color:#667085;font-size:12.5px}
      @media(max-width:900px){.cti-formats,.cti-option-grid{grid-template-columns:1fr}.cti-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.cti-history-row{grid-template-columns:1fr;align-items:stretch}.cti-history-row .cti-actions{justify-content:flex-start}}
    `;
    document.head.appendChild(style);
  }

  function mount(host, options = {}){
    if (!host || host.dataset.contactsMounted === '1') return;
    host.dataset.contactsMounted = '1';
    injectCss();
    const orgId = options.orgId;
    const toast = options.showToast || (() => {});
    const api = root.PlatformAPI?.contactImports;
    const routeScope = options.routeScope === 'contacts' ? 'contacts' : 'company_settings';
    const routeViewKey = routeScope === 'contacts' ? 'contactsSettingsView' : 'settingsView';
    const routedView = String(root.Portal?.navigation?.read?.()?.[routeViewKey] || options.initialSubtab || '').trim();
    const state = {
      subtab: ['import','history'].includes(routedView) ? routedView : 'import',
      step: 'upload',
      file: null,
      preview: null,
      mappingDraft: null,
      tags: [],
      duplicateAction: 'skip',
      busy: false,
      status: '',
      commitResult: null,
      imports: [],
      historyLoaded: false,
      historyLoading: false,
      historyError: ''
    };

    host.innerHTML = '<div class="cti-page"></div>';
    const page = host.querySelector('.cti-page');

    function setSubtab(next, opts = {}){
      const value = ['import','history'].includes(next) ? next : 'import';
      state.subtab = value;
      if (opts.updateRoute !== false && !root.Portal?.navigation?.applying) {
        const patch = routeScope === 'contacts'
          ? { tab:'contacts', contactsWorkspace:options.workspace || 'settings', contactsSettingsView:value }
          : { tab:'company_settings', sub:'contacts', settingsView:value, settingsEntity:'' };
        root.Portal?.navigation?.push?.(patch, { source:'contacts-settings-view', ownedKeys:[routeViewKey] });
      }
      render();
    }

    function subTabs(){
      return `<div class="cti-subtabs">${[['import','Import contacts'],['history','Import history']].map(([id,label]) => `<button class="cti-subtab ${state.subtab===id?'active':''}" data-cti-subtab="${id}" type="button">${esc(label)}</button>`).join('')}</div>`;
    }
    function bindSubTabs(){
      host.querySelectorAll('[data-cti-subtab]').forEach((button) => button.addEventListener('click', () => setSubtab(button.dataset.ctiSubtab)));
    }

    function setStatus(message){
      state.status = message || '';
      const status = host.querySelector('[data-cti-status]');
      if (status) status.textContent = state.status;
    }

    // ------------------------------------------------------------------ upload

    async function handleFile(file){
      if (!file || state.busy) return;
      if (!api?.preview) {
        toast((globalThis.PlatformLanguage?.text("settings","m_bbf2b4e48b69c0","Import unavailable") ?? "Import unavailable"), (globalThis.PlatformLanguage?.text("settings","m_b7c4c76a03f928","The contact import API is not available in this session.") ?? "The contact import API is not available in this session."), false);
        return;
      }
      state.busy = true;
      state.file = file;
      render();
      try {
        state.preview = await api.preview(orgId, file);
        state.mappingDraft = { ...object(state.preview.mapping) };
        state.step = 'preview';
        state.duplicateAction = 'skip';
        state.commitResult = null;
      } catch (error) {
        const details = object(error?.data?.details);
        toast((globalThis.PlatformLanguage?.text("settings","m_dd1bae6fa76896","Could not read the file") ?? "Could not read the file"), error?.message || 'The file could not be parsed.', false);
        if (array(details.warnings).length) state.status = array(details.warnings).join(' ');
        state.file = null;
      } finally {
        state.busy = false;
        render();
      }
    }

    async function rerunPreview(){
      if (!state.file || state.busy) return;
      state.busy = true;
      setStatus('Re-reading the file with the updated mapping...');
      const previous = state.preview;
      try {
        // Discard the superseded pending preview so it does not pile up in history.
        if (previous?.import_id) await api.discard(orgId, previous.import_id).catch(() => null);
        state.preview = await api.preview(orgId, state.file, { mapping: state.mappingDraft || {} });
        state.mappingDraft = { ...object(state.preview.mapping) };
        setStatus('');
      } catch (error) {
        toast((globalThis.PlatformLanguage?.text("settings","m_c8a554315bb49c","Mapping failed") ?? "Mapping failed"), error?.message || 'The columns could not be re-mapped.', false);
      } finally {
        state.busy = false;
        render();
      }
    }

    async function discardPreview(){
      const importId = state.preview?.import_id;
      if (importId) await api.discard(orgId, importId).catch(() => null);
      state.step = 'upload';
      state.file = null;
      state.preview = null;
      state.mappingDraft = null;
      state.tags = [];
      state.commitResult = null;
      render();
    }

    // ------------------------------------------------------------------- tags

    function addTag(value){
      const tag = text(value).replace(/\s+/g, ' ').slice(0, 80);
      if (!tag || state.tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) return;
      state.tags = [...state.tags, tag];
      render();
      host.querySelector('[data-cti-tag-input]')?.focus();
    }
    function removeTag(tag){
      state.tags = state.tags.filter((existing) => existing !== tag);
      render();
    }

    // ------------------------------------------------------------------ commit

    async function commitImport(){
      if (!state.preview?.import_id || state.busy) return;
      state.busy = true;
      setStatus('Importing contacts... This can take a moment for large books.');
      render();
      try {
        state.commitResult = await api.commit(orgId, state.preview.import_id, {
          tags: state.tags,
          duplicateAction: state.duplicateAction
        });
        state.step = 'done';
        state.historyLoaded = false;
        toast((globalThis.PlatformLanguage?.text("settings","m_fe965f26decf0a","Contacts imported") ?? "Contacts imported"), ((v0) => globalThis.PlatformLanguage?.text("settings","m_0081c49ea5fa05",`${v0} contacts were created.`,{v0}) ?? `${v0} contacts were created.`)(Number(state.commitResult?.counts?.created || 0)), true);
        root.dispatchEvent(new CustomEvent('fm:projects:refresh', { detail: { redraw: true } }));
      } catch (error) {
        toast((globalThis.PlatformLanguage?.text("settings","m_af4a70201dbeb1","Import failed") ?? "Import failed"), error?.message || 'The import could not be committed.', false);
      } finally {
        state.busy = false;
        setStatus('');
        render();
      }
    }

    // ----------------------------------------------------------------- markup

    function uploadMarkup(){
      return `
        <div class="cti-head">
          <div>
            <div class="cti-kicker">${(globalThis.PlatformLanguage?.text("settings","m_f652711330f9fa","Contacts · Import") ?? "Contacts · Import")}</div>
            <h3>${(globalThis.PlatformLanguage?.text("settings","m_dd7c09f845edda","Import contacts") ?? "Import contacts")}</h3>
            <p>${(globalThis.PlatformLanguage?.text("settings","m_3a5c4099f28772","Bring an entire contact book into FirstMate. Drop in an export from any major contacts app — duplicates are detected before anything is written, and every import can be undone.") ?? "Bring an entire contact book into FirstMate. Drop in an export from any major contacts app — duplicates are detected before anything is written, and every import can be undone.")}</p>
          </div>
        </div>
        <div class="cti-block">
          <div class="cti-drop" data-cti-drop role="button" tabindex="0" aria-label="${(globalThis.PlatformLanguage?.text("settings","m_b57aeb22381727","Choose a contact file") ?? "Choose a contact file")}">
            <i class="fas fa-file-import"></i>
            <strong>${String(state.busy ? 'Reading file...' : 'Drop a contact file here, or click to browse')}</strong>
            <span>${(globalThis.PlatformLanguage?.text("settings","m_875b636e51160c",".vcf (vCard), .csv, or .tsv · up to 25,000 contacts per file") ?? ".vcf (vCard), .csv, or .tsv · up to 25,000 contacts per file")}</span>
            <input type="file" data-cti-file accept=".vcf,.csv,.tsv,.txt,text/vcard,text/csv,text/plain" hidden>
          </div>
          <div class="cti-formats">
            <div class="cti-format"><i class="fab fa-apple"></i><div><strong>${(globalThis.PlatformLanguage?.text("settings","m_bcb79a20aeb319","Apple Contacts") ?? "Apple Contacts")}</strong><span>${(globalThis.PlatformLanguage?.text("settings","m_9f5e0b71577398","Select contacts, then File &gt; Export &gt; Export vCard (.vcf).") ?? "Select contacts, then File &gt; Export &gt; Export vCard (.vcf).")}</span></div></div>
            <div class="cti-format"><i class="fab fa-google"></i><div><strong>${(globalThis.PlatformLanguage?.text("settings","m_56fadcddead076","Google Contacts") ?? "Google Contacts")}</strong><span>${(globalThis.PlatformLanguage?.text("settings","m_2cf379758e466f","Export as Google CSV or vCard from contacts.google.com.") ?? "Export as Google CSV or vCard from contacts.google.com.")}</span></div></div>
            <div class="cti-format"><i class="fas fa-envelope"></i><div><strong>${(globalThis.PlatformLanguage?.text("settings","m_e956f072a7a2a7","Outlook &amp; everything else") ?? "Outlook &amp; everything else")}</strong><span>${(globalThis.PlatformLanguage?.text("settings","m_70443ebd875827","Outlook CSV, Yahoo CSV, or any spreadsheet with name, email, and phone columns.") ?? "Outlook CSV, Yahoo CSV, or any spreadsheet with name, email, and phone columns.")}</span></div></div>
          </div>
        </div>
        ${String(state.status ? `<div class="cti-warnings"><div class="cti-warning">${esc(state.status)}</div></div>` : '')}
      `;
    }

    function mappingMarkup(){
      const preview = state.preview;
      if (preview.format !== 'csv' || !array(preview.headers).length) return '';
      const fields = array(preview.mapping_fields).length ? preview.mapping_fields : Object.keys(MAPPING_FIELD_LABELS);
      return `
        <div class="cti-block">
          <h4>${(globalThis.PlatformLanguage?.text("settings","m_a5b45045826851","Column mapping") ?? "Column mapping")}</h4>
          <p>${(globalThis.PlatformLanguage?.text("settings","m_101cc692b62f6e","Columns were matched automatically. Adjust any that were missed, then re-run the preview.") ?? "Columns were matched automatically. Adjust any that were missed, then re-run the preview.")}</p>
          <div class="cti-map-grid">
            ${String(preview.headers.map((header, index) => `
              <label class="cti-map-row">
                <strong title="${esc(header)}">${esc(header || `Column ${index + 1}`)}</strong>
                <select class="cti-select" data-cti-map="${index}">
                  ${fields.map((field) => `<option value="${esc(field)}" ${text(state.mappingDraft?.[String(index)]) === field ? 'selected' : ''}>${esc(MAPPING_FIELD_LABELS[field] || field)}</option>`).join('')}
                </select>
              </label>
            `).join(''))}
          </div>
          <div class="cti-footer">
            <span></span>
            <button class="cti-btn" type="button" data-cti-remap ${String(state.busy ? 'disabled' : '')}><i class="fas fa-rotate"></i>${(globalThis.PlatformLanguage?.text("settings","m_2ff538bc47e4ef"," Re-run preview with this mapping") ?? " Re-run preview with this mapping")}</button>
          </div>
        </div>
      `;
    }

    function previewMarkup(){
      const preview = state.preview;
      const summary = object(preview.summary);
      const rows = array(preview.rows);
      const sample = rows.slice(0, 15);
      const duplicateOptions = [
        ['skip', 'Skip duplicates', 'Leave existing contacts untouched. Recommended.'],
        ['update', 'Update existing', 'Fill blank fields on the matched contact and add the tags below.'],
        ['create', 'Import anyway', 'Create separate new contacts even when a match exists.']
      ];
      return `
        <div class="cti-head">
          <div>
            <div class="cti-kicker">${(globalThis.PlatformLanguage?.text("settings","m_f652711330f9fa","Contacts · Import") ?? "Contacts · Import")}</div>
            <h3>${(globalThis.PlatformLanguage?.text("settings","m_fabdad74b5d57e","Review &amp; import") ?? "Review &amp; import")}</h3>
            <p><strong>${String(esc(preview.source_label || 'Contact file'))}</strong> · ${String(esc(text(state.file?.name)))}</p>
          </div>
          <div class="cti-actions">
            <button class="cti-btn" type="button" data-cti-cancel ${String(state.busy ? 'disabled' : '')}><i class="fas fa-arrow-left"></i>${(globalThis.PlatformLanguage?.text("settings","m_579e54971fc141"," Start over") ?? " Start over")}</button>
          </div>
        </div>
        ${String(array(preview.warnings).length ? `<div class="cti-warnings">${preview.warnings.map((warning) => `<div class="cti-warning">${esc(warning)}</div>`).join('')}</div>` : '')}
        <div class="cti-stats">
          <div class="cti-stat"><span>${(globalThis.PlatformLanguage?.text("settings","m_896170f0b5552d","Contacts in file") ?? "Contacts in file")}</span><strong>${String(Number(summary.total || 0))}</strong></div>
          <div class="cti-stat new"><span>${(globalThis.PlatformLanguage?.text("settings","m_96834d2fc9c9a5","New") ?? "New")}</span><strong>${String(Number(summary.new_count || 0))}</strong></div>
          <div class="cti-stat duplicate"><span>${(globalThis.PlatformLanguage?.text("settings","m_8e10e9eec3f012","Duplicates") ?? "Duplicates")}</span><strong>${String(Number(summary.duplicate_count || 0))}</strong></div>
          <div class="cti-stat invalid"><span>${(globalThis.PlatformLanguage?.text("settings","m_5fdd400f627557","Unreadable") ?? "Unreadable")}</span><strong>${String(Number(summary.invalid_count || 0))}</strong></div>
        </div>
        ${String(mappingMarkup())}
        ${String(Number(summary.duplicate_count || 0) ? `
        <div class="cti-block">
          <h4>Duplicates</h4>
          <p>${Number(summary.duplicate_count || 0)} contact${Number(summary.duplicate_count || 0) === 1 ? '' : 's'} in this file match contacts you already have (by email, phone, or name).</p>
          <div class="cti-option-grid">
            ${duplicateOptions.map(([id, label, description]) => `
              <button class="cti-option ${state.duplicateAction === id ? 'active' : ''}" data-cti-duplicate="${id}" type="button"><strong>${label}</strong><span>${description}</span></button>
            `).join('')}
          </div>
        </div>` : '')}
        <div class="cti-block">
          <h4>${(globalThis.PlatformLanguage?.text("settings","m_bc4c06df6d4499","Tag these contacts") ?? "Tag these contacts")}</h4>
          <p>${(globalThis.PlatformLanguage?.text("settings","m_8063fbcd381e1d","Tags are applied to every imported contact and are searchable from My Contacts — e.g. \"Gutter customers\" or where the list came from.") ?? "Tags are applied to every imported contact and are searchable from My Contacts — e.g. \"Gutter customers\" or where the list came from.")}</p>
          <div class="cti-tag-row">
            ${String(state.tags.map((tag) => `<span class="cti-tag" data-cti-tag="${esc(tag)}">${esc(tag)}<button type="button" aria-label="Remove tag ${esc(tag)}"><i class="fas fa-times"></i></button></span>`).join(''))}
            <input class="cti-tag-input" data-cti-tag-input type="text" autocomplete="off" placeholder="${(globalThis.PlatformLanguage?.text("settings","m_cfa7743c211ea0","Add a tag...") ?? "Add a tag...")}">
            ${String(['Imported from ' + text(preview.source_label, 'contact file'), 'Imported ' + new Date().toLocaleDateString(undefined, { month:'short', year:'numeric' })]
              .filter((suggestion) => !state.tags.some((tag) => tag.toLowerCase() === suggestion.toLowerCase()))
              .map((suggestion) => `<button class="cti-tag-suggest" type="button" data-cti-tag-suggest="${esc(suggestion)}"><i class="fas fa-plus"></i>${esc(suggestion)}</button>`).join(''))}
          </div>
        </div>
        <div class="cti-block">
          <h4>${(globalThis.PlatformLanguage?.text("settings","m_afff48796c3165","Preview") ?? "Preview")}</h4>
          <p>${((v12,v13) => globalThis.PlatformLanguage?.text("settings","m_152570a89b70d1",`The first ${v12} of ${v13} contacts read from the file.`,{v12,v13}) ?? `The first ${v12} of ${v13} contacts read from the file.`)(sample.length,Number(summary.total || 0))}</p>
          <div class="cti-table-wrap">
            <table class="cti-table">
              <thead><tr><th>${(globalThis.PlatformLanguage?.text("settings","m_1352cafa75b8da","Status") ?? "Status")}</th><th>${(globalThis.PlatformLanguage?.text("settings","m_8cf345002184e5","Name") ?? "Name")}</th><th>${(globalThis.PlatformLanguage?.text("settings","m_5d2b9327181e33","Email") ?? "Email")}</th><th>${(globalThis.PlatformLanguage?.text("settings","m_ed04c65845180f","Phone") ?? "Phone")}</th><th>${(globalThis.PlatformLanguage?.text("settings","m_53d803cdbe9ab1","Address") ?? "Address")}</th><th>${(globalThis.PlatformLanguage?.text("settings","m_562d2cd3a48b8f","Tags") ?? "Tags")}</th><th>${(globalThis.PlatformLanguage?.text("settings","m_25ccde60a3236c","Detail") ?? "Detail")}</th></tr></thead>
              <tbody>
                ${String(sample.map((row) => {
                  const contact = object(row.contact);
                  return `<tr>
                    <td><span class="cti-badge ${esc(row.status)}">${esc(row.status === 'new' ? 'New' : row.status === 'duplicate' ? 'Duplicate' : 'Unreadable')}</span></td>
                    <td title="${esc(contact.name)}">${esc(contact.name)}</td>
                    <td title="${esc(contact.email)}">${esc(contact.email)}</td>
                    <td>${esc(contact.phone)}</td>
                    <td title="${esc(contact.address)}">${esc(contact.address)}</td>
                    <td title="${esc(array(contact.tags).join(', '))}">${esc(array(contact.tags).slice(0, 3).join(', '))}${array(contact.tags).length > 3 ? '…' : ''}</td>
                    <td title="${esc(row.reason)}">${esc(row.reason)}</td>
                  </tr>`;
                }).join(''))}
              </tbody>
            </table>
          </div>
        </div>
        <div class="cti-footer">
          <span class="cti-status" data-cti-status>${String(esc(state.status))}</span>
          <div class="cti-actions">
            <button class="cti-btn primary" type="button" data-cti-commit ${String(state.busy ? 'disabled' : '')}>
              <i class="fas fa-file-import"></i>
              ${String(state.busy ? 'Importing…' : `Import ${Number(summary.new_count || 0) + (state.duplicateAction !== 'skip' ? Number(summary.duplicate_count || 0) : 0)} contact${(Number(summary.new_count || 0) + (state.duplicateAction !== 'skip' ? Number(summary.duplicate_count || 0) : 0)) === 1 ? '' : 's'}`)}
            </button>
          </div>
        </div>
      `;
    }

    function doneMarkup(){
      const counts = object(state.commitResult?.counts);
      const parts = [
        `${Number(counts.created || 0)} created`,
        Number(counts.updated || 0) ? `${Number(counts.updated)} updated` : '',
        Number(counts.skipped || 0) ? `${Number(counts.skipped)} skipped` : '',
        Number(counts.invalid || 0) ? `${Number(counts.invalid)} unreadable` : '',
        Number(counts.failed || 0) ? `${Number(counts.failed)} failed` : ''
      ].filter(Boolean).join(' · ');
      return `
        <div class="cti-block cti-done">
          <div>
            <i class="fas fa-circle-check"></i>
            <h4>${(globalThis.PlatformLanguage?.text("settings","m_8a7ec9254c9426","Import complete") ?? "Import complete")}</h4>
            <p>${String(esc(parts))}${String(state.tags.length ? ` · tagged ${state.tags.map((tag) => `"${tag}"`).join(', ')}` : '')}</p>
            <div class="cti-actions" style="justify-content:center">
              <button class="cti-btn" type="button" data-cti-again><i class="fas fa-file-import"></i>${(globalThis.PlatformLanguage?.text("settings","m_a2d721c1b88e56"," Import another file") ?? " Import another file")}</button>
              <button class="cti-btn" type="button" data-cti-history><i class="fas fa-clock-rotate-left"></i>${(globalThis.PlatformLanguage?.text("settings","m_bcea80956c5d70"," View import history") ?? " View import history")}</button>
              <button class="cti-btn primary" type="button" data-cti-open-contacts><i class="fas fa-address-book"></i>${(globalThis.PlatformLanguage?.text("settings","m_cf7d1de3c1d5f9"," Open My Contacts") ?? " Open My Contacts")}</button>
            </div>
          </div>
        </div>
      `;
    }

    function historyMarkup(){
      if (state.historyLoading) return `<div class="cti-loading"><span><i class="fas fa-spinner fa-spin"></i>${(globalThis.PlatformLanguage?.text("settings","m_f0125556e9c81e"," Loading imports…") ?? " Loading imports…")}</span></div>`;
      if (state.historyError) return `<div class="cti-error">${esc(state.historyError)}</div>`;
      const imports = state.imports.filter((record) => text(record.status) !== 'pending');
      if (!imports.length) return `<div class="cti-empty">${(globalThis.PlatformLanguage?.text("settings","m_05bc75074ce912","No imports yet. Contact books you import will be listed here with their tags and an undo option.") ?? "No imports yet. Contact books you import will be listed here with their tags and an undo option.")}</div>`;
      return imports.map((record) => {
        const counts = object(record.counts);
        const summary = object(record.summary);
        const status = text(record.status);
        const undoCounts = object(record.undo_counts);
        return `
          <div class="cti-history-row" data-cti-import="${esc(record.id)}">
            <div class="cti-history-main">
              <strong>${esc(text(record.filename, record.source_label, 'Contact import'))}</strong>
              <span>${esc(text(record.source_label))} · ${esc(dateLabel(record.created_at) || '')}${text(record.actor_email) ? ` · ${esc(record.actor_email)}` : ''}</span>
            </div>
            <div class="cti-history-counts">
              ${status === 'committed' ? `${Number(counts.created || 0)} created · ${Number(counts.updated || 0)} updated · ${Number(counts.skipped || 0)} skipped` : ''}
              ${status === 'undone' ? `Undone · ${Number(undoCounts.removed || 0)} removed${Number(undoCounts.kept || 0) ? `, ${Number(undoCounts.kept)} kept (in use)` : ''}` : ''}
              ${status === 'pending' ? `${Number(summary.total || 0)} contacts previewed` : ''}
            </div>
            <div class="cti-tag-row">${array(record.tags).map((tag) => `<span class="cti-tag">${esc(tag)}</span>`).join('') || `<span class="cti-history-counts">${(globalThis.PlatformLanguage?.text("settings","m_5e2e4552539fe2","No tags") ?? "No tags")}</span>`}</div>
            <div class="cti-actions">
              <span class="cti-badge ${esc(status)}">${esc(status === 'committed' ? 'Imported' : status === 'undone' ? 'Undone' : 'Pending')}</span>
              ${status === 'committed' ? `<button class="cti-btn danger" type="button" data-cti-undo="${String(esc(record.id))}"><i class="fas fa-rotate-left"></i>${(globalThis.PlatformLanguage?.text("settings","m_d085255851a912"," Undo") ?? " Undo")}</button>` : ''}
            </div>
          </div>
        `;
      }).join('');
    }

    // ----------------------------------------------------------------- render

    function bindImport(){
      const drop = host.querySelector('[data-cti-drop]');
      const fileInput = host.querySelector('[data-cti-file]');
      if (drop && fileInput) {
        drop.addEventListener('click', () => fileInput.click());
        drop.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInput.click(); } });
        drop.addEventListener('dragover', (event) => { event.preventDefault(); drop.classList.add('dragging'); });
        drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
        drop.addEventListener('drop', (event) => {
          event.preventDefault();
          drop.classList.remove('dragging');
          handleFile(event.dataTransfer?.files?.[0]);
        });
        fileInput.addEventListener('change', () => handleFile(fileInput.files?.[0]));
      }
      host.querySelector('[data-cti-cancel]')?.addEventListener('click', discardPreview);
      host.querySelector('[data-cti-remap]')?.addEventListener('click', rerunPreview);
      host.querySelectorAll('[data-cti-map]').forEach((select) => select.addEventListener('change', () => {
        state.mappingDraft = { ...(state.mappingDraft || {}), [select.dataset.ctiMap]: select.value };
      }));
      host.querySelectorAll('[data-cti-duplicate]').forEach((button) => button.addEventListener('click', () => {
        state.duplicateAction = button.dataset.ctiDuplicate;
        render();
      }));
      host.querySelectorAll('[data-cti-tag] button').forEach((button) => button.addEventListener('click', () => removeTag(button.closest('[data-cti-tag]')?.dataset.ctiTag || '')));
      host.querySelectorAll('[data-cti-tag-suggest]').forEach((button) => button.addEventListener('click', () => addTag(button.dataset.ctiTagSuggest)));
      const tagInput = host.querySelector('[data-cti-tag-input]');
      tagInput?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ',') {
          event.preventDefault();
          addTag(tagInput.value);
        }
      });
      tagInput?.addEventListener('blur', () => { if (text(tagInput.value)) addTag(tagInput.value); });
      host.querySelector('[data-cti-commit]')?.addEventListener('click', commitImport);
      host.querySelector('[data-cti-again]')?.addEventListener('click', () => { discardPreview(); });
      host.querySelector('[data-cti-history]')?.addEventListener('click', () => setSubtab('history'));
      host.querySelector('[data-cti-open-contacts]')?.addEventListener('click', () => {
        root.Portal?.navigation?.navigate?.({ tab:'contacts', sub:null, settingsView:null, settingsEntity:null }, { source:'contacts-import-open', ownedKeys:['tab'] });
      });
    }

    async function loadHistory(force = false){
      if (state.historyLoading || (state.historyLoaded && !force)) return;
      state.historyLoading = true;
      state.historyError = '';
      render();
      try {
        const result = await api.list(orgId);
        state.imports = array(result?.imports).map(object);
        state.historyLoaded = true;
      } catch (error) {
        state.historyError = error?.message || 'Could not load the import history.';
      } finally {
        state.historyLoading = false;
        render();
      }
    }

    async function undoImport(importId){
      const record = state.imports.find((entry) => text(entry.id) === importId);
      const created = Number(object(record?.counts).created || 0);
      if (!window.confirm(((v0,v1) => globalThis.PlatformLanguage?.text("settings","m_dece32d56f75bf",`Undo this import? Up to ${v0} contact${v1} created by it will be removed. Contacts that gained projects or events since are kept.`,{v0,v1}) ?? `Undo this import? Up to ${v0} contact${v1} created by it will be removed. Contacts that gained projects or events since are kept.`)(created,created === 1 ? '' : 's'))) return;
      try {
        const result = await api.undo(orgId, importId);
        toast((globalThis.PlatformLanguage?.text("settings","m_ad137533e957ef","Import undone") ?? "Import undone"), ((v0,v1) => globalThis.PlatformLanguage?.text("settings","m_b43558c1aef5bc",`${v0} contacts were removed${v1}.`,{v0,v1}) ?? `${v0} contacts were removed${v1}.`)(Number(result?.removed || 0),Number(result?.kept || 0) ? `; ${Number(result.kept)} were kept because they are in use` : ''), true);
        root.dispatchEvent(new CustomEvent('fm:projects:refresh', { detail: { redraw: true } }));
        await loadHistory(true);
      } catch (error) {
        toast((globalThis.PlatformLanguage?.text("settings","m_2141d8323a5cba","Could not undo the import") ?? "Could not undo the import"), error?.message || 'Please try again.', false);
      }
    }

    function bindHistory(){
      host.querySelectorAll('[data-cti-undo]').forEach((button) => button.addEventListener('click', () => undoImport(button.dataset.ctiUndo)));
      host.querySelector('[data-cti-refresh-history]')?.addEventListener('click', () => loadHistory(true));
    }

    function render(){
      if (!api) {
        page.innerHTML = (String(subTabs()) + "<div class=\"cti-error\">" + (globalThis.PlatformLanguage?.text("settings","m_4d69c2b47d6b55","Contact imports are unavailable — the platform API client is missing.") ?? "Contact imports are unavailable — the platform API client is missing.") + "</div>");
        bindSubTabs();
        return;
      }
      if (state.subtab === 'history') {
        page.innerHTML = (String(subTabs()) + "\n          <div class=\"cti-head\">\n            <div>\n              <div class=\"cti-kicker\">" + (globalThis.PlatformLanguage?.text("settings","m_f73fef8a7642ab","Contacts · History") ?? "Contacts · History") + "</div>\n              <h3>" + (globalThis.PlatformLanguage?.text("settings","m_57107f62fe4923","Import history") ?? "Import history") + "</h3>\n              <p>" + (globalThis.PlatformLanguage?.text("settings","m_4f2549d8012644","Every committed contact import, who ran it, what it created, and the tags it applied. Undo removes the contacts an import created as long as they have not been used on a project.") ?? "Every committed contact import, who ran it, what it created, and the tags it applied. Undo removes the contacts an import created as long as they have not been used on a project.") + "</p>\n            </div>\n            <div class=\"cti-actions\"><button class=\"cti-btn\" type=\"button\" data-cti-refresh-history><i class=\"fas fa-rotate\"></i>" + (globalThis.PlatformLanguage?.text("settings","m_4f524800833039"," Refresh") ?? " Refresh") + "</button></div>\n          </div>\n          " + String(historyMarkup()));
        bindSubTabs();
        bindHistory();
        if (!state.historyLoaded && !state.historyLoading && !state.historyError) loadHistory();
        return;
      }
      const body = state.step === 'preview' && state.preview ? previewMarkup() : state.step === 'done' ? doneMarkup() : uploadMarkup();
      page.innerHTML = `${subTabs()}${body}`;
      bindSubTabs();
      bindImport();
    }

    render();

    const unregisterRoute = root.Portal?.navigation?.registerHandler?.(`contacts-settings-view:${routeScope}:${options.instanceId || 'default'}`, {
      priority: 450,
      apply: (route) => {
        const matches = routeScope === 'contacts'
          ? route.tab === 'contacts' && ['import','settings'].includes(route.contactsWorkspace)
          : route.tab === 'company_settings' && route.sub === 'contacts';
        if (!matches) return;
        const next = ['import','history'].includes(route[routeViewKey]) ? route[routeViewKey] : (options.initialSubtab || 'import');
        if (next !== state.subtab) setSubtab(next, { updateRoute: false });
      }
    });
    return {
      destroy(){
        if (typeof unregisterRoute === 'function') unregisterRoute();
        delete host.dataset.contactsMounted;
        host.innerHTML = '';
      }
    };
  }

  root.FirstMateContactsSettings = { mount };
})(window);
