/* public/libraries/apps/people/pay-sheets-editor.js
 *
 * The pay sheet editor: how one assignee is paid for one kind of work, written for the person who runs the office
 * (docs/architecture/pay-sheets.md). No ids, formulas or JSON by default: pay lines read as sentences, the inputs a
 * line reads are made when it picks what it is paid per, and what the sheet leaves open is shown before saving.
 *
 *   const editor = FirstMatePeople.paySheetEditor.mount(host, {
 *     orgId, sheet,                 // a saved sheet, or a draft from paySheetModel.starter()
 *     vocab,                        // paySheetModel.vocabulary(kinds-of-work response)
 *     sheets,                       // every sheet, for the one-sheet-per-kind-of-work check and Duplicate
 *     assigneeName,                 // shown in the header
 *     readOnly, canTry,             // canTry: the viewer may price a project (manage_projects)
 *     onDirty(isDirty), onSaved(sheet), onArchived(sheet), onDuplicated(sheet), onBack()   // onBack draws a back link
 *     onStatus(state, text)         // the modal footer's status, cleared once nothing is highlighted any more
 *   });
 *   editor.save() -> Promise<sheet>   (rejects with a message the modal shows as a notice when something needs fixing)
 *   editor.isDirty()   editor.destroy()   editor.el
 *
 * Also fills the People 'pay_sheets' slot: an assignee's sheets by kind of work, with "Add pay sheet for a kind of
 * work", opening the editor in place. The slot's tab and actions are gated by FirstMatePeople.data.ACTIONS.pay_sheets.
 */
(function(){
  'use strict';
  const People = window.FirstMatePeople = window.FirstMatePeople || {};
  if (People.paySheetEditor) return;
  const kit = People.kit;
  const model = People.paySheetModel;
  const { esc, t, tip } = kit;
  const { money, amount, unitWord, lowerFirst } = model;
  const text = (value) => String(value ?? '').trim();
  const arr = (value) => (Array.isArray(value) ? value : []);
  const ICON = 'fa-file-invoice-dollar';
  const KIND_ICONS = { organization_user:kit.ICONS.user, resource_group:kit.ICONS.group, organization_connection:kit.ICONS.company };

  function ensureStyles(){
    if (document.getElementById('pp_paysheet_css')) return;
    const style = document.createElement('style');
    style.id = 'pp_paysheet_css';
    style.textContent = `
      .ps-ed{display:grid;gap:18px;min-width:0;container-type:inline-size;padding-bottom:8px}
      .ps-back{display:inline-flex;align-items:center;gap:7px;justify-self:start;height:28px;margin:-4px 0 -8px -6px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--pp-muted);font-size:12px;font-weight:650;cursor:pointer}
      .ps-back:hover{background:var(--pp-hover);color:var(--pp-text)}
      .ps-head{display:grid;gap:12px;padding:16px;border:1px solid var(--pp-line);border-radius:14px;background:linear-gradient(180deg,var(--pp-soft),var(--pp-panel) 70%)}
      .ps-head-top{display:flex;align-items:center;gap:10px;min-width:0}
      .ps-head-icon{display:grid;place-items:center;flex:none;width:36px;height:36px;border-radius:10px;background:var(--primary,#d93025);color:var(--on-primary,#fff);font-size:15px}
      .ps-name{flex:1;min-width:0;height:36px;margin:0;padding:0 8px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--pp-text);font:inherit;font-size:17px;font-weight:700;outline:0;transition:border-color .12s ease,background .12s ease}
      .ps-name:hover:not(:disabled){border-color:var(--pp-line)}
      .ps-name:focus{border-color:var(--pp-accent);background:var(--pp-panel);box-shadow:0 0 0 3px rgba(var(--pp-accent-rgb),.1)}
      .ps-head-actions{display:flex;align-items:center;gap:6px;flex:none}
      .ps-head-meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px 18px;min-width:0}
      .ps-meta{display:inline-flex;align-items:center;gap:8px;min-width:0}
      .ps-meta>span:first-child{color:var(--pp-muted);font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap}
      .ps-meta .pp-select{min-width:170px}
      .ps-meta .pp-input{height:32px}
      .ps-meta b{display:inline-flex;align-items:center;gap:7px;min-width:0;color:var(--pp-strong);font-size:13px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .ps-summary{display:flex;gap:10px;margin:0;padding:10px 12px;border-radius:10px;background:var(--pp-panel);border:1px solid var(--pp-line-soft);color:var(--pp-strong);font-size:13.5px;line-height:1.45}
      .ps-summary>i{flex:none;margin-top:3px;color:var(--pp-faint);font-size:12px}
      .ps-strip{display:flex;flex-wrap:wrap;align-items:center;gap:5px}
      .ps-strip-label{margin-right:4px;color:var(--pp-muted);font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
      .ps-strip .pp-chip{max-width:220px}
      .ps-banner{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--pp-danger-line);border-radius:10px;background:var(--pp-danger-bg);color:var(--pp-danger);font-size:12.5px;font-weight:600}
      .ps-banner>span{flex:1;min-width:0}
      .ps-banner.notice{border-color:var(--pp-warn-line);background:var(--pp-warn-bg);color:var(--pp-warn)}
      .ps-sec{display:grid;gap:8px;min-width:0}
      .ps-sec-head{display:flex;align-items:center;gap:8px;min-height:30px;padding-bottom:6px;border-bottom:1px solid var(--pp-line-soft)}
      .ps-sec-head>i{width:16px;text-align:center;color:var(--pp-faint);font-size:12px}
      .ps-sec-head h3{margin:0;color:var(--pp-text);font-size:14px;font-weight:700}
      .ps-sec-head .ps-count{color:var(--pp-muted);font-size:12px;font-variant-numeric:tabular-nums}
      .ps-sec-head .ps-spacer{flex:1}
      .ps-sec-head .pp-btn{height:30px;padding:0 10px}
      .ps-empty{padding:12px;border:1px dashed var(--pp-line);border-radius:10px;color:var(--pp-muted);font-size:12.5px;text-align:center}
      .ps-err{margin:2px 0 0;color:var(--pp-danger);font-size:11.5px;font-weight:600}
      .ps-ed [aria-invalid="true"]{border-color:var(--pp-danger)!important;box-shadow:0 0 0 3px rgba(180,35,24,.08)}
      .ps-money{position:relative;display:inline-flex;align-items:center;flex:none}
      .ps-money>span{position:absolute;left:9px;color:var(--pp-muted);font-size:12.5px;pointer-events:none}
      .ps-money>input{width:96px;padding-left:20px!important;text-align:right;font-variant-numeric:tabular-nums}
      .ps-num{width:84px;text-align:right;font-variant-numeric:tabular-nums}
      .ps-ed .pp-input{height:34px}
      .ps-ed select.pp-input{padding-right:28px}

      .ps-line{display:grid;gap:7px;padding:10px;border:1px solid var(--pp-line);border-radius:12px;background:var(--pp-panel);transition:border-color .12s ease,box-shadow .12s ease}
      .ps-line:focus-within{border-color:#d0d5dd;box-shadow:0 4px 14px rgba(16,24,40,.06)}
      .ps-line.invalid{border-color:var(--pp-danger-line)}
      .ps-line-main{display:grid;grid-template-columns:minmax(150px,1.4fr) minmax(120px,.9fr) minmax(150px,1.2fr) auto auto;align-items:center;gap:8px}
      .ps-line-per{display:flex;align-items:center;gap:6px;min-width:0}
      .ps-line-per>em{flex:none;color:var(--pp-muted);font-size:12px;font-style:normal}
      .ps-line-per>.pp-select{flex:1;min-width:0}
      .ps-line-price{display:flex;align-items:center;gap:4px}
      .ps-unit{min-width:26px;color:var(--pp-muted);font-size:12px;font-weight:600;white-space:nowrap}
      .ps-line-tools{display:flex;align-items:center;gap:0}
      .ps-line-facts{display:flex;flex-wrap:wrap;align-items:center;gap:5px;min-height:20px}
      .ps-line-facts>.ps-fact-label{color:var(--pp-faint);font-size:11px;font-weight:650}
      .ps-line-facts .pp-chip{max-width:200px}
      .ps-line-more{display:grid;gap:10px;padding:10px;border-radius:10px;background:var(--pp-soft)}
      .ps-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
      .ps-field{display:grid;gap:4px;min-width:0}
      .ps-field>span{display:flex;align-items:center;gap:4px;color:var(--pp-muted);font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
      .ps-covers{display:flex;flex-wrap:wrap;gap:5px}
      .ps-covers .pp-choice{height:24px;font-size:11.5px}

      .ps-table{display:grid;border:1px solid var(--pp-line);border-radius:12px;overflow:hidden}
      .ps-tr{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1.2fr) 96px 120px;align-items:center;gap:10px;min-height:42px;padding:4px 12px;border-top:1px solid var(--pp-line-soft)}
      .ps-tr:first-child{border-top:0}
      .ps-tr.head{min-height:30px;background:var(--pp-soft);color:var(--pp-muted);font-size:10.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase}
      .ps-tr.under>.ps-td-name{padding-left:20px}
      .ps-tr.under>.ps-td-name>i{position:absolute;left:2px;top:4px;color:var(--pp-faint);font-size:10px}
      .ps-td-name{position:relative;display:grid;gap:1px;min-width:0}
      .ps-td-name>strong{color:var(--pp-text);font-size:13px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .ps-td-name>small{color:var(--pp-faint);font-size:11px}
      .ps-td-hours{display:flex;align-items:center;gap:5px;justify-content:flex-end}
      .ps-td-hours>.ps-num{width:70px;height:30px}
      .ps-td-hours>small{min-width:28px;color:var(--pp-faint);font-size:11px;white-space:nowrap}
      .ps-check{display:inline-flex;align-items:center;gap:7px;color:var(--pp-strong);font-size:12px;font-weight:600;cursor:pointer}
      .ps-check>input{width:16px;height:16px;margin:0;accent-color:var(--pp-accent)}
      .ps-check.disabled{opacity:.45;cursor:default}

      .ps-eq{display:grid;gap:8px;padding:10px;border:1px solid var(--pp-line);border-radius:12px}
      .ps-eq-main{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
      .ps-eq-main>.ps-eq-name{flex:1 1 180px;min-width:0}
      .ps-provide{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 10px;border-radius:9px;background:var(--pp-soft);font-size:12.5px;color:var(--pp-strong)}
      .ps-provide>.pp-select{flex:0 1 200px;min-width:140px}
      .ps-provide .ps-num{height:30px;width:72px}
      .ps-link{display:inline-flex;align-items:center;gap:6px;justify-self:start;height:26px;padding:0 6px;border:0;border-radius:7px;background:transparent;color:var(--pp-accent);font-size:12px;font-weight:650;cursor:pointer}
      .ps-link:hover{background:var(--pp-hover)}
      .ps-sentence{display:flex;flex-wrap:wrap;align-items:center;gap:8px;color:var(--pp-strong);font-size:13px}
      .ps-sentence .pp-select{min-width:170px}
      .ps-preview{display:inline-flex;align-items:center;gap:7px;color:var(--pp-muted);font-size:12.5px}
      .ps-preview>b{color:var(--pp-text)}

      .ps-inputs .ps-tr{grid-template-columns:minmax(0,1.2fr) minmax(0,1.6fr) 92px 92px 92px 30px}
      .ps-inputs .ps-tr .pp-input{height:30px}
      .ps-src{display:flex;align-items:center;gap:6px;min-width:0;color:var(--pp-strong);font-size:12px}
      .ps-src>i{color:var(--pp-faint);font-size:11px}

      .ps-try{display:grid;gap:12px;padding:14px;border:1px solid var(--pp-line);border-radius:14px;background:var(--pp-soft)}
      .ps-try-pick{position:relative;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .ps-try-pick>.pp-search{flex:1 1 260px;max-width:420px}
      .ps-try-results{position:absolute;left:0;top:calc(100% + 4px);z-index:5;display:grid;gap:1px;width:min(420px,100%);max-height:280px;padding:5px;overflow:auto;border:1px solid var(--pp-line);border-radius:12px;background:var(--pp-panel);box-shadow:var(--pp-shadow)}
      .ps-try-results>button{display:grid;gap:1px;padding:7px 9px;border:0;border-radius:8px;background:transparent;text-align:left;cursor:pointer}
      .ps-try-results>button:hover,.ps-try-results>button:focus-visible{background:var(--pp-hover);outline:0}
      .ps-try-results strong{color:var(--pp-text);font-size:13px;font-weight:650}
      .ps-try-results small{color:var(--pp-muted);font-size:11.5px}
      .ps-try-project{display:inline-flex;align-items:center;gap:8px;height:34px;padding:0 6px 0 12px;border:1px solid var(--pp-line);border-radius:9px;background:var(--pp-panel);color:var(--pp-text);font-size:13px;font-weight:650}
      .ps-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
      .ps-tile{display:grid;gap:3px;padding:10px 12px;border:1px solid var(--pp-line);border-radius:11px;background:var(--pp-panel)}
      .ps-tile>span{color:var(--pp-muted);font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
      .ps-tile>b{color:var(--pp-text);font-size:20px;font-weight:700;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
      .ps-tile>small{color:var(--pp-muted);font-size:11.5px}
      .ps-tile.warn{border-color:var(--pp-warn-line);background:var(--pp-warn-bg)}
      .ps-tile.warn>b{color:var(--pp-warn)}
      .ps-lines{display:grid;border:1px solid var(--pp-line);border-radius:11px;background:var(--pp-panel);overflow:hidden}
      .ps-lines>div{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:12px;min-height:36px;padding:4px 12px;border-top:1px solid var(--pp-line-soft);font-size:12.5px}
      .ps-lines>div:first-child{border-top:0}
      .ps-lines>div>span:first-child{min-width:0;color:var(--pp-text);font-weight:600;overflow:hidden;text-overflow:ellipsis}
      .ps-lines>div>em{color:var(--pp-muted);font-style:normal;white-space:nowrap;font-variant-numeric:tabular-nums}
      .ps-lines>div>b{min-width:72px;text-align:right;font-variant-numeric:tabular-nums}
      .ps-lines>div.unresolved{background:var(--pp-warn-bg)}
      .ps-lines>div.unresolved>b{color:var(--pp-warn)}
      .ps-lines>div.total{background:var(--pp-soft);font-weight:700}
      .ps-lines>div.muted>span:first-child,.ps-lines>div.muted>b{color:var(--pp-muted)}
      .ps-read{display:grid;border:1px solid var(--pp-line);border-radius:11px;background:var(--pp-panel);overflow:hidden}
      .ps-read>div{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) 120px;align-items:center;gap:10px;min-height:38px;padding:4px 12px;border-top:1px solid var(--pp-line-soft);font-size:12.5px}
      .ps-read>div:first-child{border-top:0}
      .ps-read>div>span:first-child{color:var(--pp-text);font-weight:600}
      .ps-read>div>em{color:var(--pp-muted);font-style:normal}
      .ps-read>div>em.missing{color:var(--pp-warn);font-weight:600}
      .ps-read .ps-num{width:100%;height:30px}
      .ps-sub{margin:4px 0 -2px;color:var(--pp-muted);font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
      .ps-note{margin:0;color:var(--pp-muted);font-size:12px}

      .ps-sheet-list{display:grid;gap:12px}
      .ps-capable{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px dashed var(--pp-warn-line);border-radius:11px;background:var(--pp-warn-bg);color:var(--pp-warn);font-size:12.5px;font-weight:600}
      .ps-capable>span{flex:1;min-width:0}
      .ps-capable .pp-btn{height:28px}
      @container (max-width:560px){.pp-list.ps-all .pp-row-title .pp-pill:not(.warn){display:none}}
      .ps-read>div>em.none{color:var(--pp-faint)}

      @container (max-width:640px){
        .ps-line-main{grid-template-columns:minmax(0,1fr) auto}
        .ps-line-main>.ps-line-label{grid-column:1/-1}
        .ps-line-main>.ps-line-kind{grid-column:1/2}
        .ps-line-main>.ps-line-tools{grid-column:2/3;grid-row:2;justify-self:end}
        .ps-line-main>.ps-line-per{grid-column:1/2;grid-row:3}
        .ps-line-main>.ps-line-price{grid-column:2/3;grid-row:3}
        .ps-line-main>.ps-line-per:empty{display:none}
        .ps-line-main>.ps-line-per:empty+.ps-line-price{grid-column:1/-1}
        .ps-line-price .ps-money>input{width:88px}
        .ps-line-per>em{display:none}
        .ps-tr{grid-template-columns:minmax(0,1fr) auto;row-gap:6px;padding:8px 12px}
        .ps-tr.head{display:none}
        .ps-tr>.ps-td-state{grid-column:1/-1;grid-row:2}
        .ps-tr>.ps-td-free{grid-column:1/2;grid-row:3}
        .ps-tr>.ps-td-hours{grid-column:2/3;grid-row:3}
        .ps-inputs .ps-tr{grid-template-columns:minmax(0,1fr) 30px}
        .ps-inputs .ps-tr>*{grid-column:1/2;grid-row:auto}
        .ps-inputs .ps-tr>.ps-in-remove{grid-column:2/3;grid-row:1}
        .ps-read>div{grid-template-columns:minmax(0,1fr) 110px}
        .ps-read>div>em{grid-column:1/2;grid-row:2;font-size:11.5px}
        .ps-read>div>:last-child{grid-column:2/3;grid-row:1/3}
        .ps-head{padding:12px}
        .ps-head-top{flex-wrap:wrap}
        .ps-name{flex:1 1 200px;font-size:16px}
        .ps-meta{flex:1 1 100%}
        .ps-meta .pp-select{flex:1;min-width:0}
      }
    `;
    document.head.appendChild(style);
  }

  /* One dropdown with groups; the kit's select has none. */
  function select(options = {}){
    const group = (entries) => entries.map((item) => `<option value="${esc(item.value)}" ${String(item.value) === String(options.value ?? '') ? 'selected' : ''} ${item.disabled ? 'disabled' : ''}>${esc(item.label)}</option>`).join('');
    const body = (options.groups || []).filter((entry) => entry.options.length).map((entry) => (entry.label ? `<optgroup label="${esc(entry.label)}">${group(entry.options)}</optgroup>` : group(entry.options))).join('');
    return `<span class="pp-select ${esc(options.className || '')}"><select class="pp-input" ${options.attrs || ''} aria-label="${esc(options.label || '')}" ${options.disabled ? 'disabled' : ''} ${options.invalid ? 'aria-invalid="true"' : ''}>${options.placeholder != null ? `<option value="" ${!options.value ? 'selected' : ''}>${esc(options.placeholder)}</option>` : ''}${body}</select><i class="fas fa-chevron-down" aria-hidden="true"></i></span>`;
  }
  const dollars = (cents) => (cents === undefined || cents === null || cents === '' || Number.isNaN(Number(cents)) ? '' : (Number(cents) / 100).toFixed(2));
  const toCents = (value) => { const raw = text(value).replace(/[$,\s]/g, ''); if (!raw) return undefined; const number = Number(raw); return Number.isFinite(number) && number >= 0 ? Math.round(number * 100) : NaN; };
  const toNumber = (value) => { const raw = text(value).replace(/,/g, ''); if (!raw) return undefined; const number = Number(raw); return Number.isFinite(number) && number >= 0 ? number : NaN; };

  function mount(host, options = {}){
    ensureStyles();
    const vocab = options.vocab;
    const orgId = text(options.orgId);
    const readOnly = options.readOnly === true;
    const dis = readOnly ? 'disabled' : '';
    let sheets = arr(options.sheets);
    let draft = model.draftOf(options.sheet || {});
    let baseline = JSON.stringify(model.payload(draft));
    let dirty = !draft.id;
    let advanced = false;
    let issues = [];
    let banner = null;
    let lastPayloadInputs = [];
    let open = new Set();
    const trial = { project:null, values:{}, result:null, error:'', loading:false, serial:0, query:'', results:[], searching:false };
    let trialTimer = 0;
    let searchTimer = 0;
    let destroyed = false;

    host.innerHTML = '<div class="pp ps-ed" data-ps-editor data-settings-autosave="off"></div>';
    const root = host.firstElementChild;
    const kind = () => (draft.schema_ids[0] ? vocab.kind(draft.schema_ids[0]) : null);
    const lineByKey = (key) => draft.entries.find((entry) => entry._key === key);
    const eqByKey = (key) => draft.equipment.find((item) => item._key === key);
    const inputNamed = (name) => model.inputNamed(draft, name);

    /* ---- Problems, by the field they are on ---- */
    function issueKey(issue, inputs = draft.inputs){
      const path = arr(issue.path);
      const [head, index, field] = path;
      if (head === 'name') return ['name'];
      if (head === 'schema_ids' || issue.code === 'pay_sheet_overlap') return ['kind'];
      if (head === 'inputs') { const name = inputs[index]?.name || ''; const readers = draft.entries.filter((entry) => entry.input === name || entry.when === name).map((entry) => `line:${entry._key}:${entry.when === name && entry.input !== name ? 'when' : 'per'}`); return [`input:${name}`, ...readers, ...(draft.duration?.input === name ? ['duration'] : [])]; }
      if (head === 'entries') { const entry = draft.entries[index]; const map = { input:'per', rate_cents:'rate', minimum_cents:'minimum', covers:'covers' }; return entry ? [`line:${entry._key}:${map[field] || field || 'label'}`] : ['general']; }
      if (head === 'equipment') { const item = draft.equipment[index]; return item ? [`eq:${item._key}`] : ['general']; }
      if (head === 'work') { const item = draft.work[index]?.item; return item ? [`work:${item}`] : ['work']; }
      if (head === 'duration') return ['duration'];
      return ['general'];
    }
    const errorsAt = (key) => issues.filter((issue) => issue.keys.includes(key)).map((issue) => issue.text);
    const linePrefix = (lineKey) => issues.filter((issue) => issue.keys.some((key) => key.startsWith(`line:${lineKey}:`)));
    const invalid = (key) => (errorsAt(key).length ? 'aria-invalid="true"' : '');
    const errHtml = (messages) => [...new Set(messages)].map((message) => `<p class="ps-err" role="alert">${esc(message)}</p>`).join('');
    function setIssues(list, inputs){
      issues = list.map((issue) => ({ ...issue, keys:issueKey(issue, inputs), text:issue.local ? issue.message : model.issueText(issue, draft, vocab) }));
    }

    /* ---- Header ---- */
    function statusPill(){
      if (!draft.id) return kit.pill({ label:t('ps_status_new', 'Not saved yet'), tone:'warn', icon:'fa-circle', tooltip:t('ps_status_new_tip', 'This sheet is used once it is saved') });
      if (dirty) return kit.pill({ label:t('ps_status_dirty', 'Unsaved changes'), tone:'warn', tooltip:t('ps_status_dirty_tip', 'Labor lists use the saved sheet until you save') });
      return kit.pill({ label:t('ps_status_saved', 'In use'), tone:'ok', icon:'fa-check', tooltip:t('ps_status_saved_tip', 'Labor lists for this assignee are generated from this sheet') });
    }
    function stripHtml(){
      const rows = model.coverage(draft, vocab);
      if (!rows.length) return '';
      const counts = rows.reduce((sum, row) => ({ ...sum, [row.state]:(sum[row.state] || 0) + 1 }), {});
      const tipFor = (row) => [model.STATES[row.state].label, row.paidBy.length ? t('ps_paid_by', 'Paid by {lines}', { lines:row.paidBy.join(', ') }) : '', row.providedBy.length ? t('ps_provided_by', 'Provided by {items}', { items:row.providedBy.join(', ') }) : '', row.state === 'open' ? model.STATES.open.tooltip : ''].filter(Boolean).join('. ');
      const lead = counts.open ? t('ps_strip_open', '{count} left open', { count:counts.open }) : t('ps_strip_all', 'Everything accounted for');
      return `<span class="ps-strip-label"${tip(t('ps_strip_tip', 'What {kind} work needs, and how this sheet accounts for each part', { kind:lowerFirst(kind()?.title || '') }))}>${esc(lead)}</span>${rows.map((row) => kit.chip({ label:row.label, tone:model.STATES[row.state].tone, icon:model.STATES[row.state].icon, tooltip:tipFor(row) })).join('')}`;
    }
    function headHtml(){
      const kinds = vocab.kinds.map((entry) => ({ value:entry.id, label:entry.title }));
      const assignee = draft.subject || {};
      return `${options.onBack ? `<button type="button" class="ps-back" data-ps-back><i class="fas fa-arrow-left" aria-hidden="true"></i>${esc(t('ps_all_sheets', 'Pay sheets'))}</button>` : ''}
      <header class="ps-head">
        <div class="ps-head-top">
          <i class="fas ${ICON} ps-head-icon" aria-hidden="true"></i>
          <input class="ps-name" data-ps-name value="${esc(draft.name)}" aria-label="${esc(t('ps_name', 'Pay sheet name'))}" placeholder="${esc(t('ps_name_placeholder', 'Name this pay sheet'))}" ${dis} ${invalid('name')} spellcheck="false" autocomplete="off">
          <span data-ps-status>${statusPill()}</span>
          <div class="ps-head-actions">
            ${options.canTry ? `<button type="button" class="pp-btn" data-ps-jump-try${tip(t('ps_try_tip', 'Price this sheet against a real project before saving'))}><i class="fas fa-flask" aria-hidden="true"></i><span>${esc(t('ps_try_short', 'Try it'))}</span></button>` : ''}
            <button type="button" class="pp-btn quiet" data-ps-advanced aria-pressed="${advanced}"${tip(t('ps_advanced_tip', 'Everything the sheet reads, how each line counts toward the work, and salary lines'))}><i class="fas ${advanced ? 'fa-toggle-on' : 'fa-toggle-off'}" aria-hidden="true"></i><span>${esc(t('ps_advanced', 'Advanced'))}</span></button>
            <button type="button" class="pp-icon-btn" data-ps-more aria-haspopup="menu" aria-expanded="false" aria-label="${esc(t('ps_more', 'More'))}"${tip(t('ps_more', 'More'))}><i class="fas fa-ellipsis" aria-hidden="true"></i></button>
          </div>
        </div>
        ${errHtml(errorsAt('name'))}
        <div class="ps-head-meta">
          <label class="ps-meta"><span${tip(t('ps_kind_tip', 'The kind of work this sheet prices. It decides which measurements and work the sheet can name.'))}>${esc(t('ps_kind', 'Kind of work'))}</span>${select({ attrs:'data-ps-kind', label:t('ps_kind', 'Kind of work'), value:draft.schema_ids[0] || '__none', groups:[{ options:[...kinds, { value:'__none', label:t('ps_kind_none', 'None (hourly or salaried)') }] }], disabled:readOnly, invalid:errorsAt('kind').length > 0 })}</label>
          <span class="ps-meta"><span>${esc(t('assignee', 'Assignee'))}</span><b><i class="fas ${KIND_ICONS[assignee.type] || kit.ICONS.user}" aria-hidden="true"></i>${esc(options.assigneeName || '')}</b></span>
        </div>
        ${errHtml(errorsAt('kind'))}
        <p class="ps-summary" data-ps-summary aria-live="polite"><i class="fas fa-quote-left" aria-hidden="true"></i><span>${esc(model.summary(draft, vocab))}</span></p>
        <div class="ps-strip" data-ps-strip>${stripHtml()}</div>
        ${banner ? `<div class="ps-banner ${banner.tone === 'notice' ? 'notice' : ''}" role="alert" data-ps-banner><i class="fas fa-triangle-exclamation" aria-hidden="true"></i><span>${esc(banner.text)}</span>${banner.reload ? `<button type="button" class="pp-btn" data-ps-reload>${esc(t('ps_reload', 'Load their version'))}</button>` : ''}</div>` : ''}
        ${errorsAt('general').length ? `<div class="ps-banner" role="alert"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i><span>${esc(errorsAt('general').join(' '))}</span></div>` : ''}
      </header>`;
    }

    /* ---- Pay lines ---- */
    function perGroups(entry){
      const groups = [];
      if (entry.kind === 'hourly' || entry.kind === 'cost_rate') {
        const hours = draft.inputs.filter((input) => input.source?.kind === 'work_hours' || input.source?.kind === 'manual');
        groups.push({ label:t('ps_per_on_sheet', 'On this sheet'), options:hours.map((input) => ({ value:`i:${input.name}`, label:input.source.kind === 'work_hours' ? t('ps_per_hours_estimate_named', '{label} (estimated from the work)', { label:input.label || input.name }) : t('ps_per_typed_named', '{label} (typed for each job)', { label:input.label || input.name }) })) });
        groups.push({ label:t('ps_per_new', 'New'), options:[...(hours.some((input) => input.source.kind === 'work_hours') ? [] : [{ value:'hours:estimate', label:t('ps_per_hours_estimate', 'Hours estimated from the work') }]), { value:'hours:typed', label:t('ps_per_hours_typed', 'Hours typed for each job') }] });
        return groups;
      }
      const offered = model.offeredMeasurements(vocab, draft.schema_ids);
      groups.push({ label:kind() ? t('ps_per_measurements', '{kind} measurements', { kind:kind().title }) : t('ps_per_measurements_plain', 'Measurements'), options:offered.map((entry) => ({ value:`m:${entry.definition}`, label:entry.label })) });
      const current = inputNamed(entry.input);
      // A measurement this kind of work no longer selects is still shown, so the problem can be seen and fixed.
      if (current?.source?.kind === 'measurement' && !offered.some((entry) => entry.definition === current.source.definition)) groups[0].options.unshift({ value:`m:${current.source.definition}`, label:vocab.definition(current.source.definition)?.label || current.source.definition });
      groups.push({ label:t('ps_per_on_sheet', 'On this sheet'), options:draft.inputs.filter((input) => input.source?.kind !== 'measurement').map((input) => ({ value:`i:${input.name}`, label:input.source.kind === 'material' ? t('ps_per_material_named', '{label} (on the lists)', { label:input.label || input.name }) : input.source.kind === 'field' ? t('ps_per_field_named', '{label} (project field)', { label:input.label || input.name }) : input.source.kind === 'work_hours' ? t('ps_per_hours_estimate_named', '{label} (estimated from the work)', { label:input.label || input.name }) : t('ps_per_typed_named', '{label} (typed for each job)', { label:input.label || input.name }) })) });
      groups.push({ label:t('ps_per_new', 'New'), options:[{ value:'new:material', label:t('ps_per_new_material', 'Material on the lists…') }, { value:'new:field', label:t('ps_per_new_field', 'A project field…') }, { value:'new:manual', label:t('ps_per_new_manual', 'A number typed for each job…') }] });
      return groups;
    }
    function perValue(entry){
      const input = inputNamed(entry.input);
      if (!input) return '';
      return input.source?.kind === 'measurement' ? `m:${input.source.definition}` : `i:${input.name}`;
    }
    function lineFacts(entry){
      const facts = [];
      const items = model.offeredItems(vocab, draft.schema_ids);
      const roles = model.coverRoles(draft, vocab).get(entry) || new Map();
      // A line that only changes the price of work another line pays for says so first, with why in its tooltip.
      const reason = model.adjustReason(entry, draft, vocab);
      const onlyAdjusts = !!reason && arr(entry.covers).every((item) => roles.get(item) === 'adjusts');
      if (reason) facts.push(kit.pill({ label:onlyAdjusts ? t('ps_adjusts_of', 'Adjusts the price of') : t('ps_adjusts', 'Adjusts the price'), tone:'role', icon:'fa-sliders', tooltip:reason }));
      if (arr(entry.covers).length) {
        if (!onlyAdjusts) facts.push(`<span class="ps-fact-label">${esc(t('ps_pays_for', 'Pays for'))}</span>`);
        entry.covers.forEach((item) => { const found = items.find((row) => row.item === item); facts.push(kit.chip({ label:found?.label || item, tone:roles.get(item) === 'adjusts' ? 'muted' : 'group', tooltip:found?.description || '' })); });
      } else if (entry.kind !== 'salary' && entry.kind !== 'cost_rate') facts.push(kit.chip({ label:t('ps_covers_nothing', 'Charged on every job'), tone:'muted', tooltip:t('ps_covers_nothing_tip', 'This line is not tied to a piece of work, so it is charged whenever it applies, even when someone else does part of the job') }));
      if (entry.kind === 'cost_rate') facts.push(kit.pill({ label:t('ps_projection', 'Projection only'), tone:'role', tooltip:t('pay_kind_cost_rate_tip', 'Hours at what this time costs the business. It shows what the job costs; nobody is paid from it, because their pay is their salary.') }));
      if (entry.kind === 'salary') facts.push(kit.pill({ label:t('ps_not_charged', 'Not charged to jobs'), tone:'neutral', tooltip:t('pay_kind_salary_tip', 'Recorded on the sheet and paid through payroll. It is never charged to a job.') }));
      if (entry.when) facts.push(kit.chip({ label:t('ps_only_when', 'Only when {what}', { what:lowerFirst(inputNamed(entry.when)?.label || entry.when) }), tone:'warn', icon:'fa-filter', tooltip:t('ps_only_when_tip', 'Charged only on jobs where this is above zero') }));
      if (entry.minimum_cents) facts.push(kit.chip({ label:t('ps_at_least', 'At least {amount}', { amount:money(entry.minimum_cents) }), icon:'fa-arrow-up-wide-short', tooltip:t('ps_minimum_tip', 'When the line comes to less, the difference is added as its own line') }));
      if (entry.multiplier !== undefined && entry.multiplier !== null && entry.multiplier !== '' && Number(entry.multiplier) !== 1) facts.push(kit.chip({ label:`× ${amount(entry.multiplier)}`, tooltip:t('ps_multiplier_tip', 'What it is paid per is multiplied by this first') }));
      const input = inputNamed(entry.input);
      if (input?.source?.kind === 'manual' || input?.source?.kind === 'work_hours') facts.push(kit.chip({ label:input.source.kind === 'work_hours' ? t('ps_estimated_hours', 'Hours estimated, can be typed over') : t('ps_typed_on_list', 'Typed on the work order'), icon:'fa-keyboard', tone:'muted', tooltip:input.source.kind === 'work_hours' ? t('ps_estimated_hours_tip', 'Worked out from the hours each piece of work takes. A number typed on the work order replaces it.') : t('ps_typed_on_list_tip', 'The work order has this line at its rate; whoever runs the job types the number.') }));
      return facts.join('');
    }
    function lineHtml(entry, index){
      const key = entry._key;
      const unit = model.perUnit(entry, draft, vocab);
      const showPer = entry.kind === 'piece_rate' || entry.kind === 'hourly' || entry.kind === 'cost_rate';
      const expanded = open.has(key);
      const items = model.offeredItems(vocab, draft.schema_ids);
      const whenOptions = draft.inputs.map((input) => ({ value:input.name, label:input.label || input.name }));
      const lineErrors = linePrefix(key).map((issue) => issue.text);
      return `<div class="ps-line${lineErrors.length ? ' invalid' : ''}" data-ps-line="${esc(key)}" data-ps-index="${index}">
        <div class="ps-line-main">
          <input class="pp-input ps-line-label" data-ps-line-field="label" value="${esc(entry.label)}" placeholder="${esc(t('ps_line_label', 'What it is for'))}" aria-label="${esc(t('ps_line_label', 'What it is for'))}" ${dis} ${invalid(`line:${key}:label`)}>
          ${select({ className:'ps-line-kind', attrs:'data-ps-line-field="kind"', label:t('ps_line_kind', 'How it is paid'), value:entry.kind, groups:[{ options:model.PAY_KINDS.filter((option) => option.id !== 'salary' || advanced || entry.kind === 'salary').map((option) => ({ value:option.id, label:option.label })) }], disabled:readOnly })}
          ${showPer ? `<span class="ps-line-per"><em>${esc(t('ps_per', 'per'))}</em>${select({ attrs:'data-ps-line-field="per"', label:t('ps_per_label', 'Paid per'), value:perValue(entry), placeholder:t('ps_per_choose', 'Choose…'), groups:perGroups(entry), disabled:readOnly, invalid:errorsAt(`line:${key}:per`).length > 0 })}</span>` : '<span class="ps-line-per"></span>'}
          <span class="ps-line-price"><label class="ps-money"><span aria-hidden="true">$</span><input class="pp-input" data-ps-line-field="rate" inputmode="decimal" value="${esc(dollars(entry.rate_cents))}" placeholder="0.00" aria-label="${esc(t('ps_rate', 'Rate'))}" ${dis} ${invalid(`line:${key}:rate`)}></label><span class="ps-unit" data-ps-unit>${unit ? `/${esc(unit)}` : ''}</span></span>
          <span class="ps-line-tools">
            <button type="button" class="pp-icon-btn" data-ps-line-toggle aria-expanded="${expanded}" aria-label="${esc(t('ps_line_more', 'More about this line'))}"${tip(t('ps_line_more', 'More about this line'))}><i class="fas fa-sliders" aria-hidden="true"></i></button>
            ${readOnly ? '' : `<button type="button" class="pp-icon-btn danger" data-ps-line-remove aria-label="${esc(t('ps_line_remove', 'Remove this line'))}"${tip(t('ps_line_remove', 'Remove this line'))}><i class="fas fa-trash" aria-hidden="true"></i></button>`}
          </span>
        </div>
        <div class="ps-line-facts" data-ps-facts>${lineFacts(entry)}</div>
        ${errHtml(lineErrors)}
        <div class="ps-line-more" ${expanded ? '' : 'hidden'}>
          ${items.length ? `<div class="ps-field"><span${tip(t('ps_covers_tip', 'The work this line is the pay for. A line that reads part of what the work is measured in only adjusts its price.'))}>${esc(t('ps_pays_for', 'Pays for'))}</span><div class="ps-covers" role="group" aria-label="${esc(t('ps_pays_for', 'Pays for'))}">${items.map((item) => `<button type="button" class="pp-choice" data-ps-cover="${esc(item.item)}" aria-pressed="${arr(entry.covers).includes(item.item)}" ${dis}${tip(item.description)}>${esc(item.label)}</button>`).join('')}</div></div>` : ''}
          <div class="ps-grid">
            <label class="ps-field"><span${tip(t('ps_minimum_tip', 'When the line comes to less, the difference is added as its own line'))}>${esc(t('ps_minimum', 'Minimum'))}</span><span class="ps-money"><span aria-hidden="true">$</span><input class="pp-input" data-ps-line-field="minimum" inputmode="decimal" value="${esc(dollars(entry.minimum_cents))}" placeholder="${esc(t('ps_none', 'None'))}" ${dis} ${invalid(`line:${key}:minimum`)}></span></label>
            <label class="ps-field"><span${tip(t('ps_only_when_tip', 'Charged only on jobs where this is above zero'))}>${esc(t('ps_only_when_label', 'Only when'))}</span>${select({ attrs:'data-ps-line-field="when"', label:t('ps_only_when_label', 'Only when'), value:entry.when || '', placeholder:t('ps_always', 'Always'), groups:[{ options:whenOptions }], disabled:readOnly, invalid:errorsAt(`line:${key}:when`).length > 0 })}</label>
            ${showPer ? `<label class="ps-field"><span${tip(t('ps_multiplier_tip', 'What it is paid per is multiplied by this first'))}>${esc(t('ps_multiplier', 'Multiplier'))}</span><input class="pp-input ps-num" data-ps-line-field="multiplier" inputmode="decimal" value="${esc(entry.multiplier ?? '')}" placeholder="1" ${dis} ${invalid(`line:${key}:multiplier`)}></label>
            <label class="ps-field"><span${tip(t('ps_unit_tip', 'The word on the work order after the rate, such as sq, bundle or layer'))}>${esc(t('ps_unit_word', 'Counted in'))}</span><input class="pp-input" data-ps-line-field="unit" value="${esc(entry.unit || '')}" placeholder="${esc(unit || t('ps_unit_placeholder', 'sq, bundle…'))}" ${dis}></label>` : ''}
            ${advanced ? `<label class="ps-field"><span${tip(t('ps_role_tip', 'Normally worked out from what the line reads. Override only when the sheet is unusual.'))}>${esc(t('ps_role', 'Counts as'))}</span>${select({ attrs:'data-ps-line-field="role"', label:t('ps_role', 'Counts as'), value:entry.role || '', placeholder:t('ps_role_auto', 'Worked out'), groups:[{ options:[{ value:'counts', label:t('ps_role_counts', 'The pay for the work') }, { value:'adjusts', label:t('ps_role_adjusts', 'Only adjusts the price') }] }], disabled:readOnly })}</label>` : ''}
          </div>
        </div>
      </div>`;
    }
    function payHtml(){
      return `<section class="ps-sec" data-ps-section="pay">
        <div class="ps-sec-head"><i class="fas fa-coins" aria-hidden="true"></i><h3${tip(t('ps_pay_tip', 'How this assignee is paid for a job. Each line reads one thing about the job and pays a rate for it.'))}>${esc(t('ps_pay', 'Pay'))}</h3><span class="ps-count">${esc(kit.countPhrase([[draft.entries.length, t('ps_line_one', 'line'), t('ps_line_many', 'lines')]]))}</span><span class="ps-spacer"></span>${readOnly ? '' : `<button type="button" class="pp-btn" data-ps-add-line><i class="fas fa-plus" aria-hidden="true"></i>${esc(t('ps_add_line', 'Add pay line'))}</button>`}</div>
        ${draft.entries.length ? draft.entries.map(lineHtml).join('') : `<div class="ps-empty">${esc(t('ps_no_lines', 'No pay lines yet. Add what they charge, such as tear off and install per square.'))}</div>`}
      </section>`;
    }

    /* ---- Work ---- */
    function workHtml(){
      const rows = model.coverage(draft, vocab);
      if (!rows.length) return '';
      const errors = errorsAt('work');
      return `<section class="ps-sec" data-ps-section="work">
        <div class="ps-sec-head"><i class="fas fa-list-check" aria-hidden="true"></i><h3${tip(t('ps_work_tip', 'Everything {kind} work can need. Mark what they do at no extra charge, and roughly how long each takes, so estimates follow the size of the job.', { kind:lowerFirst(kind()?.title || '') }))}>${esc(t('ps_work', 'The work'))}</h3><span class="ps-spacer"></span></div>
        ${errHtml(errors)}
        <div class="ps-table" role="table" aria-label="${esc(t('ps_work', 'The work'))}">
          <div class="ps-tr head" role="row"><span role="columnheader">${esc(t('ps_work_col', 'Work'))}</span><span role="columnheader">${esc(t('ps_on_sheet', 'On this sheet'))}</span><span role="columnheader"${tip(t('ps_free_tip', 'Done as part of the job at no separate charge'))}>${esc(t('ps_free', 'No charge'))}</span><span role="columnheader" style="text-align:right"${tip(t('ps_hours_tip', 'Roughly how many hours one unit takes. Used to estimate hours and days.'))}>${esc(t('ps_hours_per', 'Hours each'))}</span></div>
          ${rows.map((row) => {
            const entry = draft.work.find((candidate) => candidate.item === row.item) || {};
            const state = model.STATES[row.state];
            const paid = row.state === 'paid';
            const stateTip = [state.tooltip, row.paidBy.length ? t('ps_paid_by', 'Paid by {lines}', { lines:row.paidBy.join(', ') }) : '', row.providedBy.length ? t('ps_provided_by', 'Provided by {items}', { items:row.providedBy.join(', ') }) : ''].filter(Boolean).join(' ');
            const stateLabel = row.state === 'provided' && row.providedBy.length ? t('ps_provided_by_short', 'By {item}', { item:row.providedBy[0] }) : state.label;
            return `<div class="ps-tr${row.under ? ' under' : ''}" role="row" data-ps-work="${esc(row.item)}">
              <span class="ps-td-name" role="cell"${tip(row.description)}>${row.under ? '<i class="fas fa-arrow-turn-up fa-rotate-90" aria-hidden="true"></i>' : ''}<strong>${esc(row.label)}</strong><small>${esc(row.kind === 'function' ? t('ps_function_unit', 'A capacity, in {unit}', { unit:unitWord(row.unit, 2) }) : t('ps_unit_measured', 'Measured in {unit}', { unit:unitWord(row.unit, 2) }))}${row.optional ? ` · ${esc(t('ps_only_if_present', 'only when the job has some'))}` : ''}</small></span>
              <span class="ps-td-state" role="cell">${kit.chip({ label:stateLabel, tone:state.tone, icon:state.icon, tooltip:stateTip })}</span>
              <span class="ps-td-free" role="cell"><label class="ps-check${paid || readOnly ? ' disabled' : ''}"${tip(paid ? t('ps_free_paid_tip', 'A pay line already pays for this') : t('ps_free_tip', 'Done as part of the job at no separate charge'))}><input type="checkbox" data-ps-work-field="included" ${entry.included && !paid ? 'checked' : ''} ${paid || readOnly ? 'disabled' : ''}><span>${esc(t('ps_free_short', 'Included'))}</span></label></span>
              <span class="ps-td-hours" role="cell">${row.kind === 'function' ? '' : `<input class="pp-input ps-num" data-ps-work-field="hours" inputmode="decimal" value="${esc(entry.hours_per_unit ?? '')}" placeholder="—" aria-label="${esc(t('ps_hours_for', 'Hours for each {unit} of {work}', { unit:unitWord(row.unit, 1), work:lowerFirst(row.label) }))}" ${dis} ${invalid(`work:${row.item}`)}><small>/${esc(unitWord(row.unit, 1, true))}</small>`}</span>
            </div>${errHtml(errorsAt(`work:${row.item}`))}`;
          }).join('')}
        </div>
      </section>`;
    }

    /* ---- Equipment ---- */
    function equipmentHtml(){
      const functions = model.offeredItems(vocab, draft.schema_ids).filter((item) => item.kind === 'function');
      return `<section class="ps-sec" data-ps-section="equipment">
        <div class="ps-sec-head"><i class="fas fa-truck-pickup" aria-hidden="true"></i><h3${tip(t('ps_equipment_tip', 'What they bring to the job, whether it is included in their price, and what it takes care of'))}>${esc(t('ps_equipment', 'Equipment they bring'))}</h3><span class="ps-spacer"></span>${readOnly ? '' : `<button type="button" class="pp-btn" data-ps-add-eq><i class="fas fa-plus" aria-hidden="true"></i>${esc(t('ps_add_eq', 'Add equipment'))}</button>`}</div>
        ${draft.equipment.length ? draft.equipment.map((item) => `<div class="ps-eq" data-ps-eq="${esc(item._key)}">
          <div class="ps-eq-main">
            <input class="pp-input ps-eq-name" data-ps-eq-field="name" value="${esc(item.name || '')}" placeholder="${esc(t('ps_eq_name', 'Dump truck, dumpster, lift…'))}" aria-label="${esc(t('ps_eq_name_label', 'Equipment'))}" ${dis} ${errorsAt(`eq:${item._key}`).length && !text(item.name) ? 'aria-invalid="true"' : ''}>
            <span class="pp-seg" role="group" aria-label="${esc(t('ps_eq_charge', 'Charge'))}"><button type="button" data-ps-eq-included="yes" aria-pressed="${item.included !== false}" ${dis}>${esc(t('ps_eq_included', 'Included'))}</button><button type="button" data-ps-eq-included="no" aria-pressed="${item.included === false}" ${dis}>${esc(t('ps_eq_charged', 'Charged'))}</button></span>
            ${item.included === false ? `<label class="ps-money"><span aria-hidden="true">$</span><input class="pp-input" data-ps-eq-field="rate" inputmode="decimal" value="${esc(dollars(item.rate_cents))}" placeholder="0.00" aria-label="${esc(t('ps_eq_rate', 'Charged per job'))}" ${dis}></label><span class="ps-unit">/${esc(t('job', 'job'))}</span>` : ''}
            ${readOnly ? '' : `<button type="button" class="pp-icon-btn danger" data-ps-eq-remove aria-label="${esc(t('ps_eq_remove', 'Remove equipment'))}"${tip(t('ps_eq_remove', 'Remove equipment'))}><i class="fas fa-trash" aria-hidden="true"></i></button>`}
          </div>
          ${arr(item.provides).map((provided, index) => { const fn = functions.find((entry) => entry.item === provided.item) || vocab.item(provided.item); return `<div class="ps-provide" data-ps-provide="${index}"><span>${esc(t('ps_takes_care_of', 'Takes care of'))}</span>${select({ attrs:'data-ps-provide-field="item"', label:t('ps_takes_care_of', 'Takes care of'), value:provided.item || '', placeholder:t('ps_per_choose', 'Choose…'), groups:[{ options:functions.map((entry) => ({ value:entry.item, label:entry.label })) }], disabled:readOnly })}<span>${esc(t('ps_holds', 'holds'))}</span><input class="pp-input ps-num" data-ps-provide-field="capacity" inputmode="decimal" value="${esc(provided.capacity ?? '')}" placeholder="—" aria-label="${esc(t('ps_capacity', 'How much it holds'))}" ${dis}><span>${esc(fn ? unitWord(fn.unit, 2, true) : '')}</span><label class="ps-check"${tip(t('ps_per_load_tip', 'It can be emptied and used again, so how much it holds never limits the job'))}><input type="checkbox" data-ps-provide-field="per_load" ${provided.per_load ? 'checked' : ''} ${dis}><span>${esc(t('ps_per_load', 'per load'))}</span></label>${readOnly ? '' : `<button type="button" class="pp-icon-btn" data-ps-provide-remove aria-label="${esc(t('ps_provide_remove', 'Remove'))}"><i class="fas fa-xmark" aria-hidden="true"></i></button>`}</div>`; }).join('')}
          ${!readOnly && functions.length && arr(item.provides).length < functions.length ? `<button type="button" class="ps-link" data-ps-provide-add><i class="fas fa-plus" aria-hidden="true"></i>${esc(t('ps_provide_add', 'What it takes care of'))}</button>` : ''}
          ${errHtml(errorsAt(`eq:${item._key}`))}
        </div>`).join('') : `<div class="ps-empty">${esc(t('ps_no_eq', 'Nothing. Add a truck, trailer or dumpster they bring so the debris is accounted for.'))}</div>`}
      </section>`;
    }

    /* ---- How long ---- */
    function durationHtml(){
      const mode = !draft.duration ? 'none' : 'hours_per_day' in draft.duration ? 'hours' : 'amount';
      const measures = model.offeredMeasurements(vocab, draft.schema_ids).filter((entry) => !entry.part_of);
      const current = draft.duration?.input ? inputNamed(draft.duration.input) : null;
      const value = current ? (current.source?.kind === 'measurement' ? `m:${current.source.definition}` : `i:${current.name}`) : '';
      const days = model.typicalDays(draft, vocab);
      const others = draft.inputs.filter((input) => input.source?.kind !== 'measurement').map((input) => ({ value:`i:${input.name}`, label:input.label || input.name }));
      return `<section class="ps-sec" data-ps-section="duration">
        <div class="ps-sec-head"><i class="fas fa-calendar-day" aria-hidden="true"></i><h3${tip(t('ps_duration_tip', 'How much they get through in a day, so jobs can be scheduled for the right number of days'))}>${esc(t('ps_duration', 'How long it takes'))}</h3><span class="ps-spacer"></span>
          <span class="pp-seg" role="group" aria-label="${esc(t('ps_duration', 'How long it takes'))}">${[['amount', t('ps_duration_amount', 'By amount')], ['hours', t('ps_duration_hours', 'By hours')], ['none', t('ps_duration_none', 'Not set')]].map(([id, label]) => `<button type="button" data-ps-duration-mode="${id}" aria-pressed="${mode === id}" ${dis}>${esc(label)}</button>`).join('')}</span>
        </div>
        ${mode === 'amount' ? `<div class="ps-sentence"><span>${esc(t('ps_gets_through', 'Gets through'))}</span><input class="pp-input ps-num" data-ps-duration-field="units_per_day" inputmode="decimal" value="${esc(draft.duration.units_per_day ?? '')}" aria-label="${esc(t('ps_per_day', 'How much a day'))}" ${dis} ${invalid('duration')}>${select({ attrs:'data-ps-duration-field="input"', label:t('ps_counted', 'Counted in'), value, placeholder:t('ps_per_choose', 'Choose…'), groups:[{ options:measures.map((entry) => ({ value:`m:${entry.definition}`, label:lowerFirst(entry.label) })) }, { label:t('ps_per_on_sheet', 'On this sheet'), options:others }], disabled:readOnly, invalid:errorsAt('duration').length > 0 })}<span>${esc(t('ps_a_day', 'a day'))}</span></div>` : ''}
        ${mode === 'hours' ? `<div class="ps-sentence"><span>${esc(t('ps_works', 'Works'))}</span><input class="pp-input ps-num" data-ps-duration-field="hours_per_day" inputmode="decimal" value="${esc(draft.duration.hours_per_day ?? '')}" aria-label="${esc(t('ps_hours_a_day', 'Hours a day'))}" ${dis} ${invalid('duration')}><span>${esc(t('ps_hours_day_tail', 'hours a day, using the hours each piece of work takes'))}</span></div>` : ''}
        ${mode === 'none' ? `<p class="ps-note">${esc(t('ps_duration_unset', 'Jobs for this assignee are not given a length when they are scheduled.'))}</p>` : ''}
        ${days ? `<span class="ps-preview" data-ps-days><i class="fas fa-clock" aria-hidden="true"></i><span>${esc(t('ps_about', 'About'))} <b>${esc(model.dayWords(days.days))}</b> ${esc(t('ps_for', 'for'))} ${esc(days.unit === 'roofing_square' ? t('sample_roof', 'a {size}-square roof', { size:days.size }) : `${amount(days.size)} ${unitWord(days.unit, days.size)}`)}</span></span>` : ''}
        ${errHtml(errorsAt('duration'))}
      </section>`;
    }

    /* ---- Inputs (Advanced) ---- */
    function inputsHtml(){
      if (!advanced) return '';
      const used = model.referenced(draft);
      const measures = model.offeredMeasurements(vocab, draft.schema_ids);
      return `<section class="ps-sec ps-inputs" data-ps-section="inputs">
        <div class="ps-sec-head"><i class="fas fa-table-list" aria-hidden="true"></i><h3${tip(t('ps_inputs_tip', 'Everything this sheet reads about a job. Lines make these when they pick what they are paid per; change them here when you need to.'))}>${esc(t('ps_inputs', 'What the sheet reads'))}</h3><span class="ps-count">${esc(String(draft.inputs.length))}</span><span class="ps-spacer"></span>${readOnly ? '' : `<button type="button" class="pp-btn" data-ps-add-input aria-haspopup="menu"><i class="fas fa-plus" aria-hidden="true"></i>${esc(t('ps_add_input', 'Add'))}</button>`}</div>
        ${draft.inputs.length ? `<div class="ps-table" role="table"><div class="ps-tr head" role="row"><span>${esc(t('ps_in_name', 'Called'))}</span><span>${esc(t('ps_in_reads', 'Reads'))}</span><span${tip(t('ps_in_required_tip', 'Without it, the lines that read it are left unpriced rather than priced at zero'))}>${esc(t('ps_in_required', 'Needed'))}</span><span${tip(t('ps_in_default_tip', 'Used when the job has nothing for an input that is not needed'))}>${esc(t('ps_in_default', 'Otherwise'))}</span><span${tip(t('ps_in_structure_tip', 'Price each building separately when every building has its own value'))}>${esc(t('ps_in_structure', 'Per building'))}</span><span></span></div>
          ${draft.inputs.map((input) => {
            const source = input.source || {};
            const definition = source.kind === 'measurement' ? vocab.definition(source.definition) : null;
            const reads = source.kind === 'measurement' ? select({ attrs:'data-ps-input-field="definition"', label:t('ps_in_reads', 'Reads'), value:source.definition, groups:[{ options:[...measures.map((entry) => ({ value:entry.definition, label:entry.label })), ...(measures.some((entry) => entry.definition === source.definition) ? [] : [{ value:source.definition, label:vocab.definition(source.definition)?.label || source.definition }])] }], disabled:readOnly, invalid:errorsAt(`input:${input.name}`).length > 0 })
              : source.kind === 'material' ? `<input class="pp-input" data-ps-input-field="item_type" value="${esc(source.item_type || '')}" placeholder="${esc(t('ps_item_type', 'Item type, such as Shingles'))}" aria-label="${esc(t('ps_item_type_label', 'Item type on the lists'))}" ${dis} ${invalid(`input:${input.name}`)}>`
              : source.kind === 'field' ? `<input class="pp-input" data-ps-input-field="key" value="${esc(source.key || '')}" placeholder="${esc(t('ps_field_key', 'Project field'))}" aria-label="${esc(t('ps_field_key', 'Project field'))}" ${dis} ${invalid(`input:${input.name}`)}>`
              : `<span class="ps-src"><i class="fas ${source.kind === 'work_hours' ? 'fa-clock' : 'fa-keyboard'}" aria-hidden="true"></i>${esc(model.sourceWords(source, vocab, input))}</span>`;
            return `<div class="ps-tr" role="row" data-ps-input="${esc(input.name)}">
              <input class="pp-input" data-ps-input-field="label" value="${esc(input.label || '')}" placeholder="${esc(input.name)}" aria-label="${esc(t('ps_in_name', 'Called'))}" ${dis}>
              ${reads}
              <label class="ps-check"><input type="checkbox" data-ps-input-field="required" ${input.required !== false ? 'checked' : ''} ${dis}><span>${esc(t('ps_in_required', 'Needed'))}</span></label>
              <input class="pp-input ps-num" data-ps-input-field="default" inputmode="decimal" value="${esc(input.default ?? '')}" placeholder="—" aria-label="${esc(t('ps_in_default', 'Otherwise'))}" ${input.required !== false || readOnly ? 'disabled' : ''}>
              ${definition?.per_structure ? `<label class="ps-check"><input type="checkbox" data-ps-input-field="per_structure" ${source.per_structure ? 'checked' : ''} ${dis}><span>${esc(t('ps_in_structure_short', 'Each'))}</span></label>` : '<span></span>'}
              ${readOnly || used.has(input.name) ? `<span class="ps-in-remove"${used.has(input.name) ? tip(t('ps_in_used', 'A line or the duration reads this')) : ''}></span>` : `<button type="button" class="pp-icon-btn danger ps-in-remove" data-ps-input-remove aria-label="${esc(t('ps_in_remove', 'Remove'))}"${tip(t('ps_in_remove', 'Remove'))}><i class="fas fa-trash" aria-hidden="true"></i></button>`}
            </div>${errHtml(errorsAt(`input:${input.name}`))}`;
          }).join('')}</div>` : `<div class="ps-empty">${esc(t('ps_no_inputs', 'Nothing yet. Lines add what they read.'))}</div>`}
      </section>`;
    }

    /* ---- Try it on a project ---- */
    function trialBody(){
      const body = { sheet:model.payload(draft), manual:{}, fields:{}, legacy_measurements:{} };
      for (const [name, value] of Object.entries(trial.values)) {
        const input = inputNamed(name);
        if (!input || !Number.isFinite(Number(value))) continue;
        const source = input.source || {};
        if (source.kind === 'measurement') { const definition = vocab.definition(source.definition); if (definition?.key) body.legacy_measurements[definition.key] = { value:Number(value), unit:definition.unit }; }
        else if (source.kind === 'field') body.fields[source.key] = Number(value);
        else if (source.kind === 'manual' || source.kind === 'work_hours') body.manual[name] = Number(value);
      }
      return body;
    }
    async function runTrial(){
      if (!trial.project || destroyed) return;
      const serial = trial.serial += 1;
      trial.loading = true; trial.error = '';
      paintTrial();
      try {
        const result = await model.api.tryOn(orgId, trial.project.id, trialBody());
        if (serial !== trial.serial || destroyed) return;
        trial.result = result;
      } catch (error) {
        if (serial !== trial.serial || destroyed) return;
        const list = arr(error?.data?.issues);
        trial.result = null;
        trial.error = list.length ? t('ps_try_fix', 'Fix the sheet first: {problem}', { problem:model.issueText(list[0], draft, vocab) }) : (error?.message || t('ps_try_failed', 'This project could not be priced.'));
      }
      trial.loading = false;
      paintTrial();
    }
    const scheduleTrial = () => { if (!trial.project) return; window.clearTimeout(trialTimer); trialTimer = window.setTimeout(runTrial, 450); };
    function trialResultHtml(){
      const result = trial.result;
      if (!result) return '';
      const evaluation = result.evaluation || {};
      const unit = (line) => (line.unit ? ` ${unitWord(line.unit, line.quantity, true)}` : '');
      const lines = arr(evaluation.lines).map((line) => `<div class="${line.kind === 'salary' || line.kind === 'cost_rate' ? 'muted' : ''}"><span>${esc(line.label)}${line.structure_name ? ` · ${esc(line.structure_name)}` : ''}${line.estimated ? ` <i class="fas fa-wand-magic-sparkles" aria-label="${esc(t('ps_estimated', 'Estimated'))}"${tip(t('ps_estimated_tip', 'Hours estimated from the work; a number typed on the work order replaces it'))}></i>` : ''}</span><em>${line.quantity !== null && line.kind !== 'minimum' ? `${esc(amount(line.quantity))}${esc(unit(line))} × ${esc(money(line.rate_cents, { cents:true }))}` : line.kind === 'minimum' ? esc(t('ps_minimum_line', 'Up to the minimum')) : ''}</em><b>${line.total_cents === null ? esc(t('ps_not_charged_short', 'Not charged')) : esc(money(line.total_cents, { cents:true }))}</b></div>`).join('');
      const unresolved = arr(evaluation.unresolved).map((row) => `<div class="unresolved"><span><i class="fas fa-triangle-exclamation" aria-hidden="true"></i> ${esc(row.label)}</span><em>${esc(row.reason)}</em><b>${esc(t('ps_not_priced', 'Not priced'))}</b></div>`).join('');
      const equipment = arr(evaluation.equipment).map((row) => `<div class="${row.included ? 'muted' : ''}"><span>${esc(row.name)}</span><em>${esc(row.included ? t('ps_eq_included', 'Included') : t('ps_eq_charged', 'Charged'))}</em><b>${esc(money(row.total_cents, { cents:true }))}</b></div>`).join('');
      const complete = evaluation.complete === true;
      const totalTile = `<div class="ps-tile${complete ? '' : ' warn'}"${tip(complete ? '' : t('ps_total_incomplete_tip', 'Some lines could not be priced yet, so this is not the whole price'))}><span>${esc(complete ? t('ps_total', 'Total') : t('ps_total_so_far', 'Priced so far'))}</span><b>${esc(money(evaluation.total_cents || 0, { cents:true }))}</b><small>${esc(complete ? t('ps_complete', 'Every line priced') : kit.countPhrase([[arr(evaluation.unresolved).length, t('ps_unpriced_one', 'line not priced'), t('ps_unpriced_many', 'lines not priced')]]))}</small></div>`;
      const projection = evaluation.projection_only_cents ? `<div class="ps-tile"${tip(t('pay_kind_cost_rate_tip', 'Hours at what this time costs the business. It shows what the job costs; nobody is paid from it, because their pay is their salary.'))}><span>${esc(t('ps_projection', 'Projection only'))}</span><b>${esc(money(evaluation.projection_only_cents, { cents:true }))}</b><small>${esc(t('ps_projection_small', 'Salaried time, not paid out'))}</small></div>` : '';
      const daysTile = `<div class="ps-tile"><span>${esc(t('ps_days', 'Estimated days'))}</span><b>${evaluation.duration_days === null || evaluation.duration_days === undefined ? '—' : esc(amount(evaluation.duration_days))}</b><small>${esc(evaluation.duration_basis ? t('ps_days_basis', '{value} {label} at {rate} a day', { value:amount(evaluation.duration_basis.value), label:lowerFirst(evaluation.duration_basis.label), rate:amount(evaluation.duration_basis.units_per_day) }) : draft.duration ? t('ps_days_unknown', 'Not enough to work it out') : t('ps_days_unset', 'Duration not set'))}</small></div>`;
      const hoursTile = evaluation.work?.hours !== null && evaluation.work?.hours !== undefined ? `<div class="ps-tile"><span>${esc(t('ps_est_hours', 'Estimated hours'))}</span><b>${esc(amount(evaluation.work.hours))}</b><small>${esc(t('ps_est_hours_small', 'From the hours each piece of work takes'))}</small></div>` : '';
      const source = result.measurement_source;
      const reads = arr(result.inputs).map((input) => {
        const definition = input.source?.kind === 'measurement' ? vocab.definition(input.source.definition) : null;
        const typeable = input.source?.kind === 'manual' || input.source?.kind === 'work_hours' || input.source?.kind === 'field' || (input.source?.kind === 'measurement' && definition?.key && source !== 'dataset');
        const typed = trial.values[input.name] !== undefined;
        const unitText = definition ? ` ${unitWord(definition.unit, input.value, true)}` : '';
        const absent = input.missing && !input.required && input.source?.kind !== 'work_hours';
        const where = typed ? t('ps_from_typed', 'Typed for this try') : absent ? (input.source?.kind === 'material' ? t('ps_from_none_lists', 'None on the project\'s lists, so its lines do not apply') : t('ps_from_none', 'None on this project, so its lines do not apply')) : input.missing ? (input.reason || t('ps_from_missing', 'Not on this project')) : input.from === 'default' ? t('ps_from_default', 'Not on the project, so its default') : input.from === 'estimated' ? t('ps_from_estimated', 'Estimated from the work') : input.from === 'typed' ? t('ps_from_typed', 'Typed for this try') : input.source?.kind === 'material' ? t('ps_from_lists', 'From the project\'s lists') : input.source?.kind === 'field' ? t('ps_from_field', 'From the project\'s fields') : t('ps_from_measurements', 'From the project\'s measurements');
        return `<div data-ps-read="${esc(input.name)}"><span>${esc(input.label)}</span><em class="${input.missing && !typed ? (absent ? 'none' : 'missing') : ''}">${esc(input.missing && !typed ? where : `${amount(input.value)}${unitText} · ${where}`)}</em>${typeable ? `<input class="pp-input ps-num" data-ps-try-value="${esc(input.name)}" inputmode="decimal" value="${esc(trial.values[input.name] ?? '')}" placeholder="${esc(input.missing ? t('ps_try_enter', 'Enter') : t('ps_try_override', 'Try another'))}" aria-label="${esc(t('ps_try_value', 'Try with a value for {label}', { label:input.label }))}">` : '<span></span>'}</div>`;
      }).join('');
      const work = arr(result.required_work);
      const workChips = work.map((row) => { const state = model.STATES[row.state] || model.STATES.open; return kit.chip({ label:`${row.label}${row.quantity !== null && row.quantity !== undefined ? ` · ${amount(row.quantity)} ${unitWord(row.unit, row.quantity, true)}` : ''}`, tone:state.tone, icon:state.icon, tooltip:state.tooltip }); }).join('');
      return `<div class="ps-tiles">${totalTile}${projection}${daysTile}${hoursTile}</div>
        <p class="ps-sub">${esc(t('ps_try_lines', 'What it would pay'))}</p>
        <div class="ps-lines" data-ps-try-lines>${lines}${unresolved}${equipment}${!lines && !unresolved && !equipment ? `<div class="muted"><span>${esc(t('ps_try_nothing', 'Nothing on this sheet applies to this project'))}</span><em></em><b></b></div>` : ''}<div class="total"><span>${esc(complete ? t('ps_total', 'Total') : t('ps_total_so_far', 'Priced so far'))}</span><em></em><b>${esc(money(evaluation.total_cents || 0, { cents:true }))}</b></div></div>
        <p class="ps-sub">${esc(t('ps_try_read', 'What it read'))}${source === 'none' ? ` · ${esc(t('ps_try_no_measurements', 'this project has no measurements on record'))}` : ''}</p>
        ${reads ? `<div class="ps-read" data-ps-try-read>${reads}</div>` : `<p class="ps-note">${esc(t('ps_try_reads_nothing', 'This sheet reads nothing about the job.'))}</p>`}
        ${work.length ? `<p class="ps-sub">${esc(t('ps_try_work', 'This project\'s work'))}</p><div class="ps-strip" data-ps-try-work>${workChips}</div>` : `<p class="ps-note">${esc(t('ps_try_no_work', 'No work has been added to this project\'s scope yet, so there is nothing to check coverage against.'))}</p>`}`;
    }
    function trialHtml(){
      if (!options.canTry) return '';
      return `<section class="ps-sec" data-ps-section="try">
        <div class="ps-sec-head"><i class="fas fa-flask" aria-hidden="true"></i><h3${tip(t('ps_try_section_tip', 'Price this sheet, as it is now, against a real project. Nothing is saved or changed.'))}>${esc(t('ps_try', 'Try it on a project'))}</h3><span class="ps-spacer"></span></div>
        <div class="ps-try" data-ps-try>${trialInner()}</div>
      </section>`;
    }
    function trialInner(){
      const pick = trial.project
        ? `<div class="ps-try-pick"><span class="ps-try-project"><i class="fas fa-house" aria-hidden="true"></i>${esc(trial.project.title)}<button type="button" class="pp-icon-btn" data-ps-try-clear aria-label="${esc(t('ps_try_change', 'Choose another project'))}"${tip(t('ps_try_change', 'Choose another project'))}><i class="fas fa-xmark" aria-hidden="true"></i></button></span>${trial.loading ? `<span class="ps-note"><i class="fas fa-spinner fa-spin" aria-hidden="true"></i> ${esc(t('ps_try_running', 'Pricing…'))}</span>` : ''}</div>`
        : `<div class="ps-try-pick"><label class="pp-search"><i class="fas fa-magnifying-glass" aria-hidden="true"></i><input type="search" data-ps-try-search value="${esc(trial.query)}" placeholder="${esc(t('ps_try_find', 'Find a project by name or address'))}" aria-label="${esc(t('ps_try_find', 'Find a project by name or address'))}" autocomplete="off" spellcheck="false"></label>${trial.results.length ? `<div class="ps-try-results" role="listbox">${trial.results.map((row) => `<button type="button" role="option" data-ps-try-pick="${esc(row.id)}"><strong>${esc(row.title)}</strong>${row.subtitle ? `<small>${esc(row.subtitle)}</small>` : ''}</button>`).join('')}</div>` : ''}</div>${trial.query && !trial.searching && !trial.results.length ? `<p class="ps-note">${esc(t('ps_try_none', 'No project matches.'))}</p>` : ''}`;
      return `${pick}${trial.error ? `<div class="ps-banner" role="alert"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i><span>${esc(trial.error)}</span></div>` : ''}${trialResultHtml()}`;
    }
    function paintTrial(){
      const box = root.querySelector('[data-ps-try]');
      if (!box) return;
      const focused = document.activeElement?.dataset?.psTryValue;
      const search = document.activeElement?.matches?.('[data-ps-try-search]');
      box.innerHTML = trialInner();
      if (focused) { const field = box.querySelector(`[data-ps-try-value="${CSS.escape(focused)}"]`); if (field) { field.focus(); field.setSelectionRange?.(field.value.length, field.value.length); } }
      if (search) { const field = box.querySelector('[data-ps-try-search]'); field?.focus(); field?.setSelectionRange?.(field.value.length, field.value.length); }
    }

    /* ---- Drawing ---- */
    function render(){
      if (destroyed) return;
      const scroller = root.closest('.pp-modal-panel') || null;
      const top = scroller?.scrollTop;
      const active = document.activeElement;
      const focus = active && root.contains(active) ? focusPath(active) : null;
      root.innerHTML = `${headHtml()}${payHtml()}${workHtml()}${equipmentHtml()}${durationHtml()}${inputsHtml()}${trialHtml()}`;
      if (scroller && top !== undefined) scroller.scrollTop = top;
      if (focus) restoreFocus(focus);
    }
    const focusPath = (element) => {
      const holder = element.closest('[data-ps-line],[data-ps-eq],[data-ps-work],[data-ps-input],[data-ps-provide]');
      const attrs = ['data-ps-line-field', 'data-ps-eq-field', 'data-ps-work-field', 'data-ps-input-field', 'data-ps-provide-field', 'data-ps-duration-field', 'data-ps-name', 'data-ps-kind', 'data-ps-cover', 'data-ps-line-toggle', 'data-ps-duration-mode', 'data-ps-eq-included'];
      const attr = attrs.find((name) => element.hasAttribute(name));
      if (!attr) return null;
      const provide = element.closest('[data-ps-provide]');
      return { holder:holder ? [...holder.attributes].filter((a) => a.name.startsWith('data-ps-') && !a.name.endsWith('index')).map((a) => `[${a.name}="${CSS.escape(a.value)}"]`)[0] : '', eq:provide ? element.closest('[data-ps-eq]')?.dataset.psEq : '', attr, value:element.getAttribute(attr) };
    };
    const restoreFocus = (path) => {
      let scope = root;
      if (path.eq) scope = root.querySelector(`[data-ps-eq="${CSS.escape(path.eq)}"]`) || root;
      if (path.holder) scope = scope.querySelector(path.holder) || scope;
      const element = scope.querySelector(`[${path.attr}${path.value ? `="${CSS.escape(path.value)}"` : ''}]`);
      if (element) { element.focus({ preventScroll:true }); if (element.setSelectionRange && element.type !== 'checkbox' && typeof element.value === 'string') { try { element.setSelectionRange(element.value.length, element.value.length); } catch (_) {} } }
    };
    /* What follows from the draft and does not need the fields drawn again: the sentence, the coverage, the facts under each line. */
    function refreshDerived(){
      const summary = root.querySelector('[data-ps-summary]>span');
      if (summary) summary.textContent = model.summary(draft, vocab);
      const strip = root.querySelector('[data-ps-strip]');
      if (strip) strip.innerHTML = stripHtml();
      const status = root.querySelector('[data-ps-status]');
      if (status) status.innerHTML = statusPill();
      draft.entries.forEach((entry) => {
        const row = root.querySelector(`[data-ps-line="${CSS.escape(entry._key)}"]`);
        if (!row) return;
        const facts = row.querySelector('[data-ps-facts]');
        if (facts) facts.innerHTML = lineFacts(entry);
        const unit = row.querySelector('[data-ps-unit]');
        if (unit) { const per = model.perUnit(entry, draft, vocab); unit.textContent = per ? `/${per}` : ''; }
      });
      const days = root.querySelector('[data-ps-days]');
      const typical = model.typicalDays(draft, vocab);
      if (days && typical) days.querySelector('b').textContent = model.dayWords(typical.days);
    }
    /* touched: the field keys just edited. A problem shown on one of them goes as soon as it changes; Save checks again. */
    function changed(structural = false, touched = []){
      const now = JSON.stringify(model.payload(draft));
      const next = !draft.id || now !== baseline;
      if (next !== dirty) { dirty = next; options.onDirty?.(dirty); }
      let cleared = false;
      if (issues.length) {
        const fresh = model.localIssues(draft, vocab, sheets).map((issue) => issue.message);
        const kept = issues.filter((issue) => (issue.local ? fresh.includes(issue.message) : !issue.keys.some((key) => touched.some((edited) => key === edited || key.startsWith(`${edited}:`)))));
        cleared = kept.length !== issues.length;
        issues = kept;
        // The footer's "check the highlighted parts" goes once nothing is highlighted.
        if (cleared && !issues.length && !banner) options.onStatus?.('dirty', t('unsaved_changes', 'Unsaved changes'));
      }
      if (structural || cleared) render(); else refreshDerived();
      scheduleTrial();
    }

    /* ---- Editing ---- */
    function setPer(entry, value, anchor){
      const measures = model.offeredMeasurements(vocab, draft.schema_ids);
      if (value.startsWith('m:')) {
        const definition = value.slice(2);
        const offered = measures.find((entry) => entry.definition === definition) || vocab.definition(definition);
        entry.input = model.ensureInput(draft, { kind:'measurement', definition }, { label:offered?.label || definition, required:!!offered?.required && !offered?.part_of });
        entry.unit = unitWord(offered?.unit, 1, true);
        return Promise.resolve(true);
      }
      if (value.startsWith('i:')) { entry.input = value.slice(2); const input = inputNamed(entry.input); if (input?.source?.kind === 'work_hours' || (entry.kind !== 'piece_rate')) entry.unit = entry.kind === 'piece_rate' ? entry.unit : 'hour'; return Promise.resolve(true); }
      if (value === 'hours:estimate') { entry.input = model.ensureInput(draft, { kind:'work_hours' }, { label:t('hours', 'Hours'), required:true }); entry.unit = 'hour'; return Promise.resolve(true); }
      if (value === 'hours:typed') { entry.input = model.ensureInput(draft, { kind:'manual' }, { label:t('hours', 'Hours'), required:true }); entry.unit = 'hour'; return Promise.resolve(true); }
      const forms = {
        'new:material':{ title:t('ps_new_material', 'Material on the project\'s lists'), fields:[{ id:'type', label:t('ps_item_type_label', 'Item type on the lists'), required:true, placeholder:'Shingles' }, { id:'unit', label:t('ps_unit_word', 'Counted in'), value:'bundle' }], make:(values) => { entry.input = model.ensureInput(draft, { kind:'material', item_type:values.type }, { label:values.type, required:arr(entry.covers).length > 0 }); entry.unit = values.unit || ''; } },
        'new:field':{ title:t('ps_new_field', 'A project field'), fields:[{ id:'key', label:t('ps_field_key', 'Project field'), required:true }, { id:'label', label:t('ps_called', 'Called') }, { id:'unit', label:t('ps_unit_word', 'Counted in'), value:'ft' }], make:(values) => { entry.input = model.ensureInput(draft, { kind:'field', key:values.key }, { label:values.label || values.key, required:false }); entry.unit = values.unit || ''; } },
        'new:manual':{ title:t('ps_new_manual', 'A number typed for each job'), fields:[{ id:'label', label:t('ps_what_typed', 'What is typed'), required:true }, { id:'unit', label:t('ps_unit_word', 'Counted in'), value:'' }], make:(values) => { entry.input = model.ensureInput(draft, { kind:'manual' }, { label:values.label, required:false, default:0 }); entry.unit = values.unit || ''; } }
      };
      const form = forms[value];
      if (!form) return Promise.resolve(false);
      // Material and project fields are chosen from the organization's own lists; typing one in is only for when they cannot be read.
      if (value === 'new:material' || value === 'new:field') return pickFrom(value, entry, anchor).then((picked) => (picked === null ? freeText() : picked));
      return freeText();
      function freeText(){ return kit.form(anchor, { title:form.title, submitLabel:t('ps_use', 'Use'), fields:form.fields, align:'start' }).then((values) => { if (!values) return false; form.make(values); return true; }); }
    }
    /*
     * The organization's price book types and items, or its number fields on projects, as a searchable list. Resolves
     * true when one was chosen, false when the list was closed, and null when the list could not be read at all.
     */
    const choices = { material:null, field:null };
    async function pickFrom(kindOfPick, entry, anchor){
      const material = kindOfPick === 'new:material';
      let list;
      try {
        if (material) list = choices.material || (choices.material = await model.api.materialChoices(orgId));
        else list = choices.field || (choices.field = await model.api.projectFieldChoices(orgId, trial.project?.id));
      } catch (_) { if (material) choices.material = null; else choices.field = null; return null; }
      if (destroyed || !anchor.isConnected) return false;
      const items = material
        ? [
          { heading:t('ps_item_types', 'Item types') },
          ...(list.types.length ? list.types.map((row) => ({ id:`type:${row.type}`, label:row.label, icon:'fa-layer-group', hint:kit.countPhrase([[row.count, t('ps_item_one', 'item'), t('ps_item_many', 'items')]]), tooltip:t('ps_type_tip', 'Counts every item of this type on the project\'s lists, including items added to the price book later') })) : [{ id:'none', label:t('ps_no_types', 'The price book has no item types yet'), disabled:true }]),
          ...(list.items.length ? [{ heading:t('ps_one_item', 'One item') }, ...list.items.map((row) => ({ id:`item:${row.id}`, label:row.name, icon:'fa-box', hint:list.types.find((type) => type.type === row.type)?.label || row.type, tooltip:t('ps_item_tip', 'Counts only this item. If it is replaced in the price book, this line has to be changed too.') }))] : [])
        ]
        : (list.length ? list.map((row) => ({ id:`field:${row.key}`, label:row.label, icon:'fa-table-cells', hint:row.typeLabel })) : [{ id:'none', label:t('ps_no_number_fields', 'Projects have no number fields yet'), disabled:true }]);
      return new Promise((resolve) => {
        let chosen = false;
        kit.menu(anchor, {
          align:'start', title:material ? t('ps_new_material', 'Material on the project\'s lists') : t('ps_new_field', 'A project field'),
          titleTip:material ? t('ps_material_pick_tip', 'Paid per the quantity of this on the project\'s material lists. Choose a type where you can.') : t('ps_field_pick_tip', 'Paid per the number this field holds on each project'),
          search:material ? t('ps_search_price_book', 'Search the price book') : t('ps_search_fields', 'Search fields'), items,
          onSelect:(item) => {
            chosen = true;
            if (item.id.startsWith('type:')) { const row = list.types.find((candidate) => `type:${candidate.type}` === item.id); entry.input = model.ensureInput(draft, { kind:'material', item_type:row.type }, { label:row.label, required:arr(entry.covers).length > 0 }); entry.unit = row.unit || entry.unit || ''; }
            else if (item.id.startsWith('item:')) { const row = list.items.find((candidate) => `item:${candidate.id}` === item.id); entry.input = model.ensureInput(draft, { kind:'material', item_id:row.id }, { label:row.name, required:arr(entry.covers).length > 0 }); entry.unit = row.unit || entry.unit || ''; }
            else if (item.id.startsWith('field:')) { const row = list.find((candidate) => `field:${candidate.key}` === item.id); entry.input = model.ensureInput(draft, { kind:'field', key:row.key }, { label:row.label, required:false }); }
            resolve(true);
          },
          onClose:() => { if (!chosen) resolve(false); }
        });
      });
    }
    function setKindOfWork(value){
      draft.schema_ids = value && value !== '__none' ? [value] : [];
      const offered = new Set(model.offeredItems(vocab, draft.schema_ids).map((item) => item.item));
      const before = JSON.stringify([draft.entries.map((entry) => entry.covers), draft.work, draft.equipment.map((item) => item.provides)]);
      draft.entries.forEach((entry) => { entry.covers = arr(entry.covers).filter((item) => offered.has(item)); });
      draft.work = draft.work.filter((entry) => offered.has(entry.item));
      draft.equipment.forEach((item) => { item.provides = arr(item.provides).filter((entry) => !entry.item || offered.has(entry.item)); });
      if (before !== JSON.stringify([draft.entries.map((entry) => entry.covers), draft.work, draft.equipment.map((item) => item.provides)])) kit.toast(t('ps_kind_changed', 'Kind of work changed'), t('ps_kind_changed_detail', 'Work that {kind} does not include was taken off the sheet.', { kind:draft.schema_ids.length ? vocab.kindTitle(draft.schema_ids[0]) : t('ps_kind_none_short', 'no kind of work') }), true);
    }
    function workEntry(item){ let entry = draft.work.find((candidate) => candidate.item === item); if (!entry) { entry = { item, included:false }; draft.work.push(entry); } return entry; }

    root.addEventListener('input', (event) => {
      const target = event.target;
      if (readOnly) return;
      if (target.matches('[data-ps-name]')) { draft.name = target.value; changed(false, ["name"]); return; }
      const lineRow = target.closest('[data-ps-line]');
      const lineField = target.dataset.psLineField;
      if (lineRow && lineField && target.tagName === 'INPUT') {
        const entry = lineByKey(lineRow.dataset.psLine);
        if (!entry) return;
        if (lineField === 'label') entry.label = target.value;
        else if (lineField === 'rate') entry.rate_cents = toCents(target.value) ?? 0;
        else if (lineField === 'minimum') { const cents = toCents(target.value); if (cents === undefined) delete entry.minimum_cents; else entry.minimum_cents = cents; }
        else if (lineField === 'multiplier') { const number = toNumber(target.value); if (number === undefined) delete entry.multiplier; else entry.multiplier = number; }
        else if (lineField === 'unit') entry.unit = target.value;
        changed(false, [`line:${entry._key}:${lineField}`]);
        return;
      }
      const workRow = target.closest('[data-ps-work]');
      if (workRow && target.dataset.psWorkField === 'hours') { const entry = workEntry(workRow.dataset.psWork); const number = toNumber(target.value); if (number === undefined) delete entry.hours_per_unit; else entry.hours_per_unit = number; changed(false, [`work:${workRow.dataset.psWork}`, "work"]); return; }
      const eqRow = target.closest('[data-ps-eq]');
      if (eqRow) {
        const item = eqByKey(eqRow.dataset.psEq);
        if (!item) return;
        if (target.dataset.psEqField === 'name') item.name = target.value;
        else if (target.dataset.psEqField === 'rate') item.rate_cents = toCents(target.value) ?? 0;
        else if (target.dataset.psProvideField === 'capacity') { const provided = item.provides[Number(target.closest('[data-ps-provide]').dataset.psProvide)]; const number = toNumber(target.value); if (number === undefined) delete provided.capacity; else provided.capacity = number; }
        changed(false, [`eq:${item._key}`]);
        return;
      }
      if (target.dataset.psDurationField === 'units_per_day' && draft.duration) { draft.duration.units_per_day = toNumber(target.value) ?? 0; changed(false, ["duration"]); return; }
      if (target.dataset.psDurationField === 'hours_per_day' && draft.duration) { draft.duration.hours_per_day = toNumber(target.value) ?? 0; changed(false, ["duration"]); return; }
      const inputRow = target.closest('[data-ps-input]');
      if (inputRow && target.tagName === 'INPUT' && target.type !== 'checkbox') {
        const input = inputNamed(inputRow.dataset.psInput);
        if (!input) return;
        const field = target.dataset.psInputField;
        if (field === 'label') input.label = target.value;
        else if (field === 'default') { const number = toNumber(target.value); if (number === undefined) delete input.default; else input.default = number; }
        else if (field === 'item_type') input.source.item_type = target.value;
        else if (field === 'key') input.source.key = target.value;
        delete input._implicit;
        changed(false, [`input:${input.name}`]);
        return;
      }
      if (target.matches('[data-ps-try-search]')) {
        trial.query = target.value;
        window.clearTimeout(searchTimer);
        const query = target.value.trim();
        if (!query) { trial.results = []; paintTrial(); return; }
        trial.searching = true;
        searchTimer = window.setTimeout(async () => {
          try { const results = await model.api.searchProjects(orgId, query); if (trial.query.trim() === query) { trial.results = results; trial.searching = false; paintTrial(); } }
          catch (error) { trial.searching = false; trial.error = error?.message || t('ps_try_search_failed', 'Projects could not be searched.'); paintTrial(); }
        }, 220);
        return;
      }
      if (target.dataset.psTryValue) {
        const number = toNumber(target.value);
        if (number === undefined || Number.isNaN(number)) delete trial.values[target.dataset.psTryValue]; else trial.values[target.dataset.psTryValue] = number;
        scheduleTrial();
      }
    });
    root.addEventListener('change', async (event) => {
      const target = event.target;
      if (readOnly) return;
      if (target.matches('[data-ps-kind]')) { setKindOfWork(target.value); changed(true, ["kind"]); return; }
      const lineRow = target.closest('[data-ps-line]');
      const lineField = target.dataset.psLineField;
      if (lineRow && lineField && target.tagName === 'SELECT') {
        const entry = lineByKey(lineRow.dataset.psLine);
        if (!entry) return;
        if (lineField === 'kind') {
          const was = entry.kind;
          entry.kind = target.value;
          const source = inputNamed(entry.input)?.source;
          const timed = entry.kind === 'hourly' || entry.kind === 'cost_rate';
          if (timed && !(source?.kind === 'manual' || source?.kind === 'work_hours')) { const hours = draft.inputs.find((input) => input.source?.kind === 'work_hours') || draft.inputs.find((input) => input.source?.kind === 'manual' && /hour/i.test(input.label || input.name)); entry.input = hours?.name || ''; }
          if (entry.kind === 'flat' || entry.kind === 'salary') { entry.input = ''; delete entry.multiplier; }
          if (entry.kind === 'piece_rate' && (was === 'hourly' || was === 'cost_rate')) entry.input = '';
          entry.unit = timed ? 'hour' : entry.kind === 'piece_rate' ? (entry.unit === 'hour' ? '' : entry.unit) : '';
          changed(true, [`line:${entry._key}`]);
          return;
        }
        if (lineField === 'per') { const ok = await setPer(entry, target.value, target); changed(true, [`line:${entry._key}:per`, `input:${entry.input}`]); if (!ok) render(); return; }
        if (lineField === 'when') { entry.when = target.value || ''; changed(true, [`line:${entry._key}:when`]); return; }
        if (lineField === 'role') { entry.role = target.value || ''; changed(true); return; }
      }
      const workRow = target.closest('[data-ps-work]');
      if (workRow && target.dataset.psWorkField === 'included') { workEntry(workRow.dataset.psWork).included = target.checked; changed(true, [`work:${workRow.dataset.psWork}`, "work"]); return; }
      const eqRow = target.closest('[data-ps-eq]');
      if (eqRow && target.closest('[data-ps-provide]')) {
        const item = eqByKey(eqRow.dataset.psEq);
        const provided = item?.provides[Number(target.closest('[data-ps-provide]').dataset.psProvide)];
        if (!provided) return;
        if (target.dataset.psProvideField === 'item') { provided.item = target.value; const fn = vocab.item(target.value); if (fn?.per_load_default !== undefined && provided.per_load === undefined) provided.per_load = fn.per_load_default; }
        if (target.dataset.psProvideField === 'per_load') provided.per_load = target.checked;
        changed(true, [`eq:${item._key}`]);
        return;
      }
      if (target.dataset.psDurationField === 'input' && draft.duration) {
        const value = target.value;
        if (value.startsWith('m:')) { const definition = vocab.definition(value.slice(2)); draft.duration.input = model.ensureInput(draft, { kind:'measurement', definition:value.slice(2) }, { label:definition?.label || value.slice(2), required:false }); }
        else draft.duration.input = value.slice(2);
        changed(true, ["duration"]);
        return;
      }
      const inputRow = target.closest('[data-ps-input]');
      if (inputRow) {
        const input = inputNamed(inputRow.dataset.psInput);
        if (!input) return;
        const field = target.dataset.psInputField;
        if (field === 'required') { input.required = target.checked; if (input.required) delete input.default; }
        else if (field === 'per_structure') { if (target.checked) input.source.per_structure = true; else delete input.source.per_structure; }
        else if (field === 'definition') { input.source.definition = target.value; const definition = vocab.definition(target.value); if (!definition?.per_structure) delete input.source.per_structure; }
        else return;
        delete input._implicit;
        changed(true, [`input:${input.name}`]);
      }
    });
    root.addEventListener('click', async (event) => {
      const target = event.target;
      if (target.closest('[data-ps-back]')) { options.onBack?.(); return; }
      if (target.closest('[data-ps-jump-try]')) { const section = root.querySelector('[data-ps-section="try"]'); section?.scrollIntoView({ behavior:'smooth', block:'start' }); window.setTimeout(() => section?.querySelector('[data-ps-try-search],[data-ps-try-value]')?.focus({ preventScroll:true }), 300); return; }
      if (target.closest('[data-ps-reload]')) { reload(); return; }
      if (target.closest('[data-ps-advanced]')) { advanced = !advanced; render(); return; }
      const more = target.closest('[data-ps-more]');
      if (more) { moreMenu(more); return; }
      const tryPick = target.closest('[data-ps-try-pick]');
      if (tryPick) { const found = trial.results.find((row) => row.id === tryPick.dataset.psTryPick); if (found) { trial.project = found; trial.results = []; trial.query = ''; trial.values = {}; runTrial(); } return; }
      if (target.closest('[data-ps-try-clear]')) { trial.project = null; trial.result = null; trial.error = ''; trial.values = {}; trial.serial += 1; paintTrial(); root.querySelector('[data-ps-try-search]')?.focus(); return; }
      if (readOnly) { const toggle = target.closest('[data-ps-line-toggle]'); if (toggle) { const key = toggle.closest('[data-ps-line]').dataset.psLine; if (open.has(key)) open.delete(key); else open.add(key); render(); } return; }
      if (target.closest('[data-ps-add-line]')) {
        const entry = { _key:model.newKey('line'), label:'', kind:'piece_rate', unit:'', rate_cents:0, input:'', covers:[] };
        draft.entries.push(entry);
        open.add(entry._key);
        changed(true, ["duration"]);
        root.querySelector(`[data-ps-line="${CSS.escape(entry._key)}"] [data-ps-line-field="label"]`)?.focus();
        return;
      }
      const lineRow = target.closest('[data-ps-line]');
      if (lineRow) {
        const entry = lineByKey(lineRow.dataset.psLine);
        if (!entry) return;
        if (target.closest('[data-ps-line-toggle]')) { if (open.has(entry._key)) open.delete(entry._key); else open.add(entry._key); render(); return; }
        if (target.closest('[data-ps-line-remove]')) { draft.entries = draft.entries.filter((candidate) => candidate !== entry); open.delete(entry._key); changed(true); return; }
        const cover = target.closest('[data-ps-cover]');
        if (cover) { const item = cover.dataset.psCover; entry.covers = arr(entry.covers).includes(item) ? entry.covers.filter((value) => value !== item) : [...arr(entry.covers), item]; changed(true, [`line:${entry._key}:covers`]); return; }
      }
      if (target.closest('[data-ps-add-eq]')) {
        const functions = model.offeredItems(vocab, draft.schema_ids).filter((item) => item.kind === 'function');
        const item = { _key:model.newKey('equipment'), name:'', included:true, provides:functions.length === 1 ? [{ item:functions[0].item, per_load:functions[0].per_load_default !== false }] : [] };
        draft.equipment.push(item);
        changed(true);
        root.querySelector(`[data-ps-eq="${CSS.escape(item._key)}"] [data-ps-eq-field="name"]`)?.focus();
        return;
      }
      const eqRow = target.closest('[data-ps-eq]');
      if (eqRow) {
        const item = eqByKey(eqRow.dataset.psEq);
        if (!item) return;
        const included = target.closest('[data-ps-eq-included]');
        if (included) { item.included = included.dataset.psEqIncluded === 'yes'; if (!item.included && item.rate_cents === undefined) item.rate_cents = 0; changed(true); return; }
        if (target.closest('[data-ps-eq-remove]')) { draft.equipment = draft.equipment.filter((candidate) => candidate !== item); changed(true); return; }
        if (target.closest('[data-ps-provide-add]')) { const functions = model.offeredItems(vocab, draft.schema_ids).filter((entry) => entry.kind === 'function' && !item.provides.some((provided) => provided.item === entry.item)); item.provides.push({ item:functions[0]?.item || '', per_load:functions[0]?.per_load_default !== false }); changed(true); return; }
        const removeProvide = target.closest('[data-ps-provide-remove]');
        if (removeProvide) { item.provides.splice(Number(removeProvide.closest('[data-ps-provide]').dataset.psProvide), 1); changed(true); return; }
      }
      const mode = target.closest('[data-ps-duration-mode]');
      if (mode) {
        const id = mode.dataset.psDurationMode;
        if (id === 'none') draft.duration = null;
        else if (id === 'hours') draft.duration = { hours_per_day:draft.duration?.hours_per_day || 8 };
        else {
          const main = model.mainMeasure(kind());
          const input = draft.duration?.input || (main ?model.ensureInput(draft, { kind:'measurement', definition:main.definition }, { label:main.label, required:false }) : '');
          draft.duration = { input, units_per_day:draft.duration?.units_per_day || 20 };
        }
        changed(true);
        return;
      }
      if (target.closest('[data-ps-add-input]')) { addInputMenu(target.closest('[data-ps-add-input]')); return; }
      const removeInput = target.closest('[data-ps-input-remove]');
      if (removeInput) { const name = removeInput.closest('[data-ps-input]').dataset.psInput; draft.inputs = draft.inputs.filter((input) => input.name !== name); changed(true); }
    });

    function addInputMenu(anchor){
      const measures = model.offeredMeasurements(vocab, draft.schema_ids);
      kit.menu(anchor, { align:'end', title:t('ps_add_input_title', 'Read something new'), items:[
        ...(measures.length ? [{ heading:t('ps_per_measurements_plain', 'Measurements') }, ...measures.map((entry) => ({ id:`m:${entry.definition}`, label:entry.label }))] : []),
        { separator:true },
        { id:'material', label:t('ps_per_new_material', 'Material on the lists…'), icon:'fa-boxes-stacked' },
        { id:'field', label:t('ps_per_new_field', 'A project field…'), icon:'fa-table-cells' },
        { id:'manual', label:t('ps_per_new_manual', 'A number typed for each job…'), icon:'fa-keyboard' },
        { id:'work_hours', label:t('ps_per_hours_estimate', 'Hours estimated from the work'), icon:'fa-clock', disabled:draft.inputs.some((input) => input.source?.kind === 'work_hours') }
      ], onSelect:(item) => {
        const add = (source, values) => { draft.inputs.push({ name:uniqueName(values.label), label:values.label, source, required:values.required !== false }); changed(true); };
        const uniqueName = (label) => { const probe = { inputs:draft.inputs }; model.ensureInput(probe, { kind:'manual' }, { label }); const made = probe.inputs.pop(); return made.name; };
        if (item.id.startsWith('m:')) { const entry = measures.find((row) => row.definition === item.id.slice(2)); if (!draft.inputs.some((input) => input.source?.kind === 'measurement' && input.source.definition === entry.definition)) add({ kind:'measurement', definition:entry.definition }, { label:entry.label, required:entry.required && !entry.part_of }); return; }
        if (item.id === 'work_hours') { add({ kind:'work_hours' }, { label:t('hours', 'Hours') }); return; }
        const fields = item.id === 'material' ? [{ id:'label', label:t('ps_item_type_label', 'Item type on the lists'), required:true }] : item.id === 'field' ? [{ id:'key', label:t('ps_field_key', 'Project field'), required:true }, { id:'label', label:t('ps_called', 'Called') }] : [{ id:'label', label:t('ps_what_typed', 'What is typed'), required:true }];
        window.setTimeout(() => kit.form(anchor, { title:item.label.replace(/…$/, ''), fields, submitLabel:t('ps_add_input', 'Add') }).then((values) => {
          if (!values) return;
          if (item.id === 'material') add({ kind:'material', item_type:values.label }, { label:values.label, required:false });
          else if (item.id === 'field') add({ kind:'field', key:values.key }, { label:values.label || values.key, required:false });
          else add({ kind:'manual' }, { label:values.label, required:false });
        }), 0);
      } });
    }

    function moreMenu(anchor){
      kit.menu(anchor, { align:'end', label:t('ps_more', 'More'), items:[
        ...(readOnly || !draft.id ? [{ id:'none', label:draft.id ? t('ps_read_only', 'Read only') : t('ps_save_first', 'Save the sheet to duplicate or archive it'), disabled:true }] : [{ id:'duplicate', label:t('ps_duplicate', 'Duplicate…'), icon:'fa-copy', tooltip:t('ps_duplicate_tip', 'Copy this sheet to another assignee or another kind of work') }, { id:'archive', label:t('ps_archive', 'Archive'), icon:'fa-box-archive', tone:'danger' }])
      ], onSelect:(item) => {
        if (item.id === 'duplicate') window.setTimeout(() => duplicate(anchor), 0);
        if (item.id === 'archive') window.setTimeout(() => archive(anchor), 0);
      } });
    }
    async function archive(anchor){
      const yes = await kit.confirm(anchor, { title:t('ps_archive_confirm', 'Archive {name}? Labor lists stop using it.', { name:draft.name || t('ps_this_sheet', 'this sheet') }), confirmLabel:t('ps_archive', 'Archive'), tone:'danger' });
      if (!yes) return;
      try {
        await model.api.archive(orgId, draft.id, draft.revision);
        kit.toast(t('ps_archived', 'Archived'), draft.name, true);
        dirty = false;
        options.onDirty?.(false);
        options.onArchived?.(draft);
      } catch (error) { showError(error); render(); }
    }
    function assigneeOptions(){
      const state = People.data?.state || {};
      const labels = state.groupLabels || {};
      const groups = arr(state.groups).map((row) => ({ value:`resource_group:${row.id}`, label:`${row.name || row.id} · ${labels.singular || t('group', 'Group')}` }));
      const companies = arr(state.connections).map((row) => ({ value:`organization_connection:${row.id}`, label:`${row.name || row.id} · ${labels.connectionSingular || t('subcontractor', 'Subcontractor')}` }));
      const users = arr(state.users).filter((row) => row.status !== 'suspended').map((row) => ({ value:`organization_user:${row.id}`, label:`${row.name || row.email || row.id} · ${t('user', 'User')}` }));
      const all = [...groups, ...companies, ...users];
      const current = `${draft.subject?.type}:${draft.subject?.id}`;
      if (!all.some((row) => row.value === current)) all.unshift({ value:current, label:options.assigneeName || current });
      return all;
    }
    async function duplicate(anchor){
      const current = `${draft.subject?.type}:${draft.subject?.id}`;
      const result = await kit.form(anchor, {
        title:t('ps_duplicate_title', 'Duplicate pay sheet'), submitLabel:t('ps_duplicate_go', 'Make the copy'), submitIcon:'fa-copy',
        fields:[
          { id:'assignee', type:'select', label:t('assignee', 'Assignee'), value:current, options:assigneeOptions() },
          { id:'kind', type:'select', label:t('ps_kind', 'Kind of work'), value:draft.schema_ids[0] || '__none', options:[...vocab.kinds.map((entry) => ({ value:entry.id, label:entry.title })), { value:'__none', label:t('ps_kind_none', 'None (hourly or salaried)') }] },
          { id:'name', label:t('ps_name', 'Pay sheet name'), value:t('ps_copy_name', '{name} (copy)', { name:draft.name }), required:true }
        ],
        submit:async (values) => {
          const [type, ...rest] = values.assignee.split(':');
          const copyDraft = model.draftOf({ ...model.payload(draft), id:'', revision:undefined, subject:{ type, id:rest.join(':') }, name:values.name });
          delete copyDraft.id; delete copyDraft.revision; delete copyDraft.expected_revision;
          const schema = values.kind === '__none' ? [] : [values.kind];
          if (JSON.stringify(schema) !== JSON.stringify(copyDraft.schema_ids)) {
            copyDraft.schema_ids = schema;
            const offered = new Set(model.offeredItems(vocab, schema).map((item) => item.item));
            copyDraft.entries.forEach((entry) => { entry.covers = arr(entry.covers).filter((item) => offered.has(item)); });
            copyDraft.work = copyDraft.work.filter((entry) => offered.has(entry.item));
            copyDraft.equipment.forEach((item) => { item.provides = arr(item.provides).filter((entry) => offered.has(entry.item)); });
          }
          try { return await model.api.save(orgId, model.payload(copyDraft)); }
          catch (error) { const list = arr(error?.data?.issues); throw new Error(list.length ? model.issueText(list[0], copyDraft, vocab) : (error?.message || t('ps_not_saved', 'Not saved'))); }
        }
      });
      if (!result || !result.id) return;
      sheets = [...sheets, result];
      kit.toast(t('ps_duplicated', 'Copy made'), result.name, true);
      options.onDuplicated?.(result);
    }

    function showError(error){
      const code = text(error?.data?.error || error?.code);
      if (code === 'revision_conflict' || error?.status === 409) banner = { text:t('ps_conflict', 'Someone else saved this sheet while you were editing. Load their version to see it; your changes here are not kept.'), reload:true };
      else if (code === 'pay_sheet_overlap') { setIssues([{ path:['schema_ids'], code, message:error.message }], lastPayloadInputs); banner = null; }
      else banner = { text:error?.message || t('ps_not_saved', 'Not saved') };
    }
    async function reload(){
      try {
        const fresh = (await model.api.list(orgId)).find((sheet) => sheet.id === draft.id);
        if (!fresh) { banner = { text:t('ps_gone', 'This sheet was archived by someone else.') }; render(); return; }
        draft = model.draftOf(fresh);
        baseline = JSON.stringify(model.payload(draft));
        banner = null; issues = [];
        dirty = false; options.onDirty?.(false);
        render();
      } catch (error) { banner = { text:error?.message || t('load_failed', 'Could not load') }; render(); }
    }
    async function save(){
      const local = model.localIssues(draft, vocab, sheets);
      banner = null;
      if (local.length) { setIssues(local, draft.inputs); render(); throw new Error(t('ps_fix_first', 'Check the highlighted parts of the pay sheet')); }
      const body = model.payload(draft);
      lastPayloadInputs = body.inputs;
      try {
        const saved = await model.api.save(orgId, body);
        draft = model.draftOf(saved);
        baseline = JSON.stringify(model.payload(draft));
        issues = []; banner = null;
        sheets = [...sheets.filter((sheet) => sheet.id !== saved.id), saved];
        dirty = false;
        options.onDirty?.(false);
        render();
        options.onSaved?.(saved);
        return saved;
      } catch (error) {
        const list = arr(error?.data?.issues);
        if (list.length) { setIssues(list, body.inputs); render(); throw new Error(t('ps_fix_first', 'Check the highlighted parts of the pay sheet')); }
        showError(error);
        render();
        throw new Error(banner?.text || errorsAt('kind')[0] || error?.message || t('ps_not_saved', 'Not saved'));
      }
    }

    render();
    if (dirty) options.onDirty?.(true);
    return {
      el:root,
      save,
      isDirty:() => dirty,
      draft:() => draft,
      destroy(){ destroyed = true; window.clearTimeout(trialTimer); window.clearTimeout(searchTimer); host.replaceChildren(); }
    };
  }

  /* ---- The People 'pay_sheets' slot: one assignee's sheets ---- */
  const cache = { kinds:new Map() };
  function kindsFor(orgId){
    if (!cache.kinds.has(orgId)) cache.kinds.set(orgId, model.api.kinds(orgId).then(model.vocabulary).catch((error) => { cache.kinds.delete(orgId); throw error; }));
    return cache.kinds.get(orgId);
  }
  /* Rows of one sheet for listPage: its name, the sentence, and what it leaves open. */
  function sheetRow(sheet, vocab, extra = {}){
    const draft = model.draftOf(sheet);
    const rows = model.coverage(draft, vocab);
    const open = rows.filter((row) => row.state === 'open' || row.state === 'adjusted');
    const accounted = rows.length - open.length;
    return {
      key:`sheet:${sheet.id}`, entity:{ id:sheet.id, name:sheet.name, icon:ICON }, square:true,
      title:sheet.name, secondary:model.summary(draft, vocab),
      pills:[{ label:arr(sheet.schema_ids).length ? vocab.kindTitle(sheet.schema_ids[0]) : t('ps_kind_none_short', 'No kind of work'), tone:'role', tooltip:t('ps_kind', 'Kind of work') }],
      chipGroups:rows.length ? [{ chips:[...(accounted ? [{ label:t('ps_accounted', '{count} of {total} accounted for', { count:accounted, total:rows.length }), tone:open.length ? 'neutral' : 'ok', icon:'fa-circle-check', tooltip:rows.filter((row) => !open.includes(row)).map((row) => row.label).join(', ') }] : []), ...open.map((row) => ({ label:row.label, tone:model.STATES[row.state].tone, icon:model.STATES[row.state].icon, tooltip:model.STATES[row.state].tooltip }))] }] : [],
      ...extra
    };
  }
  function mountSlot(container, context = {}){
    ensureStyles();
    People.listPage.ensureStyles();
    const entity = context.entity || {};
    const assignee = { type:entity.kind, id:entity.id };
    const orgId = text(context.orgId || window.__APP?.userOrgId || window.__APP?.orgId);
    const canEdit = !context.readOnly && (People.data?.allows ? People.data.allows('pay_sheets.edit') : true);
    const canTry = People.data?.allows ? People.data.allows('pay_sheets.try') : true;
    let vocab = null;
    let sheets = [];
    let capable = [];
    let editor = null;
    let list = null;
    let destroyed = false;
    const mine = () => sheets.filter((sheet) => sheet.subject?.type === assignee.type && sheet.subject?.id === assignee.id);
    const usedKinds = () => new Set(mine().flatMap((sheet) => arr(sheet.schema_ids)));
    const hasUnscoped = () => mine().some((sheet) => !arr(sheet.schema_ids).length);

    function openEditor(sheet){
      list?.destroy(); list = null;
      container.replaceChildren();
      const host = document.createElement('div');
      container.appendChild(host);
      editor = mount(host, {
        orgId, sheet, vocab, sheets, assigneeName:entity.name, readOnly:!canEdit, canTry,
        onDirty:(value) => context.onDirty?.(value), onStatus:(state, words) => context.setStatus?.(state, words),
        onSaved:(saved) => { sheets = [...sheets.filter((row) => row.id !== saved.id), saved]; context.onSaved?.(); },
        onArchived:(gone) => { sheets = sheets.filter((row) => row.id !== gone.id); showList(); },
        onDuplicated:(made) => { sheets = [...sheets, made]; if (made.subject?.type === assignee.type && made.subject?.id === assignee.id) openEditor(made); },
        onBack:async () => {
          if (editor?.isDirty()) {
            const leave = await kit.confirm(container.querySelector('[data-ps-back]') || container, { title:t('discard_changes', 'Discard unsaved changes?'), confirmLabel:t('discard', 'Discard'), cancelLabel:t('keep_editing', 'Keep editing'), tone:'danger', align:'start' });
            if (!leave) return;
          }
          context.onDirty?.(false); context.setStatus?.("", "");
          showList();
        }
      });
    }
    function addMenu(anchor){
      const used = usedKinds();
      const items = [...vocab.kinds.map((kind) => ({ id:kind.id, label:kind.title, icon:ICON, disabled:used.has(kind.id), hint:used.has(kind.id) ? t('ps_has_one', 'Has one') : '', tooltip:kind.description })), { separator:true }, { id:'__none', label:t('ps_kind_none', 'None (hourly or salaried)'), icon:'fa-clock', disabled:hasUnscoped(), hint:hasUnscoped() ? t('ps_has_one', 'Has one') : '' }];
      kit.menu(anchor, { align:'end', title:t('ps_add_for_kind', 'Add pay sheet for a kind of work'), titleTip:t('ps_one_per_kind', 'An assignee has one pay sheet for each kind of work'), items, onSelect:(item) => openEditor(model.starter(assignee, item.id === '__none' ? '' : item.id, vocab, entity.name)) });
    }
    function showList(){
      editor?.destroy(); editor = null;
      container.replaceChildren();
      const host = document.createElement('div');
      container.appendChild(host);
      const own = mine().sort((a, b) => a.name.localeCompare(b.name));
      const missing = capable.filter((kindId) => !usedKinds().has(kindId) && vocab.kind(kindId));
      list = People.listPage.mount(host, {
        embedded:true, columns:false, title:t('ps_pay_sheets', 'Pay sheets'),
        subtitle:kit.countPhrase([[own.length, t('ps_sheet_one', 'pay sheet'), t('ps_sheet_many', 'pay sheets')]]),
        actions:canEdit ? [{ id:'add', needs:'pay_sheets.edit', label:t('ps_add_for_kind', 'Add pay sheet for a kind of work'), icon:'fa-plus', primary:true, menu:true, onClick:addMenu }] : [],
        empty:{ icon:ICON, title:t('ps_none_yet', 'No pay sheet yet'), ...(canEdit ? { action:{ label:t('ps_add_for_kind', 'Add pay sheet for a kind of work'), onClick:addMenu } } : {}) },
        row:(sheet) => sheetRow(sheet, vocab, { actions:[{ id:'open', needs:'pay_sheets', icon:kit.ICONS.edit, label:t('open', 'Open') }] }),
        onOpen:(sheet) => openEditor(sheet),
        onAction:(id, sheet) => { if (id === 'open') openEditor(sheet); }
      });
      list.setItems(own);
      if (missing.length && canEdit) {
        const note = document.createElement('div');
        note.className = 'pp ps-sheet-list';
        note.innerHTML = missing.map((kindId) => `<div class="ps-capable" data-ps-capable="${esc(kindId)}"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i><span>${esc(t('ps_capable_missing', 'Able to do {kind} work, with no {kindLower} pay sheet', { kind:vocab.kindTitle(kindId), kindLower:lowerFirst(vocab.kindTitle(kindId)) }))}</span><button type="button" class="pp-btn" data-ps-capable-add="${esc(kindId)}"><i class="fas fa-plus" aria-hidden="true"></i>${esc(t('ps_add', 'Add'))}</button></div>`).join('');
        note.addEventListener('click', (event) => { const add = event.target.closest('[data-ps-capable-add]'); if (add) openEditor(model.starter(assignee, add.dataset.psCapableAdd, vocab, entity.name)); });
        note.style.marginTop = '14px';
        container.appendChild(note);
      }
    }
    container.innerHTML = `<div class="pp pp-state" aria-busy="true"><i class="fas ${ICON}" aria-hidden="true"></i><strong>${esc(t('loading', 'Loading…'))}</strong></div>`;
    Promise.all([kindsFor(orgId), model.api.list(orgId), model.api.capabilities(orgId, assignee).catch(() => null)]).then(([words, all, able]) => {
      if (destroyed) return;
      vocab = words; sheets = all;
      const items = new Set(arr(able?.items));
      capable = able?.known ? vocab.kinds.filter((kind) => arr(able.schema_ids).includes(kind.id) || arr(able.scope_schema_ids).includes(kind.id) || arr(kind.work).some((item) => items.has(item.item))).map((kind) => kind.id) : [];
      showList();
    }).catch((error) => {
      if (!destroyed) container.innerHTML = `<div class="pp pp-state" role="alert"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i><strong>${esc(error?.message || t('load_failed', 'Could not load'))}</strong></div>`;
    });
    return {
      save:async () => { if (editor?.isDirty()) await editor.save(); },
      destroy(){ destroyed = true; editor?.destroy(); list?.destroy(); }
    };
  }

  People.paySheetEditor = { mount, mountSlot, sheetRow, kindsFor, ensureStyles, select };
  if (People.slots?.register) People.slots.register('pay_sheets', { kinds:['organization_user', 'resource_group', 'organization_connection'], mount:mountSlot });
})();
