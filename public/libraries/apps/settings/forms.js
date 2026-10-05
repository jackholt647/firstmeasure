/* Forms settings: the forms library and the form editor.
 *
 * A form is steps of blocks. The editor edits the draft definition, autosaves
 * it through FormsAPI, and renders the real public embed beside it as a live
 * preview \u2014 the preview is the same renderer visitors get, running the unsaved
 * draft through the authenticated preview transport. Publishing snapshots the
 * draft as a document module version; see v1/forms/README.md.
 */
(function(root){
  'use strict';

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const clean = (value) => String(value ?? '').trim();
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const controllers = new WeakMap();
  const QUESTION_KINDS = new Set(['text', 'paragraph', 'number', 'select', 'multi_select', 'boolean', 'date']);
  const STATUS = { live: ['Live', 'ok'], draft: ['Draft', 'muted'], paused: ['Paused', 'warn'] };
  const OPS = [['eq', 'is'], ['neq', 'is not'], ['in', 'is any of'], ['answered', 'is answered / yes'], ['empty', 'is empty / no'], ['gt', 'is more than'], ['gte', 'is at least'], ['lt', 'is less than'], ['lte', 'is at most']];
  const NUMERIC_OPS = ['gt', 'gte', 'lt', 'lte'];

  function injectCss(){
    if (document.getElementById('fmFormsSettingsCss')) return;
    const style = document.createElement('style');
    style.id = 'fmFormsSettingsCss';
    style.textContent = `
      .fms-root{height:100%;min-height:0;display:flex;flex-direction:column;color:#17212b}.fms-root *{box-sizing:border-box}
      .fms-scroll{flex:1;min-height:0;overflow-y:auto;padding:2px 2px 24px}
      .fms-loading{display:grid;place-items:center;min-height:320px;color:#667085;font-size:12.5px;font-weight:800}
      .fms-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:16px}
      .fms-head h3{margin:0;font-size:20px;letter-spacing:-.01em}.fms-head p{margin:5px 0 0;color:#667085;font-size:12.5px;line-height:1.5;max-width:620px}
      .fms-btn{appearance:none;border:1px solid #d0d5dd;background:#fff;color:#344054;border-radius:10px;height:36px;padding:0 13px;font:850 12px/1 inherit;display:inline-flex;align-items:center;justify-content:center;gap:7px;cursor:pointer;white-space:nowrap}
      .fms-btn:hover{background:#f9fafb}.fms-btn.primary{border-color:var(--primary-readable,var(--primary,#d93025));background:var(--primary-readable,var(--primary,#d93025));color:#fff}.fms-btn.primary:hover{filter:brightness(.95)}
      .fms-btn.danger{color:#b42318;border-color:#fecdca}.fms-btn.small{height:30px;padding:0 10px;font-size:11.5px}.fms-btn[disabled]{opacity:.55;cursor:not-allowed}
      .fms-icon-btn{appearance:none;border:0;background:transparent;color:#667085;width:28px;height:28px;border-radius:8px;display:inline-grid;place-items:center;cursor:pointer;font-size:12px}.fms-icon-btn:hover{background:#f2f4f7;color:#101828}.fms-icon-btn[disabled]{opacity:.35;cursor:default}
      .fms-list{display:grid;gap:10px}
      .fms-row{display:grid;grid-template-columns:44px minmax(0,1fr) auto auto;gap:14px;align-items:center;padding:14px 16px;border:1px solid #e4e7ec;border-radius:14px;background:#fff;cursor:pointer;text-align:left;width:100%;font:inherit;color:inherit}
      .fms-row:hover{border-color:#c7cdd6;box-shadow:0 2px 10px rgba(16,24,40,.06)}
      .fms-row-icon{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;background:#f2f4f7;color:#475467;font-size:17px}
      .fms-row b{display:block;font-size:14px}.fms-row small{display:block;margin-top:3px;color:#667085;font-size:12px}
      .fms-row-stat{text-align:right;font-size:12px;color:#667085;white-space:nowrap}.fms-row-stat strong{display:block;font-size:15px;color:#101828}
      .fms-row-actions{display:flex;gap:2px}
      .fms-pill{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 9px;border-radius:999px;font-size:11px;font-weight:850;white-space:nowrap}
      .fms-pill.ok{background:#ecfdf3;color:#067647}.fms-pill.muted{background:#f2f4f7;color:#475467}.fms-pill.warn{background:#fffaeb;color:#b54708}.fms-pill.info{background:#eff8ff;color:#175cd3}
      .fms-empty{border:1px dashed #d0d5dd;border-radius:16px;padding:28px;text-align:center;background:#fcfcfd}.fms-empty h4{margin:0 0 6px;font-size:16px}.fms-empty p{margin:0 0 18px;color:#667085;font-size:13px}
      .fms-templates{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px;text-align:left}
      .fms-template{appearance:none;border:1px solid #e4e7ec;border-radius:14px;background:#fff;padding:16px;text-align:left;cursor:pointer;font:inherit;color:inherit;display:grid;gap:8px;align-content:start}
      .fms-template:hover:not([disabled]){border-color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 4px 14px rgba(16,24,40,.08)}.fms-template[disabled]{opacity:.55;cursor:not-allowed}
      .fms-template i.ico{width:38px;height:38px;border-radius:10px;display:grid;place-items:center;background:#f2f4f7;color:#344054;font-size:15px}
      .fms-template b{font-size:14px}.fms-template span{font-size:12px;color:#667085;line-height:1.45}
      .fms-group-title{margin:18px 0 8px;font-size:11px;font-weight:900;letter-spacing:.06em;text-transform:uppercase;color:#667085;text-align:left}
      .fms-dialog{border:0;border-radius:18px;padding:0;width:min(880px,calc(100vw - 32px));max-height:calc(100vh - 48px);box-shadow:0 30px 80px rgba(16,24,40,.3)}.fms-dialog::backdrop{background:rgba(16,24,40,.45)}
      .fms-dialog-head{display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid #eef0f3}.fms-dialog-head h3{margin:0;font-size:17px}.fms-dialog-body{padding:4px 22px 24px;overflow-y:auto;max-height:calc(100vh - 140px)}
      .fms-editor{flex:1;min-height:0;display:flex;flex-direction:column}
      .fms-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}
      .fms-name{flex:1;min-width:180px;height:38px;border:1px solid transparent;border-radius:10px;padding:0 10px;font:800 17px/1 inherit;color:#101828;background:transparent}.fms-name:hover{border-color:#e4e7ec}.fms-name:focus{border-color:#98a2b3;outline:none;background:#fff}
      .fms-save{font-size:11.5px;font-weight:800;color:#667085;white-space:nowrap}.fms-save.err{color:#b42318}
      .fms-cols{flex:1;min-height:0;display:grid;grid-template-columns:minmax(380px,1fr) minmax(360px,1.05fr);gap:16px}
      .fms-pane{min-height:0;overflow-y:auto;padding:2px 4px 30px 2px}
      .fms-preview{min-height:0;display:flex;flex-direction:column;border:1px solid #e4e7ec;border-radius:16px;background:#f3f5f8;overflow:hidden}
      .fms-preview-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 12px;background:#fff;border-bottom:1px solid #e4e7ec;font-size:11.5px;font-weight:850;color:#475467}
      .fms-seg{display:inline-flex;border:1px solid #e4e7ec;border-radius:9px;overflow:hidden}.fms-seg button{appearance:none;border:0;background:#fff;padding:6px 11px;font:850 11.5px/1 inherit;color:#667085;cursor:pointer}.fms-seg button.on{background:#101828;color:#fff}
      .fms-preview-stage{flex:1;min-height:0;overflow-y:auto;padding:20px 16px 32px}.fms-preview-stage.phone>div{max-width:390px;margin:0 auto}
      .fms-card{border:1px solid #e4e7ec;border-radius:14px;background:#fff;margin-bottom:12px}
      .fms-card-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #f0f2f5}
      .fms-card-head .n{width:24px;height:24px;border-radius:99px;background:#101828;color:#fff;font-size:11px;font-weight:900;display:grid;place-items:center;flex:0 0 auto}
      .fms-card-head input{flex:1;min-width:0;height:32px;border:1px solid transparent;border-radius:8px;padding:0 8px;font:800 13.5px/1 inherit;background:transparent}.fms-card-head input:hover{border-color:#e4e7ec}.fms-card-head input:focus{border-color:#98a2b3;outline:none}
      .fms-card-body{padding:10px 12px 12px;display:grid;gap:8px}
      .fms-block{border:1px solid #eaecf0;border-radius:11px;background:#fff}.fms-block.open{border-color:#98a2b3;box-shadow:0 2px 10px rgba(16,24,40,.06)}
      .fms-block-row{display:flex;align-items:center;gap:10px;width:100%;padding:9px 10px;cursor:pointer;border:0;background:transparent;font:inherit;text-align:left;color:inherit}
      .fms-block-row i.k{width:28px;height:28px;border-radius:8px;background:#f2f4f7;color:#475467;display:grid;place-items:center;font-size:12px;flex:0 0 auto}
      .fms-block-row b{font-size:13px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fms-block-row small{font-size:11.5px;color:#667085}
      .fms-block-row .t{flex:1;min-width:0}
      .fms-block-edit{padding:4px 12px 14px;display:grid;gap:12px;border-top:1px solid #f0f2f5}
      .fms-field{display:grid;gap:5px;min-width:0}.fms-field>span{font-size:11.5px;font-weight:850;color:#344054}.fms-field>small{font-size:11.5px;color:#667085;line-height:1.4}
      .fms-in{width:100%;height:36px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;padding:0 10px;font:inherit;font-size:13px;color:#101828;outline:none}.fms-in:focus{border-color:#667085;box-shadow:0 0 0 3px rgba(102,112,133,.14)}
      textarea.fms-in{height:auto;min-height:68px;padding:8px 10px;resize:vertical;line-height:1.45}textarea.fms-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;min-height:220px}
      .fms-two{display:grid;grid-template-columns:1fr 1fr;gap:10px}.fms-three{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}
      .fms-check{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:700;color:#344054;cursor:pointer}.fms-check input{width:16px;height:16px;accent-color:var(--primary-readable,var(--primary,#d93025))}
      .fms-opt{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr) 28px;gap:6px;align-items:center}
      .fms-price{display:grid;grid-template-columns:minmax(0,1.5fr) 82px 82px 28px;gap:6px;align-items:center}.fms-price.head,.fms-opt.head{font-size:10.5px;font-weight:900;letter-spacing:.05em;text-transform:uppercase;color:#667085}
      .fms-cond{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,.9fr) minmax(0,1fr);gap:6px}
      .fms-section{border:1px solid #e4e7ec;border-radius:14px;background:#fff;padding:16px;margin-bottom:12px;display:grid;gap:12px}.fms-section h4{margin:0;font-size:13.5px}.fms-section>p{margin:-6px 0 0;font-size:12px;color:#667085;line-height:1.5}
      .fms-add{display:flex;gap:8px;flex-wrap:wrap}
      .fms-palette{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px;padding:10px;border:1px solid #e4e7ec;border-radius:11px;background:#f9fafb}
      .fms-palette h5{grid-column:1/-1;margin:4px 0 0;font-size:10.5px;font-weight:900;letter-spacing:.05em;text-transform:uppercase;color:#667085}
      .fms-palette button{appearance:none;border:1px solid #e4e7ec;background:#fff;border-radius:9px;padding:8px 9px;font:750 12px/1.2 inherit;color:#344054;display:flex;align-items:center;gap:8px;cursor:pointer;text-align:left}.fms-palette button:hover:not([disabled]){border-color:#98a2b3}.fms-palette button[disabled]{opacity:.5;cursor:not-allowed}
      .fms-note{font-size:12px;color:#667085;line-height:1.5}.fms-note.warn{color:#b54708}.fms-note a{color:inherit;font-weight:800}
      .fms-issues{border:1px solid #fecdca;background:#fffbfa;border-radius:12px;padding:12px 14px;margin-bottom:12px;font-size:12.5px;color:#b42318}.fms-issues b{display:block;margin-bottom:4px}.fms-issues ul{margin:0;padding-left:18px;line-height:1.6}
      .fms-code-box{display:flex;gap:8px;align-items:stretch}.fms-code-box textarea,.fms-code-box input{flex:1;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}
      .fms-table{width:100%;border-collapse:collapse;font-size:12.5px}.fms-table th{font-size:10.5px;font-weight:900;letter-spacing:.05em;text-transform:uppercase;color:#667085;text-align:left;padding:8px 10px;border-bottom:1px solid #e4e7ec}.fms-table td{padding:10px;border-bottom:1px solid #f0f2f5;vertical-align:top}
      .fms-table td small{display:block;color:#667085;margin-top:2px}
      .fms-assistant{height:100%;min-height:460px;border:1px solid #e4e7ec;border-radius:14px;overflow:hidden;display:flex;flex-direction:column}
      a.fms-btn{text-decoration:none}
      .fms-color{display:flex;gap:8px;align-items:center}.fms-color input[type=color]{width:36px;height:36px;border:1px solid #d0d5dd;border-radius:9px;padding:2px;background:#fff}
      @media(max-width:1200px){.fms-cols{grid-template-columns:1fr}.fms-preview{min-height:560px}.fms-root,.fms-editor{height:auto}.fms-pane{overflow:visible}}
      @media(max-width:640px){.fms-row{grid-template-columns:44px minmax(0,1fr)}.fms-row-stat{display:none}.fms-two,.fms-three,.fms-cond{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }

  // --- small helpers ---------------------------------------------------------
  function getPath(target, path){
    return path.split('.').reduce((value, key) => value == null ? undefined : value[key], target);
  }
  function setPath(target, path, value){
    const keys = path.split('.');
    const last = keys.pop();
    const parent = keys.reduce((node, key) => node[key], target);
    if (value === undefined) delete parent[last]; else parent[last] = value;
  }
  const slug = (value, fallback) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^([0-9])/, 'q_$1').slice(0, 40) || fallback;
  const uid = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
  const relative = (iso) => {
    const time = new Date(iso).getTime();
    if (!Number.isFinite(time)) return '';
    const minutes = Math.round((Date.now() - time) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
    if (minutes < 43200) return `${Math.round(minutes / 1440)}d ago`;
    return new Date(iso).toLocaleDateString();
  };
  let embedLoading = null;
  function ensureEmbed(){
    if (root.FirstMateForms) return Promise.resolve();
    return embedLoading ||= new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL('/libraries/forms-embed/firstmate-forms-embed.js', location.href).href;
      script.dataset.auto = 'false';
      script.onload = resolve;
      script.onerror = () => { embedLoading = null; script.remove(); reject(new Error('Could not load the form preview.')); };
      document.head.append(script);
    });
  }

  function mount(host, ctx){
    injectCss();
    controllers.get(host)?.destroy();
    const api = root.FormsAPI;
    const orgId = ctx.orgId;
    const toast = (title, body, ok = true) => ctx.showToast?.(title, body, ok);
    const state = { context: null, forms: [], view: 'library', form: null, draft: null, name: '', tab: 'build', openItem: '', palette: '', save: 'saved', saveError: '', issues: [], device: 'desktop', submissions: null };
    let saveTimer = 0;
    let saving = null;
    let dirty = false;
    let preview = null;
    let assistant = null;
    let destroyed = false;
    const assistantAvailable = () => !!(root.FMDocAgentPanel?.create && root.AgentsAPI);
    const autoKeys = new Set();
    host.innerHTML = '<div class="fms-root"><div class="fms-loading">Loading forms\u2026</div></div>';
    const rootEl = host.firstElementChild;

    const kindMeta = (kind) => state.context.blocks.find((block) => block.kind === kind) || { label: kind, icon: 'fa-square' };
    const formKind = (form) => form.features?.appointment ? ['fa-calendar-check', 'Appointment booking'] : form.features?.estimate ? ['fa-calculator', 'Instant estimate'] : ['fa-address-card', 'Lead form'];
    const items = () => state.draft.steps.flatMap((step) => step.items);

    /** Company colors and logo are resolved here so the public form needs no portal context. */
    function effectiveDraft(){
      const draft = clone(state.draft);
      const style = draft.presentation.style;
      if (style.use_company_colors && /^#[0-9a-f]{6}$/i.test(clean(ctx.branding?.primary))) style.primary_color = ctx.branding.primary;
      style.logo_url = style.logo_enabled ? clean(ctx.branding?.logo) : '';
      return draft;
    }

    // --- Library -------------------------------------------------------------
    function templateGallery(){
      const groups = [];
      for (const template of state.context.templates) {
        let group = groups.find((entry) => entry.name === template.category);
        if (!group) groups.push(group = { name: template.category, templates: [] });
        group.templates.push(template);
      }
      const ai = assistantAvailable() ? `<div class="fms-group-title">Describe it</div><div class="fms-templates">
        <button type="button" class="fms-template" data-act="create" data-template="blank" data-assistant>
          <i aria-hidden="true" class="ico fas fa-wand-magic-sparkles"></i><b>Build with the assistant</b><span>Tell the assistant what your business needs to ask and how you price. It builds the form while you watch.</span>
        </button></div>` : '';
      return ai + groups.map((group) => `<div class="fms-group-title">${esc(group.name)}</div><div class="fms-templates">${group.templates.map((template) => `
        <button type="button" class="fms-template" data-act="create" data-template="${esc(template.id)}" ${template.available ? '' : 'disabled title="Not enabled for this organization"'}>
          <i aria-hidden="true" class="ico fas ${esc(template.icon)}"></i><b>${esc(template.name)}</b><span>${esc(template.description)}</span>
          ${template.available ? '' : '<span class="fms-pill muted">Not enabled</span>'}
        </button>`).join('')}</div>`).join('');
    }
    function renderLibrary(){
      state.view = 'library';
      preview?.destroy(); preview = null;
      assistant?.destroy(); assistant = null;
      const rows = state.forms.map((form) => {
        const [icon, kind] = formKind(form);
        const [label, tone] = STATUS[form.status] || STATUS.draft;
        const steps = form.definition.steps.length;
        return `<div class="fms-row" role="button" tabindex="0" data-act="open" data-id="${esc(form.id)}">
          <span class="fms-row-icon"><i aria-hidden="true" class="fas ${icon}"></i></span>
          <span><b>${esc(form.name)}</b><small>${esc(kind)} \u00b7 ${steps} step${steps === 1 ? '' : 's'} \u00b7 Edited ${esc(relative(form.updated_at))}</small></span>
          <span class="fms-row-stat"><strong>${Number(form.submissions?.count || 0).toLocaleString()}</strong>${form.submissions?.count ? `last ${esc(relative(form.submissions.last_at))}` : 'submissions'}</span>
          <span style="display:flex;align-items:center;gap:8px"><span class="fms-pill ${tone}">${label}</span>${form.has_unpublished_changes ? '<span class="fms-pill info">Unpublished changes</span>' : ''}
            <span class="fms-row-actions">
              <button type="button" class="fms-icon-btn" data-act="duplicate" data-id="${esc(form.id)}" title="Duplicate"><i aria-hidden="true" class="fas fa-copy"></i></button>
              <button type="button" class="fms-icon-btn" data-act="delete" data-id="${esc(form.id)}" title="Delete"><i aria-hidden="true" class="fas fa-trash"></i></button>
            </span></span>
        </div>`;
      }).join('');
      rootEl.innerHTML = `<div class="fms-scroll">
        <div class="fms-head"><div><h3>Forms</h3><p>Build forms that capture leads, book appointments and give instant estimates. Put them on any website, share them by link, or drop them into your FirstMate site.</p></div>
          ${state.forms.length ? '<button type="button" class="fms-btn primary" data-act="new"><i aria-hidden="true" class="fas fa-plus"></i> New form</button>' : ''}</div>
        ${state.forms.length ? `<div class="fms-list">${rows}</div>` : `<div class="fms-empty"><h4>Create your first form</h4><p>Pick a starting point. Every form can be changed block by block afterwards.</p>${templateGallery()}</div>`}
      </div>`;
    }
    function openTemplateDialog(){
      const dialog = document.createElement('dialog');
      dialog.className = 'fms-dialog';
      dialog.innerHTML = `<div class="fms-dialog-head"><h3>New form</h3><button type="button" class="fms-icon-btn" data-close aria-label="Close"><i aria-hidden="true" class="fas fa-xmark"></i></button></div><div class="fms-dialog-body">${templateGallery()}</div>`;
      document.body.append(dialog);
      dialog.addEventListener('close', () => dialog.remove(), { once: true });
      dialog.querySelector('[data-close]').onclick = () => dialog.close();
      dialog.addEventListener('click', async (event) => {
        const button = event.target.closest('[data-act=create]');
        if (!button || button.disabled) return;
        button.disabled = true;
        await createFrom(button.dataset.template, button.dataset.assistant !== undefined);
        dialog.close();
      });
      dialog.showModal();
    }
    async function createFrom(templateId, withAssistant = false){
      try {
        const form = await api.create(orgId, { template: templateId });
        state.forms.unshift(form);
        openEditor(form, withAssistant ? 'assistant' : 'build');
      } catch (error) { toast('Could not create form', error.message, false); }
    }

    // --- Editor: persistence -------------------------------------------------
    function setSave(status, message = ''){
      state.save = status; state.saveError = message;
      const el = rootEl.querySelector('[data-save]');
      if (!el) return;
      el.className = `fms-save ${status === 'error' ? 'err' : ''}`;
      el.textContent = status === 'saving' ? 'Saving\u2026' : status === 'dirty' ? 'Unsaved changes' : status === 'error' ? `Not saved: ${message}` : 'All changes saved';
      const publish = rootEl.querySelector('[data-act=publish]');
      if (publish) { const label = publishLabel(); publish.textContent = label[0]; publish.disabled = label[1]; }
    }
    const publishLabel = () => {
      if (!state.form.published) return ['Publish', false];
      if (dirty || state.save !== 'saved' || state.form.has_unpublished_changes) return ['Publish changes', false];
      return ['Published', true];
    };
    function touch({ structure = false } = {}){
      dirty = true;
      setSave('dirty');
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { void flush(); }, 700);
      preview?.update(effectiveDraft(), state.name);
      if (structure) renderTab();
    }
    /** One write to the form at a time: saves, publishing and key changes all queue behind each other. */
    function track(work){
      const tracked = work.finally(() => { if (saving === tracked) saving = null; });
      saving = tracked;
      return tracked;
    }
    async function flush(){
      clearTimeout(saveTimer);
      while (saving) await saving.catch(() => undefined);
      if (!dirty || !state.form) return state.save !== 'error';
      dirty = false;
      setSave('saving');
      return track((async () => {
        try {
          const saved = { ...(await api.update(orgId, state.form.id, { name: state.name, definition: effectiveDraft(), expected_revision: state.form.revision })), submissions: state.form.submissions };
          state.form = saved;
          const index = state.forms.findIndex((form) => form.id === saved.id);
          if (index >= 0) state.forms[index] = saved;
          setSave(dirty ? 'dirty' : 'saved');
          refreshStatus();
          return true;
        } catch (error) {
          dirty = true;
          setSave('error', error.code === 'validation_error' ? 'a field is empty or invalid' : error.message);
          return false;
        }
      })());
    }
    function refreshStatus(){
      const el = rootEl.querySelector('[data-status]');
      if (!el) return;
      const [label, tone] = STATUS[state.form.status] || STATUS.draft;
      el.innerHTML = `<span class="fms-pill ${tone}">${label}</span>`;
    }

    // --- Editor: shell -------------------------------------------------------
    function openEditor(form, tab = 'build'){
      state.view = 'editor';
      state.form = form;
      state.draft = clone(form.definition);
      state.name = form.name;
      state.tab = tab;
      state.openItem = '';
      state.palette = '';
      state.issues = [];
      state.submissions = null;
      dirty = false;
      ctx.onNavigate?.(form.id);
      rootEl.innerHTML = `<div class="fms-editor">
        <div class="fms-bar">
          <button type="button" class="fms-btn small" data-act="back"><i aria-hidden="true" class="fas fa-arrow-left"></i> Forms</button>
          <input class="fms-name" data-name value="${esc(state.name)}" aria-label="Form name" maxlength="120">
          <span data-status></span>
          <span class="fms-save" data-save>All changes saved</span>
          <button type="button" class="fms-btn primary" data-act="publish">Publish</button>
        </div>
        <div class="fm-settings-subtabs" role="tablist" data-tabs></div>
        <div class="fms-cols">
          <div class="fms-pane" data-pane></div>
          <div class="fms-preview">
            <div class="fms-preview-bar"><span><i aria-hidden="true" class="fas fa-eye"></i> Live preview</span>
              <span style="display:flex;gap:8px;align-items:center"><span class="fms-seg" data-device><button type="button" data-device-mode="desktop" class="on">Desktop</button><button type="button" data-device-mode="phone">Phone</button></span>
              <button type="button" class="fms-btn small" data-act="restart"><i aria-hidden="true" class="fas fa-rotate-left"></i> Restart</button></span></div>
            <div class="fms-preview-stage" data-stage><div data-preview></div></div>
          </div>
        </div>
      </div>`;
      refreshStatus();
      setSave('saved');
      renderTabs();
      renderTab();
      void startPreview();
      // Company colors and logo are part of what gets published, so store them even if nothing else is edited.
      if (JSON.stringify(effectiveDraft()) !== JSON.stringify(form.definition)) touch();
    }
    async function startPreview(){
      const target = rootEl.querySelector('[data-preview]');
      try { await ensureEmbed(); } catch (error) { if (target) target.innerHTML = `<div class="fms-note">${esc(error.message)}</div>`; return; }
      if (destroyed || state.view !== 'editor' || !target?.isConnected) return;
      preview = root.FirstMateForms.render({
        definition: effectiveDraft(),
        name: state.name,
        target,
        transport: {
          availability: (item, date, address) => api.preview.availability(orgId, { item: { preset_id: item.preset_id, min_notice_hours: item.min_notice_hours, horizon_days: item.horizon_days }, date, address }),
          measure: (item, address) => api.preview.measurement(orgId, { source: item.source, address, tint: effectiveDraft().presentation.style.primary_color }),
          submit: (payload) => api.preview.submit(orgId, { definition: effectiveDraft(), answers: payload.answers, measurements: payload.measurements })
        }
      });
    }
    function renderTabs(){
      const tabs = [...(assistantAvailable() ? [['assistant', 'Assistant', 'fa-wand-magic-sparkles']] : []), ['build', 'Build', 'fa-layer-group'], ['pricing', 'Pricing', 'fa-calculator'], ['design', 'Design', 'fa-palette'], ['settings', 'Settings', 'fa-sliders'], ['share', 'Share', 'fa-share-nodes'], ['submissions', `Submissions${state.form.submissions?.count ? ` (${state.form.submissions.count})` : ''}`, 'fa-inbox']]
        .filter(([id]) => id !== 'pricing' || state.context.capabilities.instant_estimate || state.draft.calculation);
      rootEl.querySelector('[data-tabs]').innerHTML = tabs.map(([id, label, icon]) => `<button type="button" role="tab" class="fm-settings-subtab ${state.tab === id ? 'active' : ''}" data-tab="${id}"><i aria-hidden="true" class="fas ${icon}"></i> ${esc(label)}</button>`).join('');
    }
    function renderTab(){
      const pane = rootEl.querySelector('[data-pane]');
      if (!pane) return;
      if (state.tab === 'assistant' && assistantAvailable()) return renderAssistant(pane);
      assistant?.destroy(); assistant = null;
      const scroll = pane.scrollTop;
      const issues = state.issues.length ? `<div class="fms-issues"><b>Finish these before publishing</b><ul>${state.issues.map((issue) => `<li>${esc(issue.message)}</li>`).join('')}</ul></div>` : '';
      pane.innerHTML = issues + ({ build: buildTab, pricing: pricingTab, design: designTab, settings: settingsTab, share: shareTab, submissions: submissionsTab }[state.tab] || buildTab)();
      pane.scrollTop = scroll;
    }

    /** The form builder agent edits the open draft; its staged definition is applied like any other edit. */
    function renderAssistant(pane){
      if (assistant && pane.contains(assistant.el)) return;
      pane.innerHTML = '<div class="fms-assistant" data-assistant-host></div>';
      assistant = root.FMDocAgentPanel.create(pane.firstElementChild, {
        agentId: 'forms',
        orgId,
        subjectId: state.form.id,
        title: 'Form assistant',
        welcome: 'Describe the form you need, or what to change. I build it here and you can try it in the preview.',
        suggestions: ['Ask what service they need and how soon, then get their contact details', 'Add an instant estimate priced per square foot', 'Make this shorter and friendlier'],
        getInput: () => ({ subject: { id: state.form.id, name: state.name, status: state.form.status }, definition: effectiveDraft() }),
        onAction: (action) => {
          if (action.type !== 'form.set_definition' || !action.definition?.steps) return;
          state.draft = clone(action.definition);
          state.openItem = '';
          state.issues = [];
          renderTabs();
          touch();
        }
      });
    }

    // --- Field builders ------------------------------------------------------
    const field = (label, control, help = '') => `<label class="fms-field"><span>${esc(label)}</span>${control}${help ? `<small>${help}</small>` : ''}</label>`;
    const input = (path, attrs = '') => `<input class="fms-in" data-path="${path}" value="${esc(getPath(state.draft, path) ?? '')}" ${attrs}>`;
    const number = (path, attrs = '') => `<input class="fms-in" type="number" data-path="${path}" data-type="number" value="${esc(getPath(state.draft, path) ?? '')}" ${attrs}>`;
    const area = (path, attrs = '') => `<textarea class="fms-in" data-path="${path}" ${attrs}>${esc(getPath(state.draft, path) ?? '')}</textarea>`;
    const check = (path, label, rerender = false) => `<label class="fms-check"><input type="checkbox" data-path="${path}" data-type="bool" ${rerender ? 'data-rerender' : ''} ${getPath(state.draft, path) ? 'checked' : ''}>${esc(label)}</label>`;
    const select = (path, options, rerender = false, attrs = '') => {
      const current = getPath(state.draft, path) ?? '';
      return `<select class="fms-in" data-path="${path}" ${rerender ? 'data-rerender' : ''} ${attrs}>${options.map(([value, label, disabled]) => `<option value="${esc(value)}" ${String(current) === String(value) ? 'selected' : ''} ${disabled ? 'disabled' : ''}>${esc(label)}</option>`).join('')}</select>`;
    };

    /** Answers a condition or price can depend on: questions plus measured values. */
    function answerSources(beforeItemId = ''){
      const sources = [];
      for (const step of state.draft.steps) for (const item of step.items) {
        if (item.id === beforeItemId) return sources;
        if (!item.param) continue;
        if (QUESTION_KINDS.has(item.kind)) sources.push({ param: item.param, label: item.label || item.param, kind: item.kind, options: item.options || [] });
        if (item.kind === 'property_measurement') {
          const source = state.context.measurement_sources.find((entry) => entry.id === item.source);
          for (const entry of source?.fields || []) sources.push({ param: `${item.param}.${entry.key}`, label: `${entry.label} (measured)`, kind: entry.type === 'number' ? 'number' : 'select', options: (entry.values || []).map((value) => ({ value, label: value })), unit: entry.unit });
        }
      }
      return sources;
    }
    function conditionEditor(path, sources){
      const conditions = getPath(state.draft, path) || [];
      const condition = conditions[0];
      const source = condition ? sources.find((entry) => entry.param === condition.param) : null;
      const picker = `<select class="fms-in" data-cond="${path}" data-cond-field="param"><option value="">Always</option>${sources.map((entry) => `<option value="${esc(entry.param)}" ${condition?.param === entry.param ? 'selected' : ''}>When: ${esc(entry.label)}</option>`).join('')}${condition && !source ? `<option value="${esc(condition.param)}" selected>When: ${esc(condition.param)}</option>` : ''}</select>`;
      if (!condition) return picker;
      const needsValue = !['answered', 'empty'].includes(condition.op);
      const many = condition.op === 'in';
      const chosen = (Array.isArray(condition.value) ? condition.value : [condition.value]).map(String);
      const value = !needsValue ? '<span></span>' : source?.options?.length
        ? `<select class="fms-in" data-cond="${path}" data-cond-field="value" ${many ? `multiple size="${Math.min(4, source.options.length)}" style="height:auto;padding:4px" title="Hold Ctrl or Cmd to pick several"` : ''}>${source.options.map((option) => `<option value="${esc(option.value)}" ${chosen.includes(String(option.value)) ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}</select>`
        : `<input class="fms-in" data-cond="${path}" data-cond-field="value" value="${esc(many ? chosen.join(', ') : condition.value ?? '')}" placeholder="${many ? 'Values, separated by commas' : 'Value'}">`;
      return `<div class="fms-cond">${picker}<select class="fms-in" data-cond="${path}" data-cond-field="op">${OPS.map(([op, label]) => `<option value="${op}" ${condition.op === op ? 'selected' : ''}>${label}</option>`).join('')}</select>${value}</div>`;
    }

    // --- Build tab -----------------------------------------------------------
    function blockSummary(item){
      if (item.kind === 'contact') return ['name', 'email', 'phone'].filter((key) => item.fields?.[key]?.enabled !== false).join(', ');
      if (item.kind === 'select' || item.kind === 'multi_select') return `${item.options.length} choice${item.options.length === 1 ? '' : 's'}`;
      if (item.kind === 'appointment') return state.context.appointment_types.find((type) => type.id === item.preset_id)?.label || 'Choose an appointment type';
      if (item.kind === 'property_measurement') return state.context.measurement_sources.find((source) => source.id === item.source)?.label || '';
      return kindMeta(item.kind).label;
    }
    function blockEditor(item, base, stepIndex){
      const parts = [];
      if (item.kind === 'content') {
        parts.push(field('Heading', input(`${base}.heading`)), field('Text', area(`${base}.body`)), field('Image URL', input(`${base}.image_url`, 'placeholder="https://\u2026"')));
      } else if (item.kind === 'consent') {
        parts.push(field('Checkbox text', area(`${base}.label`), 'Visitors must check this to submit.'));
      } else if (item.kind === 'contact') {
        parts.push(`<div class="fms-field"><span>Fields</span>${['name', 'email', 'phone'].map((key) => `<div class="fms-two">${check(`${base}.fields.${key}.enabled`, `Ask for ${key}`, true)}${item.fields[key].enabled ? check(`${base}.fields.${key}.required`, 'Required') : '<span></span>'}</div>`).join('')}</div>`);
      } else {
        parts.push(field(item.kind === 'property_measurement' ? 'Title' : 'Question', input(`${base}.label`)));
        if (item.kind !== 'property_measurement') parts.push(field('Help text', input(`${base}.description`, 'placeholder="Optional"')));
      }
      if (['text', 'paragraph', 'address'].includes(item.kind)) parts.push(field('Placeholder', input(`${base}.placeholder`)));
      if (item.kind === 'number') parts.push(`<div class="fms-three">${field('Minimum', number(`${base}.min`))}${field('Maximum', number(`${base}.max`))}${field('Unit', input(`${base}.unit`, 'placeholder="sq ft"'))}</div>`);
      if (item.kind === 'select' || item.kind === 'multi_select') {
        parts.push(`<div class="fms-field"><span>Choices</span><div class="fms-opt head"><span>Label</span><span>Description</span><span></span></div>
          ${item.options.map((option, index) => `<div class="fms-opt"><input class="fms-in" data-path="${base}.options.${index}.label" data-option-label value="${esc(option.label)}"><input class="fms-in" data-path="${base}.options.${index}.description" value="${esc(option.description || '')}" placeholder="Optional"><button type="button" class="fms-icon-btn" data-act="option-remove" data-base="${base}" data-index="${index}" title="Remove"><i aria-hidden="true" class="fas fa-xmark"></i></button></div>`).join('')}
          <div><button type="button" class="fms-btn small" data-act="option-add" data-base="${base}"><i aria-hidden="true" class="fas fa-plus"></i> Add choice</button></div></div>`);
        parts.push(field('Show as', select(`${base}.style`, [['cards', 'Cards'], ['list', 'List'], ['dropdown', 'Dropdown']])));
      }
      if (item.kind === 'appointment') {
        const types = state.context.appointment_types;
        const chosen = types.find((type) => type.id === item.preset_id);
        parts.push(field('Appointment type', select(`${base}.preset_id`, [['', 'Choose\u2026'], ...types.map((type) => [type.id, type.bookable_online ? type.label : `${type.label} (multi-day or recurring)`, !type.bookable_online])], true),
          chosen ? `Books a ${chosen.duration_minutes}-minute visit${chosen.window_minutes > chosen.duration_minutes ? ` in a ${Math.round(chosen.window_minutes / 60 * 10) / 10}-hour arrival window` : ''}, staffed and scheduled by this appointment type's rules. Change those in Settings \u2192 Scheduling.`
            : 'Open times, duration, staffing and arrival windows come from the appointment type in Settings \u2192 Scheduling.'));
        parts.push(`<div class="fms-two">${field('Earliest booking', number(`${base}.min_notice_hours`, 'min="0" max="720"'), 'Hours of notice you need.')}${field('Book up to', number(`${base}.horizon_days`, 'min="1" max="365"'), 'Days ahead.')}</div>`);
      }
      if (item.kind === 'property_measurement') {
        parts.push(field('Measure', select(`${base}.source`, state.context.measurement_sources.map((source) => [source.id, source.label]), true), esc(state.context.measurement_sources.find((source) => source.id === item.source)?.description || '')));
        parts.push(field('Using the address from', select(`${base}.address_param`, [['', 'Choose\u2026'], ...items().filter((entry) => entry.kind === 'address').map((entry) => [entry.param, entry.label || 'Address'])]), 'The address block must come in an earlier step.'));
      }
      if (!['content', 'consent', 'contact', 'property_measurement'].includes(item.kind)) parts.push(check(`${base}.required`, 'Required'));
      parts.push(`<div class="fms-field"><span>Show this block</span>${conditionEditor(`${base}.visible_when`, answerSources(item.id))}</div>`);
      if (item.param && item.kind !== 'property_measurement' && item.kind !== 'appointment') {
        parts.push(`<details><summary class="fms-note" style="cursor:pointer">Advanced</summary><div class="fms-two" style="margin-top:10px">${field('Answer key', input(`${base}.param`, 'data-param pattern="[a-z][a-z0-9_]*"'), 'Used by pricing and conditions.')}${field('Save to project field', input(`${base}.maps_to`, 'placeholder="Custom field key"'), 'Optional. Writes the answer to this project custom field.')}</div></details>`);
      }
      parts.push(`<div class="fms-add"><button type="button" class="fms-btn small danger" data-act="item-remove" data-step="${stepIndex}" data-id="${esc(item.id)}"><i aria-hidden="true" class="fas fa-trash"></i> Remove block</button></div>`);
      return `<div class="fms-block-edit">${parts.join('')}</div>`;
    }
    function palette(stepIndex){
      const groups = [];
      for (const block of state.context.blocks) {
        let group = groups.find((entry) => entry.name === block.group);
        if (!group) groups.push(group = { name: block.group, blocks: [] });
        group.blocks.push(block);
      }
      const has = (kind) => items().some((item) => item.kind === kind);
      return `<div class="fms-palette">${groups.map((group) => `<h5>${esc(group.name)}</h5>${group.blocks.map((block) => {
        const taken = (block.kind === 'contact' || block.kind === 'appointment') && has(block.kind);
        return `<button type="button" data-act="item-add" data-step="${stepIndex}" data-kind="${esc(block.kind)}" ${!block.available || taken ? `disabled title="${taken ? 'A form can have one of these' : 'Not enabled for this organization'}"` : ''}><i aria-hidden="true" class="fas ${esc(block.icon)}"></i>${esc(block.label)}</button>`;
      }).join('')}`).join('')}</div>`;
    }
    function buildTab(){
      const steps = state.draft.steps;
      return steps.map((step, stepIndex) => `<div class="fms-card" data-step-card="${esc(step.id)}">
        <div class="fms-card-head"><span class="n">${stepIndex + 1}</span>
          <input data-path="steps.${stepIndex}.title" data-step-focus="${esc(step.id)}" value="${esc(step.title)}" placeholder="Step title (optional)">
          <button type="button" class="fms-icon-btn" data-act="step-move" data-step="${stepIndex}" data-dir="-1" ${stepIndex === 0 ? 'disabled' : ''} title="Move up"><i aria-hidden="true" class="fas fa-arrow-up"></i></button>
          <button type="button" class="fms-icon-btn" data-act="step-move" data-step="${stepIndex}" data-dir="1" ${stepIndex === steps.length - 1 ? 'disabled' : ''} title="Move down"><i aria-hidden="true" class="fas fa-arrow-down"></i></button>
          <button type="button" class="fms-icon-btn" data-act="step-remove" data-step="${stepIndex}" ${steps.length === 1 ? 'disabled' : ''} title="Delete step"><i aria-hidden="true" class="fas fa-trash"></i></button>
        </div>
        <div class="fms-card-body">
          ${step.items.map((item, itemIndex) => {
            const meta = kindMeta(item.kind);
            const open = state.openItem === item.id;
            const title = item.kind === 'contact' ? 'Contact details' : item.kind === 'content' ? (item.heading || 'Text') : (item.label || meta.label);
            return `<div class="fms-block ${open ? 'open' : ''}">
              <div class="fms-block-row" role="button" tabindex="0" data-act="item-toggle" data-id="${esc(item.id)}" data-step-id="${esc(step.id)}">
                <i aria-hidden="true" class="k fas ${esc(meta.icon)}"></i><span class="t"><b>${esc(title)}</b><small>${esc(blockSummary(item))}${item.required ? ' \u00b7 Required' : ''}${item.visible_when?.length ? ' \u00b7 Conditional' : ''}</small></span>
                <button type="button" class="fms-icon-btn" data-act="item-move" data-step="${stepIndex}" data-index="${itemIndex}" data-dir="-1" ${itemIndex === 0 && stepIndex === 0 ? 'disabled' : ''} title="Move up"><i aria-hidden="true" class="fas fa-arrow-up"></i></button>
                <button type="button" class="fms-icon-btn" data-act="item-move" data-step="${stepIndex}" data-index="${itemIndex}" data-dir="1" ${itemIndex === step.items.length - 1 && stepIndex === steps.length - 1 ? 'disabled' : ''} title="Move down"><i aria-hidden="true" class="fas fa-arrow-down"></i></button>
                <i aria-hidden="true" class="fas fa-chevron-${open ? 'up' : 'down'}" style="color:#98a2b3;font-size:11px"></i>
              </div>
              ${open ? blockEditor(item, `steps.${stepIndex}.items.${itemIndex}`, stepIndex) : ''}
            </div>`;
          }).join('') || '<div class="fms-note">This step is empty. Add a block below.</div>'}
          ${state.palette === step.id ? palette(stepIndex) : `<div class="fms-add"><button type="button" class="fms-btn small" data-act="palette" data-step-id="${esc(step.id)}"><i aria-hidden="true" class="fas fa-plus"></i> Add block</button></div>`}
        </div>
      </div>`).join('') + `<button type="button" class="fms-btn" data-act="step-add"><i aria-hidden="true" class="fas fa-plus"></i> Add step</button>`;
    }
    function newItem(kind){
      const meta = kindMeta(kind);
      const used = new Set(items().map((item) => item.param).filter(Boolean));
      const usedIds = new Set(items().map((item) => item.id));
      let param = { contact: 'contact', address: 'address', appointment: 'appointment', property_measurement: 'measurement', consent: 'consent', paragraph: 'message' }[kind] || 'question';
      for (let index = 2; used.has(param); index += 1) param = `${param.replace(/_\d+$/, '')}_${index}`;
      let id = param;
      while (usedIds.has(id)) id = uid(kind);
      const item = { id, kind, description: '', placeholder: '', options: [], visible_when: [], maps_to: '', fields: { name: { enabled: true, required: true }, email: { enabled: true, required: false }, phone: { enabled: true, required: true } }, min_notice_hours: 2, horizon_days: 45, label: { contact: '', content: '', consent: 'I agree to be contacted about my request.', appointment: 'Choose a day and time', address: 'Address', property_measurement: 'Measurements' }[kind] ?? 'New question', required: kind === 'appointment' || kind === 'consent' };
      if (meta.writes) { item.param = param; if (QUESTION_KINDS.has(kind)) autoKeys.add(id); }
      if (kind === 'select' || kind === 'multi_select') item.options = [{ value: 'option_1', label: 'Option 1' }, { value: 'option_2', label: 'Option 2' }];
      if (kind === 'appointment') item.preset_id = state.context.appointment_types.find((type) => type.bookable_online)?.id || '';
      if (kind === 'property_measurement') { item.source = state.context.measurement_sources[0]?.id || ''; item.address_param = items().find((entry) => entry.kind === 'address')?.param; }
      if (kind === 'content') item.heading = 'Heading';
      return item;
    }

    // --- Pricing tab ---------------------------------------------------------
    function pricingTab(){
      const calculation = state.draft.calculation;
      if (!calculation) {
        return `<div class="fms-section"><h4>Instant estimate</h4><p>Show visitors a price range as soon as they submit, calculated from their answers and your price table. The lead and its estimate land on the project together.</p>
          <div><button type="button" class="fms-btn primary" data-act="pricing-on"><i aria-hidden="true" class="fas fa-plus"></i> Add an estimate</button></div></div>`;
      }
      if (calculation.mode === 'code') {
        return `<div class="fms-section"><h4>Custom calculation</h4><p>JavaScript that runs in the document-module sandbox. It receives <code>inputs</code> (the answers) and <code>parameters</code>, and returns <code>{ outputs: { estimate: { currency, low, high, options } } }</code>.</p>
          ${field('Code', `<textarea class="fms-in fms-code" data-path="calculation.source" spellcheck="false">${esc(calculation.source)}</textarea>`)}
          ${field('Parameters (JSON)', `<textarea class="fms-in fms-code" style="min-height:110px" data-json="calculation.parameters" spellcheck="false">${esc(JSON.stringify(calculation.parameters, null, 2))}</textarea>`)}
          <div class="fms-add"><button type="button" class="fms-btn small" data-act="pricing-table">Use a price table instead</button><button type="button" class="fms-btn small danger" data-act="pricing-off">Remove estimate</button></div></div>`;
      }
      const pricing = calculation.pricing;
      const sources = answerSources();
      const quantities = sources.filter((source) => source.kind === 'number');
      const base = 'calculation.pricing';
      return `<div class="fms-section"><h4>What is priced</h4><p>Pick the answer that sets the size of the job. Each option below is priced per unit of it, or leave it flat.</p>
          ${field('Priced by', select(`${base}.quantity.param`, [['', 'Nothing \u2014 flat prices'], ...quantities.map((source) => [source.param, source.label])], true))}
          ${pricing.quantity.param ? `<div class="fms-three">${field('Shown as', input(`${base}.quantity.label`))}${field('Unit', input(`${base}.quantity.unit`, 'placeholder="sq ft"'))}${field('Typical size', number(`${base}.quantity.fallback`, 'min="0"'), 'Used when it cannot be measured.')}</div>` : ''}
        </div>
        <div class="fms-section"><h4>Options and prices</h4><p>Each option is shown to the visitor with its own range${pricing.quantity.param ? `: low and high price per ${esc(pricing.quantity.unit || 'unit')}` : ''}.</p>
          <div class="fms-price head"><span>Option</span><span>Low ${pricing.quantity.param ? 'rate' : 'price'}</span><span>High ${pricing.quantity.param ? 'rate' : 'price'}</span><span></span></div>
          ${pricing.options.map((option, index) => {
            const low = pricing.quantity.param ? 'low_rate' : 'flat_low';
            const high = pricing.quantity.param ? 'high_rate' : 'flat_high';
            return `<div class="fms-price"><input class="fms-in" data-path="${base}.options.${index}.label" value="${esc(option.label)}">${number(`${base}.options.${index}.${low}`, 'min="0" step="0.01"')}${number(`${base}.options.${index}.${high}`, 'min="0" step="0.01"')}<button type="button" class="fms-icon-btn" data-act="price-remove" data-index="${index}" ${pricing.options.length === 1 ? 'disabled' : ''} title="Remove"><i aria-hidden="true" class="fas fa-xmark"></i></button></div>
              <details style="margin:-2px 0 4px"><summary class="fms-note" style="cursor:pointer">Description, minimum and when to offer it</summary><div style="display:grid;gap:8px;margin-top:8px">${input(`${base}.options.${index}.description`, 'placeholder="Short description shown to the visitor"')}<div class="fms-two">${field('Minimum price', number(`${base}.options.${index}.minimum`, 'min="0"'))}<div class="fms-field"><span>Offer this option</span>${conditionEditor(`${base}.options.${index}.visible_when`, sources)}</div></div></div></details>`;
          }).join('')}
          <div><button type="button" class="fms-btn small" data-act="price-add"><i aria-hidden="true" class="fas fa-plus"></i> Add option</button></div>
        </div>
        <div class="fms-section"><h4>Adjustments</h4><p>Raise or lower every option by a percentage when an answer or measurement matches.</p>
          ${pricing.adjustments.map((adjustment, index) => `<div style="display:grid;gap:6px;padding:10px;border:1px solid #eaecf0;border-radius:10px"><div class="fms-price" style="grid-template-columns:minmax(0,1.5fr) 110px 28px"><input class="fms-in" data-path="${base}.adjustments.${index}.label" value="${esc(adjustment.label)}">${number(`${base}.adjustments.${index}.percent`, 'step="1" title="Percent"')}<button type="button" class="fms-icon-btn" data-act="adjust-remove" data-index="${index}" title="Remove"><i aria-hidden="true" class="fas fa-xmark"></i></button></div>${conditionEditor(`${base}.adjustments.${index}.when`, sources)}</div>`).join('')}
          <div><button type="button" class="fms-btn small" data-act="adjust-add"><i aria-hidden="true" class="fas fa-plus"></i> Add adjustment</button></div>
        </div>
        <div class="fms-section"><h4>Presentation</h4>
          <div class="fms-three">${field('Currency', input(`${base}.currency`, 'maxlength="3" style="text-transform:uppercase"'))}${field('Round to', number(`${base}.round_to`, 'min="1"'))}${pricing.quantity.param ? field('Waste %', number(`${base}.quantity.waste_percent`, 'min="0" max="100"')) : '<span></span>'}</div>
          ${field('Disclaimer', area(`${base}.disclaimer`))}
          <div class="fms-note">Try it in the preview: fill the form in and submit to see the estimate. Nothing is saved or sent.</div>
          <div class="fms-add"><button type="button" class="fms-btn small" data-act="pricing-code">Advanced: write the calculation in code</button><button type="button" class="fms-btn small danger" data-act="pricing-off">Remove estimate</button></div>
        </div>`;
    }

    // --- Design, settings, share, submissions --------------------------------
    function designTab(){
      const style = state.draft.presentation.style;
      const color = (path, label) => field(label, `<span class="fms-color"><input type="color" data-path="${path}" value="${esc(getPath(state.draft, path))}"><input class="fms-in" data-path="${path}" data-hex value="${esc(getPath(state.draft, path))}" maxlength="7"></span>`);
      return `<div class="fms-section"><h4>Wording</h4>
          ${field('Headline', input('presentation.headline'))}${field('Subheadline', area('presentation.subheadline'))}
          <div class="fms-three">${field('Next button', input('presentation.next_label'))}${field('Back button', input('presentation.back_label'))}${field('Submit button', input('presentation.submit_label'))}</div>
          ${field('Fine print', area('presentation.fine_print'), 'Shown under the submit button.')}
        </div>
        <div class="fms-section"><h4>Layout</h4>
          <div class="fms-two">${field('Flow', select('presentation.layout', [['steps', 'One step at a time'], ['page', 'Everything on one page']], true))}${state.draft.presentation.layout === 'steps' ? field('Progress', select('presentation.progress', [['bar', 'Progress bar'], ['dots', 'Dots'], ['none', 'Hidden']])) : '<span></span>'}</div>
        </div>
        <div class="fms-section"><h4>Look</h4>
          ${check('presentation.style.use_company_colors', 'Use company colors', true)}${check('presentation.style.logo_enabled', 'Show company logo')}
          ${style.use_company_colors ? '' : `<div class="fms-two">${color('presentation.style.primary_color', 'Accent color')}${color('presentation.style.text_color', 'Text color')}</div>`}
          <div class="fms-three">${field('Background', `<span class="fms-color"><input type="color" data-path="presentation.style.background_color" value="${esc(style.background_color)}"></span>`)}${field('Font', select('presentation.style.font_family', state.context.fonts.map((font) => [font, font])))}${field('Corners', select('presentation.style.corners', [['soft', 'Soft'], ['round', 'Round'], ['square', 'Square']]))}</div>
        </div>
        <div class="fms-section"><h4>After submitting</h4><p>${state.draft.calculation ? 'The estimate appears between the title and message.' : 'What visitors see once the form is sent.'}</p>
          ${field('Title', input('presentation.success.title'))}${field('Message', area('presentation.success.body'))}
          <div class="fms-two">${field('Button label', input('presentation.success.cta_label', 'placeholder="Optional"'))}${field('Button link', input('presentation.success.cta_url', 'placeholder="https://\u2026"'))}</div>
        </div>`;
    }
    function settingsTab(){
      const settings = state.draft.settings;
      const roles = (ctx.roles || []).length ? ctx.roles : [{ id: 'inside_sales', label: 'Inside Sales' }, { id: 'sales_appointments', label: 'Sales Appointments' }];
      return `<div class="fms-section"><h4>When someone submits</h4><p>Every submission creates a lead with the answers attached${state.draft.calculation ? ', the estimate' : ''}${items().some((item) => item.kind === 'appointment') ? ' and a booked appointment' : ''}.</p>
          <div class="fms-field"><span>Notify these roles</span><div class="fms-add">${roles.map((role) => `<label class="fms-check"><input type="checkbox" data-role="${esc(role.id)}" ${settings.notify_role_ids.includes(role.id) ? 'checked' : ''}>${esc(role.label)}</label>`).join('')}</div></div>
        </div>
        <div class="fms-section"><h4>Confirmation email</h4><p>Sent to the visitor when they give an email address. Includes the estimate and appointment time when the form has them.</p>
          ${check('settings.customer_email.enabled', 'Send a confirmation email', true)}
          ${settings.customer_email.enabled ? `${field('Subject', input('settings.customer_email.subject', 'placeholder="Uses the success title"'))}${field('Opening line', area('settings.customer_email.intro', 'placeholder="Uses the success message"'))}<div class="fms-two">${field('Button label', input('settings.customer_email.cta_label', 'placeholder="Optional"'))}${field('Button link', input('settings.customer_email.cta_url', 'placeholder="https://\u2026"'))}</div>` : ''}
        </div>
        <div class="fms-section"><h4>Tracking</h4>${field('Tracking key', input('settings.tracking_key', 'placeholder="e.g. homepage-hero"'), 'Stored on each lead so you can report on where it came from.')}</div>
        <div class="fms-section"><h4>Danger zone</h4><div class="fms-add"><button type="button" class="fms-btn small" data-act="duplicate" data-id="${esc(state.form.id)}"><i aria-hidden="true" class="fas fa-copy"></i> Duplicate form</button><button type="button" class="fms-btn small danger" data-act="delete" data-id="${esc(state.form.id)}"><i aria-hidden="true" class="fas fa-trash"></i> Delete form</button></div></div>`;
    }
    const embedSrc = () => `${location.origin}/libraries/forms-embed/firstmate-forms-embed.js`;
    const shareLink = () => `${location.origin}/libraries/forms-embed/form.html?k=${encodeURIComponent(state.form.public_key)}`;
    function shareTab(){
      if (!state.form.published) {
        return `<div class="fms-section"><h4>Publish to share</h4><p>Publishing makes the form available and gives you an embed code and a shareable link. You can keep editing afterwards; visitors only see changes once you publish them.</p><div><button type="button" class="fms-btn primary" data-act="publish">Publish form</button></div></div>`;
      }
      const snippet = `<script src="${embedSrc()}" data-form="${state.form.public_key}"></script>`;
      return `${state.form.status === 'paused' ? '<div class="fms-issues"><b>This form is paused</b>Visitors see a notice that it is not accepting responses.</div>' : ''}
        ${state.form.has_unpublished_changes || dirty ? '<div class="fms-section"><h4>You have unpublished changes</h4><p>Visitors still see the last published version.</p><div><button type="button" class="fms-btn primary" data-act="publish">Publish changes</button></div></div>' : ''}
        <div class="fms-section"><h4>Embed on any website</h4><p>Paste this where the form should appear. It adapts to the space it is given and never needs updating when you republish.</p>
          <div class="fms-code-box"><textarea class="fms-in" rows="3" readonly data-copy-source="embed">${esc(snippet)}</textarea><button type="button" class="fms-btn" data-act="copy" data-copy="embed"><i aria-hidden="true" class="fas fa-copy"></i> Copy</button></div></div>
        <div class="fms-section"><h4>Share a link</h4><p>A hosted page for texts, emails, social posts and QR codes.</p>
          <div class="fms-code-box"><input class="fms-in" readonly data-copy-source="link" value="${esc(shareLink())}"><button type="button" class="fms-btn" data-act="copy" data-copy="link"><i aria-hidden="true" class="fas fa-copy"></i> Copy</button><a class="fms-btn" href="${esc(shareLink())}" target="_blank" rel="noopener"><i aria-hidden="true" class="fas fa-arrow-up-right-from-square"></i> Open</a></div></div>
        <div class="fms-section"><h4>On your FirstMate website</h4><p>In the website editor, this form appears under Elements. Drag it onto any page.</p></div>
        <div class="fms-section"><h4>Availability</h4>
          <div class="fms-add"><button type="button" class="fms-btn small" data-act="pause">${state.form.status === 'paused' ? '<i aria-hidden="true" class="fas fa-play"></i> Resume form' : '<i aria-hidden="true" class="fas fa-pause"></i> Pause form'}</button><button type="button" class="fms-btn small danger" data-act="rotate"><i aria-hidden="true" class="fas fa-key"></i> Reset embed code</button></div>
          <div class="fms-note">Resetting the embed code immediately turns off every existing embed and link for this form.</div></div>`;
    }
    function submissionsTab(){
      if (!state.submissions) {
        api.submissions(orgId, state.form.id).then((rows) => { state.submissions = rows; if (state.tab === 'submissions') renderTab(); }).catch((error) => { state.submissions = []; toast('Could not load submissions', error.message, false); });
        return '<div class="fms-loading">Loading submissions\u2026</div>';
      }
      if (!state.submissions.length) return `<div class="fms-section"><h4>No submissions yet</h4><p>${state.form.published ? 'Share the form to start collecting responses. Each one appears here and as a new lead.' : 'Publish and share the form to start collecting responses.'}</p></div>`;
      const money = (estimate) => { try { const format = new Intl.NumberFormat(undefined, { style: 'currency', currency: estimate.currency || 'USD', maximumFractionDigits: 0 }); return `${format.format(estimate.low)} \u2013 ${format.format(estimate.high)}`; } catch { return ''; } };
      return `<div class="fms-section" style="padding:6px 6px 2px"><table class="fms-table"><thead><tr><th>Received</th><th>Contact</th><th>Details</th><th></th></tr></thead><tbody>${state.submissions.map((row) => `<tr>
        <td>${esc(new Date(row.created_at).toLocaleDateString())}<small>${esc(new Date(row.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}</small></td>
        <td><b>${esc(row.contact?.name || 'No name')}</b><small>${esc([row.contact?.phone, row.contact?.email].filter(Boolean).join(' \u00b7 '))}</small>${row.address ? `<small>${esc(row.address)}</small>` : ''}</td>
        <td>${row.estimate ? `<b>${esc(money(row.estimate))}</b>` : ''}${row.appointment ? `<small>${esc(row.appointment.status === 'booked' ? 'Booked' : 'Requested')}: ${esc(row.appointment.label)}</small>` : ''}${(row.summary || []).slice(0, 4).map((entry) => `<small>${esc(entry.label)}: ${esc(entry.value)}</small>`).join('')}</td>
        <td>${row.project_id && ctx.openProject ? `<button type="button" class="fms-btn small" data-act="open-project" data-id="${esc(row.project_id)}">Open lead</button>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>`;
    }

    // --- Events --------------------------------------------------------------
    async function publish(){
      const button = rootEl.querySelector('.fms-bar [data-act=publish]');
      if (button) { button.disabled = true; button.textContent = 'Publishing\u2026'; }
      state.issues = [];
      if (!(await flush())) { setSave('error', state.saveError); return; }
      try {
        const wasLive = !!state.form.published;
        state.form = await track(api.publish(orgId, state.form.id, state.form.revision));
        const index = state.forms.findIndex((form) => form.id === state.form.id);
        if (index >= 0) state.forms[index] = state.form;
        refreshStatus();
        setSave('saved');
        toast(wasLive ? 'Changes published' : 'Form published', wasLive ? 'Visitors now see the latest version.' : 'Grab the embed code or link from the Share tab.', true);
        if (!wasLive) state.tab = 'share';
        renderTabs();
        renderTab();
      } catch (error) {
        state.issues = Array.isArray(error.data?.details?.issues) && error.data.details.issues.length ? error.data.details.issues : [{ message: error.message }];
        const first = state.issues.find((issue) => issue.item_id);
        if (first) { state.tab = 'build'; state.openItem = first.item_id; renderTabs(); }
        renderTab();
        rootEl.querySelector('[data-pane]').scrollTop = 0;
        setSave('saved');
      }
    }
    async function act(target){
      const action = target.dataset.act;
      const stepIndex = Number(target.dataset.step);
      const draft = state.draft;
      switch (action) {
        case 'new': return openTemplateDialog();
        case 'create': return createFrom(target.dataset.template, target.dataset.assistant !== undefined);
        case 'open': return openEditor(state.forms.find((form) => form.id === target.dataset.id));
        case 'back': await flush(); ctx.onNavigate?.(''); return load();
        case 'publish': return publish();
        case 'restart': return preview?.reset();
        case 'duplicate': {
          await flush();
          try { const copy = await api.duplicate(orgId, target.dataset.id); state.forms.unshift(copy); toast('Form duplicated', copy.name, true); openEditor(copy); }
          catch (error) { toast('Could not duplicate', error.message, false); }
          return;
        }
        case 'delete': {
          const form = state.forms.find((entry) => entry.id === target.dataset.id);
          if (!form || !(await ctx.confirm?.(`Delete "${form.name}"? ${form.published ? 'Every embed and link for it stops working. ' : ''}Leads it already created are kept.`, { title: 'Delete form', okLabel: 'Delete' }))) return;
          try { clearTimeout(saveTimer); dirty = false; await api.remove(orgId, form.id); state.forms = state.forms.filter((entry) => entry.id !== form.id); toast('Form deleted', form.name, true); ctx.onNavigate?.(''); renderLibrary(); }
          catch (error) { toast('Could not delete', error.message, false); }
          return;
        }
        case 'pause': {
          await flush();
          try { state.form = await track(api.update(orgId, state.form.id, { enabled: state.form.status === 'paused' })); refreshStatus(); renderTab(); }
          catch (error) { toast('Could not update', error.message, false); }
          return;
        }
        case 'rotate': {
          if (!(await ctx.confirm?.('Reset the embed code? Every existing embed and link for this form stops working until you replace it with the new one.', { title: 'Reset embed code', okLabel: 'Reset' }))) return;
          await flush();
          try { state.form = await track(api.rotateKey(orgId, state.form.id)); renderTab(); toast('Embed code reset', 'Update your website with the new code.', true); }
          catch (error) { toast('Could not reset', error.message, false); }
          return;
        }
        case 'copy': {
          const source = rootEl.querySelector(`[data-copy-source="${target.dataset.copy}"]`);
          try { await navigator.clipboard.writeText(source.value); target.innerHTML = '<i aria-hidden="true" class="fas fa-check"></i> Copied'; setTimeout(() => { target.innerHTML = '<i aria-hidden="true" class="fas fa-copy"></i> Copy'; }, 1400); }
          catch { source.select(); }
          return;
        }
        case 'open-project': return ctx.openProject?.(target.dataset.id);
        case 'palette': state.palette = target.dataset.stepId; return renderTab();
        case 'item-toggle': {
          state.openItem = state.openItem === target.dataset.id ? '' : target.dataset.id;
          state.palette = '';
          renderTab();
          return preview?.goToStep(target.dataset.stepId);
        }
        case 'item-add': {
          const item = newItem(target.dataset.kind);
          draft.steps[stepIndex].items.push(item);
          state.openItem = item.id; state.palette = '';
          touch({ structure: true });
          return preview?.goToStep(draft.steps[stepIndex].id);
        }
        case 'item-remove': {
          const step = draft.steps[stepIndex];
          step.items = step.items.filter((item) => item.id !== target.dataset.id);
          state.openItem = '';
          return touch({ structure: true });
        }
        case 'item-move': {
          const index = Number(target.dataset.index), dir = Number(target.dataset.dir);
          const step = draft.steps[stepIndex];
          const [item] = step.items.splice(index, 1);
          const next = index + dir;
          if (next < 0) draft.steps[stepIndex - 1].items.push(item);
          else if (next > step.items.length) draft.steps[stepIndex + 1].items.unshift(item);
          else step.items.splice(next, 0, item);
          return touch({ structure: true });
        }
        case 'step-add': {
          const step = { id: uid('step'), title: '', description: '', visible_when: [], items: [] };
          draft.steps.push(step);
          state.palette = step.id;
          return touch({ structure: true });
        }
        case 'step-remove': {
          if (draft.steps[stepIndex].items.length && !(await ctx.confirm?.('Delete this step and the blocks in it?', { title: 'Delete step', okLabel: 'Delete' }))) return;
          draft.steps.splice(stepIndex, 1);
          return touch({ structure: true });
        }
        case 'step-move': {
          const dir = Number(target.dataset.dir);
          const [step] = draft.steps.splice(stepIndex, 1);
          draft.steps.splice(stepIndex + dir, 0, step);
          return touch({ structure: true });
        }
        case 'option-add': {
          const options = getPath(draft, `${target.dataset.base}.options`);
          let n = options.length + 1;
          while (options.some((option) => option.value === `option_${n}`)) n += 1;
          options.push({ value: `option_${n}`, label: `Option ${n}`, description: '', image_url: '' });
          return touch({ structure: true });
        }
        case 'option-remove': getPath(draft, `${target.dataset.base}.options`).splice(Number(target.dataset.index), 1); return touch({ structure: true });
        case 'pricing-on': {
          const quantity = answerSources().find((source) => source.kind === 'number');
          draft.calculation = { mode: 'pricing', pricing: { currency: 'USD', quantity: { param: quantity?.param || '', label: quantity ? clean(quantity.label).replace(/ \(measured\)$/, '') : 'Quantity', unit: quantity?.unit || '', fallback: 0, waste_percent: 0 }, options: [{ id: 'standard', label: 'Standard', description: '', low_rate: 0, high_rate: 0, flat_low: 0, flat_high: 0, minimum: 0, visible_when: [] }], adjustments: [], round_to: 50, disclaimer: 'This is a preliminary estimate. Final pricing is confirmed after we review the details with you.' } };
          return touch({ structure: true });
        }
        case 'pricing-off': {
          if (!(await ctx.confirm?.('Remove the estimate from this form? The price table is discarded.', { title: 'Remove estimate', okLabel: 'Remove' }))) return;
          draft.calculation = null;
          renderTabs();
          return touch({ structure: true });
        }
        case 'pricing-code': {
          if (!(await ctx.confirm?.('Switch to a custom calculation? The price table is replaced by code you maintain.', { title: 'Custom calculation', okLabel: 'Switch' }))) return;
          draft.calculation = { mode: 'code', parameters: { currency: draft.calculation.pricing.currency, rate_low: 4, rate_high: 6 }, source: "// inputs: the visitor's answers. parameters: the JSON below.\nconst size = Number(inputs.size) || 0;\nif (!size) throw new Error('A size is required.');\nreturn { outputs: { estimate: {\n  currency: parameters.currency,\n  low: Math.round(size * parameters.rate_low),\n  high: Math.round(size * parameters.rate_high)\n} } };\n" };
          return touch({ structure: true });
        }
        case 'pricing-table': draft.calculation = null; return act({ dataset: { act: 'pricing-on' } });
        case 'price-add': draft.calculation.pricing.options.push({ id: uid('option'), label: 'New option', description: '', low_rate: 0, high_rate: 0, flat_low: 0, flat_high: 0, minimum: 0, visible_when: [] }); return touch({ structure: true });
        case 'price-remove': draft.calculation.pricing.options.splice(Number(target.dataset.index), 1); return touch({ structure: true });
        case 'adjust-add': draft.calculation.pricing.adjustments.push({ id: uid('adjust'), label: 'Adjustment', percent: 10, when: [] }); return touch({ structure: true });
        case 'adjust-remove': draft.calculation.pricing.adjustments.splice(Number(target.dataset.index), 1); return touch({ structure: true });
      }
    }
    function onClick(event){
      const tab = event.target.closest('[data-tab]');
      if (tab) { if (tab.dataset.tab === state.tab) return; state.tab = tab.dataset.tab; state.palette = ''; if (state.tab === 'submissions') state.submissions = null; renderTabs(); return renderTab(); }
      const device = event.target.closest('[data-device-mode]');
      if (device) {
        state.device = device.dataset.deviceMode;
        rootEl.querySelectorAll('[data-device-mode]').forEach((button) => button.classList.toggle('on', button === device));
        return rootEl.querySelector('[data-stage]').classList.toggle('phone', state.device === 'phone');
      }
      const target = event.target.closest('[data-act]');
      if (!target || target.disabled || !rootEl.contains(target)) return;
      // Controls inside a row act on their own; the row itself opens.
      if (['open', 'item-toggle'].includes(target.dataset.act) && event.target.closest('button,a,input,select,textarea') && event.target.closest('button,a,input,select,textarea') !== target) return;
      event.preventDefault();
      void act(target);
    }
    function onKey(event){
      if ((event.key === 'Enter' || event.key === ' ') && event.target.matches?.('[role=button][data-act]')) { event.preventDefault(); void act(event.target); }
    }
    function onInput(event){
      const el = event.target;
      // Blurring a field fires "change" with nothing new. Skipping those keeps the preview from
      // repainting under a click the user has just made in it.
      if (el.matches('[data-name]')) { if (state.name === el.value) return; state.name = el.value; return touch(); }
      if (state.view !== 'editor') return;
      if (el.dataset.role) {
        const roles = new Set(state.draft.settings.notify_role_ids);
        if (roles.has(el.dataset.role) === el.checked) return;
        if (el.checked) roles.add(el.dataset.role); else roles.delete(el.dataset.role);
        state.draft.settings.notify_role_ids = [...roles];
        return touch();
      }
      if (el.dataset.json) {
        try { setPath(state.draft, el.dataset.json, JSON.parse(el.value || '{}')); el.style.borderColor = ''; touch(); } catch { el.style.borderColor = '#dc2626'; }
        return;
      }
      if (el.dataset.cond) {
        if (event.type !== 'change' && el.tagName === 'SELECT') return;
        const path = el.dataset.cond;
        const conditions = getPath(state.draft, path) || [];
        const key = el.dataset.condField;
        if (key === 'param') {
          if (!el.value) setPath(state.draft, path, []);
          else {
            const source = [...answerSources()].find((entry) => entry.param === el.value);
            // Only the first rule is edited here; any further rules a template or the assistant added are kept.
            setPath(state.draft, path, [{ param: el.value, op: source?.kind === 'boolean' ? 'answered' : 'eq', ...(source?.options?.length ? { value: source.options[0].value } : source?.kind === 'boolean' ? {} : { value: '' }) }, ...conditions.slice(1)]);
          }
          return touch({ structure: true });
        }
        if (!conditions[0]) return;
        if (key === 'op') {
          conditions[0].op = el.value;
          const current = conditions[0].value;
          if (['answered', 'empty'].includes(el.value)) delete conditions[0].value;
          else if (el.value === 'in') conditions[0].value = Array.isArray(current) ? current : current === undefined || current === '' ? [] : [current];
          else if (Array.isArray(current)) conditions[0].value = current[0] ?? '';
          else if (current === undefined) conditions[0].value = '';
          if (NUMERIC_OPS.includes(el.value)) conditions[0].value = Number(conditions[0].value) || 0;
          return touch({ structure: true });
        }
        const next = conditions[0].op === 'in'
          ? (el.multiple ? [...el.selectedOptions].map((option) => option.value) : el.value.split(',').map((entry) => entry.trim()).filter(Boolean))
          : NUMERIC_OPS.includes(conditions[0].op) ? Number(el.value) || 0 : el.value;
        if (JSON.stringify(conditions[0].value) === JSON.stringify(next)) return;
        conditions[0].value = next;
        return touch();
      }
      const path = el.dataset.path;
      if (!path) return;
      if (el.tagName === 'SELECT' && event.type !== 'change') return;
      let value = el.dataset.type === 'bool' ? el.checked : el.dataset.type === 'number' ? (el.value === '' ? undefined : Number(el.value)) : el.value;
      if (el.dataset.type === 'number' && value !== undefined && !Number.isFinite(value)) return;
      if (el.dataset.hex !== undefined && !/^#[0-9a-f]{6}$/i.test(value)) return;
      if (el.type === 'color') { const hex = el.parentElement.querySelector('[data-hex]'); if (hex) hex.value = value; }
      if (path.endsWith('.currency')) value = clean(value).toUpperCase();
      if (el.dataset.param !== undefined) {
        // Renaming an answer key keeps conditions and pricing that point at it working.
        const next = slug(value, '');
        const previous = getPath(state.draft, path);
        if (!next || next === previous || items().some((item) => item.param === next)) return;
        renameParam(getPath(state.draft, path.replace(/\.param$/, '')), next);
        value = next;
      }
      // Number fields with no value fall back to the schema default rather than failing validation.
      if (value === undefined && !/\.(min|max)$/.test(path)) value = 0;
      const rerender = el.dataset.rerender !== undefined && event.type === 'change';
      if (getPath(state.draft, path) === value && !rerender) return;
      setPath(state.draft, path, value);
      if (el.dataset.optionLabel !== undefined) {
        // Choice values follow their labels until something references them.
        const optionPath = path.replace(/\.label$/, '');
        const options = getPath(state.draft, optionPath.replace(/\.\d+$/, ''));
        const option = getPath(state.draft, optionPath);
        const next = slug(value, option.value);
        const referenced = JSON.stringify([state.draft.calculation, state.draft.steps.map((step) => [step.visible_when, step.items.map((item) => item.visible_when)])]).includes(`"value":"${option.value}"`);
        if (!referenced && !options.some((entry) => entry !== option && entry.value === next)) option.value = next;
      }
      const labelMatch = /^(steps\.\d+\.items\.\d+)\.label$/.exec(path);
      if (labelMatch) {
        const item = getPath(state.draft, labelMatch[1]);
        if (autoKeys.has(item.id)) {
          const next = slug(value, item.param);
          if (next !== item.param && !items().some((entry) => entry !== item && entry.param === next)) renameParam(item, next);
        }
      }
      touch({ structure: rerender });
      if (el.dataset.stepFocus) preview?.goToStep(el.dataset.stepFocus);
    }
    /** Renames a block's answer key and everything that points at it: conditions, pricing and measurements. */
    function renameParam(item, next){
      const previous = item.param;
      const rewrite = (node) => {
        if (Array.isArray(node)) return node.forEach(rewrite);
        if (!node || typeof node !== 'object') return;
        for (const [key, child] of Object.entries(node)) {
          if (key === 'param' && typeof child === 'string' && node !== item) {
            if (child === previous) node.param = next;
            else if (child.startsWith(`${previous}.`)) node.param = next + child.slice(previous.length);
          } else if (key === 'address_param' && child === previous) node.address_param = next;
          else rewrite(child);
        }
      };
      rewrite(state.draft);
      item.param = next;
    }
    function onFocus(event){
      const card = event.target.closest?.('[data-step-card]');
      if (card && state.view === 'editor') preview?.goToStep(card.dataset.stepCard);
    }

    async function load(){
      try {
        const [context, forms] = await Promise.all([state.context || api.context(orgId), api.list(orgId)]);
        if (destroyed) return;
        state.context = context;
        state.forms = forms;
        const requested = clean(ctx.initialFormId);
        ctx.initialFormId = '';
        const form = requested && forms.find((entry) => entry.id === requested);
        if (form) openEditor(form); else renderLibrary();
      } catch (error) {
        rootEl.innerHTML = `<div class="fms-loading">${esc(error.message || 'Could not load forms.')}</div>`;
      }
    }

    rootEl.addEventListener('click', onClick);
    rootEl.addEventListener('keydown', onKey);
    rootEl.addEventListener('input', onInput);
    rootEl.addEventListener('change', onInput);
    rootEl.addEventListener('focusin', onFocus);
    const beforeUnload = () => { if (dirty) void flush(); };
    root.addEventListener('beforeunload', beforeUnload);
    const controller = {
      destroy(){
        destroyed = true;
        if (dirty) void flush();
        preview?.destroy();
        assistant?.destroy();
        root.removeEventListener('beforeunload', beforeUnload);
        controllers.delete(host);
      }
    };
    controllers.set(host, controller);
    if (!api) rootEl.innerHTML = '<div class="fms-loading">Forms are unavailable in this session.</div>';
    else void load();
    return controller;
  }

  root.FirstMateFormsSettings = { mount };
})(window);
