/* portal_scripts/flag_console.js: the feature flag console (docs/architecture/feature-flags.md).
   Ctrl+Shift+F from any /measure/internal page. Stands alone: the editor pages have no Portal object. */
(function(){
  if (window.FlagConsole) return;
  const API = '/v1/internal/flags';
  const HINT = 'Ctrl+Shift+F';
  const TABS = [['flags','Flags'],['org','Organization'],['paste','Paste a list'],['audit','Audit log'],['keys','Agent keys'],['country','Country rules']];
  const S = { tab:'flags', me:null, catalog:null, filter:'', selected:null, coverage:null, percentDraft:null, orgQuery:'', orgResults:null, org:null, orgFilter:'', orgHistory:null, flagHistory:null,
    pasteText:'', resolved:null, picked:{}, pasteFlag:'firstmeasure.exteriors', pasteValue:'on', pasteNote:'', pasteResult:null, audit:null, auditFlag:'', auditOpen:{}, keys:null, newKey:null, country:null, status:'', error:'' };
  let root = null, overlay = null, opened = false, coverageTimer = 0, returnFocus = null;

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
  const num = (value) => Number(value || 0).toLocaleString();
  const pct = (part, whole) => whole ? `${Math.round(part / whole * 1000) / 10}%` : '0%';
  const when = (ms) => ms ? new Date(ms).toLocaleString([], { dateStyle:'medium', timeStyle:'short' }) : '';
  const canWrite = () => S.me?.can_write === true;

  async function call(method, path, body){
    const response = await fetch(API + path, { method, credentials:'same-origin', headers:{ Accept:'application/json', ...(body ? { 'Content-Type':'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { message:text.slice(0, 200) }; }
    if (!response.ok || data.ok === false) throw Object.assign(new Error(data.message || data.error || `Request failed (${response.status})`), { status:response.status });
    return data;
  }
  /** Runs an action, showing its failure in the console's status line. */
  async function act(work, success){
    S.error = ''; S.status = '';
    try { const result = await work(); if (success) S.status = typeof success === 'function' ? success(result) : success; return result; }
    catch (error) { S.error = error.message || 'That did not work.'; return null; }
    finally { render(); }
  }

  const CSS = `
  .ffc-overlay{position:fixed;inset:0;z-index:2147483300;background:rgba(15,23,42,.5);display:flex;align-items:stretch;justify-content:center;padding:24px}
  .ffc-overlay .ffc-root{width:min(1180px,100%);border-radius:10px;box-shadow:0 24px 64px rgba(16,24,40,.35);overflow:auto}
  .ffc-root{container-type:inline-size;background:#f8fafc;color:#101828;font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:left;box-sizing:border-box}
  .ffc-root *{box-sizing:border-box}
  .ffc-head{position:sticky;top:0;z-index:3;background:#fff;border-bottom:1px solid #e4e7ec;padding:14px 18px 0}
  .ffc-title{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .ffc-title h2{margin:0;font-size:18px;line-height:1.2;color:#101828}
  .ffc-sub{color:#667085;font-size:12px}
  .ffc-spacer{flex:1}
  .ffc-kbd{font:11px ui-monospace,Consolas,monospace;border:1px solid #d0d5dd;border-radius:4px;padding:1px 5px;color:#475467;background:#f9fafb}
  .ffc-tabs{display:flex;gap:2px;margin-top:10px;overflow-x:auto}
  .ffc-tab{appearance:none;background:none;border:0;border-bottom:2px solid transparent;padding:8px 12px;font:600 13px system-ui,sans-serif;color:#475467;cursor:pointer;white-space:nowrap}
  .ffc-tab:hover{color:#101828}
  .ffc-tab[aria-selected="true"]{color:#175cd3;border-bottom-color:#175cd3}
  .ffc-body{padding:16px 18px 28px}
  .ffc-btn{appearance:none;font:600 13px system-ui,sans-serif;border:1px solid #d0d5dd;background:#fff;color:#344054;border-radius:7px;padding:7px 12px;cursor:pointer;min-height:34px}
  .ffc-btn:hover:not(:disabled){background:#f2f4f7}
  .ffc-btn:disabled{opacity:.5;cursor:not-allowed}
  .ffc-primary{background:#175cd3;border-color:#175cd3;color:#fff}
  .ffc-primary:hover:not(:disabled){background:#1849a9}
  .ffc-danger{color:#b42318;border-color:#fda29b}
  .ffc-danger:hover:not(:disabled){background:#fef3f2}
  .ffc-link{appearance:none;background:none;border:0;color:#175cd3;font:600 12px system-ui,sans-serif;cursor:pointer;padding:0}
  .ffc-input,.ffc-select,.ffc-text{font:14px system-ui,sans-serif;border:1px solid #d0d5dd;border-radius:7px;padding:7px 10px;background:#fff;color:#101828;min-height:34px;max-width:100%}
  .ffc-text{width:100%;min-height:130px;font:13px ui-monospace,Consolas,monospace;resize:vertical}
  .ffc-input:focus,.ffc-select:focus,.ffc-text:focus,.ffc-btn:focus-visible,.ffc-tab:focus-visible,.ffc-row:focus-visible{outline:2px solid #84adff;outline-offset:1px}
  .ffc-row-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .ffc-note{padding:9px 12px;border-radius:7px;font-size:13px;margin-bottom:12px}
  .ffc-ok{background:#ecfdf3;color:#067647;border:1px solid #abefc6}
  .ffc-bad{background:#fef3f2;color:#b42318;border:1px solid #fecdca}
  .ffc-info{background:#eff8ff;color:#175cd3;border:1px solid #b2ddff}
  .ffc-warn{background:#fffaeb;color:#93370d;border:1px solid #fedf89}
  .ffc-panel{background:#fff;border:1px solid #e4e7ec;border-radius:9px;padding:14px;margin-bottom:14px}
  .ffc-panel h3{margin:0 0 8px;font-size:14px;color:#101828}
  .ffc-layout{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:14px;align-items:start}
  .ffc-layout>.ffc-side{position:sticky;top:112px}
  .ffc-list{background:#fff;border:1px solid #e4e7ec;border-radius:9px;overflow:hidden}
  .ffc-group{padding:7px 12px;background:#f9fafb;border-bottom:1px solid #eaecf0;font:700 11px system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase;color:#667085}
  .ffc-row{display:grid;grid-template-columns:minmax(0,1fr) 150px;gap:12px;padding:9px 12px;border:0;border-bottom:1px solid #f2f4f7;background:#fff;width:100%;text-align:left;font:inherit;color:inherit;cursor:pointer}
  .ffc-row:hover{background:#f9fafb}
  .ffc-row[aria-current="true"]{background:#eff8ff}
  .ffc-row b{font-weight:600;color:#101828}
  .ffc-key{font:11px ui-monospace,Consolas,monospace;color:#667085;word-break:break-all}
  .ffc-count{text-align:right;font-variant-numeric:tabular-nums;font-size:13px}
  .ffc-count b{display:block}
  .ffc-pill{display:inline-block;border-radius:99px;padding:1px 7px;font:600 11px system-ui,sans-serif;background:#f2f4f7;color:#475467;white-space:nowrap}
  .ffc-pill.on{background:#dcfae6;color:#067647}
  .ffc-pill.off{background:#fee4e2;color:#b42318}
  .ffc-pill.pct{background:#d1e9ff;color:#175cd3}
  .ffc-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(92px,1fr));gap:8px;margin:10px 0}
  .ffc-stat{border:1px solid #eaecf0;border-radius:7px;padding:7px 9px}
  .ffc-stat b{display:block;font-size:17px;font-variant-numeric:tabular-nums}
  .ffc-stat span{font-size:11px;color:#667085}
  .ffc-seg{display:inline-flex;border:1px solid #d0d5dd;border-radius:7px;overflow:hidden;flex:none}
  .ffc-seg button{appearance:none;background:#fff;border:0;border-right:1px solid #d0d5dd;padding:5px 11px;font:600 12px system-ui,sans-serif;color:#475467;cursor:pointer;min-height:30px}
  .ffc-seg button:last-child{border-right:0}
  .ffc-seg button:disabled{cursor:not-allowed;opacity:.6}
  .ffc-seg button[aria-pressed="true"][data-v="on"]{background:#067647;color:#fff}
  .ffc-seg button[aria-pressed="true"][data-v="off"]{background:#b42318;color:#fff}
  .ffc-seg button[aria-pressed="true"][data-v="auto"]{background:#475467;color:#fff}
  .ffc-orgflag{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;padding:9px 12px;border-bottom:1px solid #f2f4f7;background:#fff}
  .ffc-why{font-size:12px;color:#475467}
  .ffc-result{display:block;width:100%;appearance:none;background:#fff;border:0;border-bottom:1px solid #f2f4f7;padding:9px 12px;text-align:left;font:inherit;color:inherit;cursor:pointer}
  .ffc-result:hover{background:#f9fafb}
  .ffc-pick{display:flex;gap:8px;align-items:flex-start;padding:7px 12px;border-bottom:1px solid #f2f4f7;font-size:13px}
  .ffc-pick input{margin-top:3px}
  .ffc-entry{padding:8px 12px;border-bottom:1px solid #eaecf0}
  .ffc-field{display:block;font:600 12px system-ui,sans-serif;color:#344054;margin-bottom:4px}
  .ffc-form{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
  .ffc-form>div{min-width:0}
  .ffc-audit{padding:10px 12px;border-bottom:1px solid #f2f4f7;background:#fff}
  .ffc-diff{font:12px ui-monospace,Consolas,monospace;background:#f9fafb;border:1px solid #eaecf0;border-radius:6px;padding:8px;margin-top:6px;white-space:pre-wrap;word-break:break-word}
  .ffc-secret{font:13px ui-monospace,Consolas,monospace;background:#101828;color:#fff;border-radius:7px;padding:10px;word-break:break-all;margin:8px 0}
  .ffc-range{width:100%;accent-color:#175cd3}
  .ffc-empty{padding:26px 14px;text-align:center;color:#667085}
  @container (max-width:820px){
    .ffc-layout{grid-template-columns:minmax(0,1fr)}
    .ffc-layout>.ffc-side{position:static;order:-1}
    .ffc-sub.ffc-hide-small{display:none}
  }
  @container (max-width:520px){
    .ffc-row{grid-template-columns:minmax(0,1fr)}
    .ffc-count{text-align:left}
    .ffc-count b{display:inline;margin-right:6px}
    .ffc-orgflag{grid-template-columns:minmax(0,1fr)}
    .ffc-body{padding:12px 12px 24px}
    .ffc-head{padding:12px 12px 0}
  }
  @media (max-width:640px){.ffc-overlay{padding:0}.ffc-overlay .ffc-root{border-radius:0}}
  `;
  function injectCss(){
    if (document.getElementById('ffcStyles')) return;
    const style = document.createElement('style');
    style.id = 'ffcStyles';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  // ---------------- flags tab ----------------
  function flagRowStatus(flag){
    const pills = [];
    if (flag.rollout?.killed) pills.push('<span class="ffc-pill off">Off for everyone</span>');
    if (flag.rollout?.percent > 0) pills.push(`<span class="ffc-pill pct">${esc(flag.rollout.percent)}%</span>`);
    if (flag.default === true) pills.push('<span class="ffc-pill">Default on</span>');
    if (flag.country_rules) pills.push(`<span class="ffc-pill">${esc(flag.country_rules)} country rule${flag.country_rules === 1 ? '' : 's'}</span>`);
    return pills.join(' ');
  }
  function renderFlags(){
    const catalog = S.catalog;
    if (!catalog) return '<div class="ffc-empty">Counting organizations…</div>';
    const needle = S.filter.trim().toLowerCase();
    const rows = catalog.flags.filter((flag) => !needle || `${flag.key} ${flag.label} ${flag.description}`.toLowerCase().includes(needle));
    const groups = new Map();
    rows.forEach((flag) => { if (!groups.has(flag.group)) groups.set(flag.group, []); groups.get(flag.group).push(flag); });
    const list = [...groups.entries()].map(([group, flags]) => `<div class="ffc-group">${esc(group)}</div>` + flags.map((flag) => `
      <button class="ffc-row" type="button" data-select-flag="${esc(flag.key)}" aria-current="${S.selected === flag.key}">
        <span><b>${esc(flag.label)}</b> ${flagRowStatus(flag)}<br><span class="ffc-key">${esc(flag.key)}</span></span>
        <span class="ffc-count">${flag.stats ? `<b>${num(flag.stats.on)}</b><span class="ffc-sub">${pct(flag.stats.on, catalog.total_orgs)} on</span>` : `<span class="ffc-sub">Setting</span>`}</span>
      </button>`).join('')).join('');
    return `<div class="ffc-row-actions" style="margin-bottom:12px">
        <input class="ffc-input" data-bind="filter" placeholder="Filter ${num(catalog.flags.length)} flags" value="${esc(S.filter)}" aria-label="Filter flags" style="flex:1;min-width:180px">
        <span class="ffc-sub ffc-hide-small">${num(catalog.total_orgs)} organizations · counted ${esc(when(catalog.computed_at))}</span>
        <button class="ffc-btn" type="button" data-action="refresh">Recount</button>
      </div>
      <div class="ffc-layout"><div class="ffc-list">${list || '<div class="ffc-empty">No flag matches that.</div>'}</div><div class="ffc-side">${renderFlagDetail()}</div></div>`;
  }
  function renderFlagDetail(){
    const flag = S.catalog?.flags.find((item) => item.key === S.selected);
    if (!flag) return '<div class="ffc-panel ffc-sub">Choose a flag to see what it does and roll it out.</div>';
    const total = S.catalog.total_orgs;
    const deps = [flag.parent, ...(flag.requires || [])].filter(Boolean);
    if (!flag.stats) return `<div class="ffc-panel"><h3>${esc(flag.label)}</h3><div class="ffc-key">${esc(flag.key)}</div><p>${esc(flag.description)}</p><div class="ffc-sub">A ${esc(flag.type)} setting: it carries a value, not on or off, so it has no counts or percentage here.</div></div>`;
    const draft = S.percentDraft ?? flag.rollout?.percent ?? 0;
    const changed = Number(draft) !== Number(flag.rollout?.percent || 0);
    const history = (S.flagHistory || []).slice(0, 5).map((entry) => `<div class="ffc-why">${esc(when(entry.at))} · ${esc(entry.actor)}<br>${esc(entry.summary)}</div>`).join('<hr style="border:0;border-top:1px solid #f2f4f7;margin:6px 0">');
    return `<div class="ffc-panel">
      <h3>${esc(flag.label)}</h3>
      <div class="ffc-key">${esc(flag.key)}</div>
      <p style="margin:8px 0">${esc(flag.description)}</p>
      ${deps.length ? `<div class="ffc-sub">Needs ${deps.map(esc).join(', ')} on as well.</div>` : ''}
      <div class="ffc-stats">
        <div class="ffc-stat"><b>${num(flag.stats.on)}</b><span>on now of ${num(total)}</span></div>
        <div class="ffc-stat"><b>${num(flag.stats.explicit_on)}</b><span>set on</span></div>
        <div class="ffc-stat"><b>${num(flag.stats.explicit_off)}</b><span>set off</span></div>
        <div class="ffc-stat"><b>${num(flag.stats.percent_added)}</b><span>on by percentage</span></div>
      </div>
      ${flag.percentage_allowed ? `
      <label class="ffc-field" for="ffcPercent">Percentage of organizations</label>
      <div class="ffc-row-actions">
        <input id="ffcPercent" class="ffc-input" type="number" min="0" max="100" step="0.01" value="${esc(draft)}" data-percent style="width:96px" ${canWrite() ? '' : 'disabled'}>
        <input class="ffc-range" type="range" min="0" max="100" step="1" value="${esc(draft)}" data-percent aria-label="Percentage slider" style="flex:1;min-width:120px" ${canWrite() ? '' : 'disabled'}>
      </div>
      <div class="ffc-sub" style="margin:6px 0 10px" id="ffcCoverage">${S.coverage && Number(S.coverage.percent) === Number(draft) ? `Covers ${num(S.coverage.covered)} of ${num(S.coverage.total_orgs)} organizations, before explicit values. Raising it later keeps everyone it covers now.` : 'Raising a percentage later keeps everyone it covers now.'}</div>
      <div class="ffc-row-actions"><button class="ffc-btn ffc-primary" type="button" data-action="save-percent" ${changed && canWrite() ? '' : 'disabled'}>Save percentage</button></div>`
      : '<div class="ffc-note ffc-info">This one is set per organization, never by percentage.</div>'}
      <hr style="border:0;border-top:1px solid #eaecf0;margin:14px 0">
      <div class="ffc-row-actions">
        ${flag.rollout?.killed
          ? `<button class="ffc-btn" type="button" data-action="unkill" ${canWrite() ? '' : 'disabled'}>Restore this flag</button><span class="ffc-pill off">Off for everyone</span>`
          : `<button class="ffc-btn ffc-danger" type="button" data-action="kill" ${canWrite() ? '' : 'disabled'}>Turn off for everyone</button>`}
        <button class="ffc-btn" type="button" data-action="paste-for-flag">Paste a list…</button>
      </div>
      <div class="ffc-sub" style="margin-top:6px">Every process picks up a change within 15 seconds.</div>
      ${history ? `<hr style="border:0;border-top:1px solid #eaecf0;margin:14px 0"><h3>Recent changes</h3>${history}` : ''}
    </div>`;
  }

  // ---------------- organization tab ----------------
  const SOURCE = { off_everywhere:'Off for everyone', explicit:'Set for this organization', stored_on:'Stored on', percentage:'On by percentage', stored_off:'Stored off', default:'Default' };
  function renderOrg(){
    const results = S.orgResults;
    const search = `<form class="ffc-row-actions" data-form="org-search" style="margin-bottom:12px">
      <input class="ffc-input" data-bind="orgQuery" placeholder="Name, organization id or anyone's email" value="${esc(S.orgQuery)}" aria-label="Find an organization" style="flex:1;min-width:200px">
      <button class="ffc-btn ffc-primary" type="submit">Find</button></form>`;
    const list = results ? `<div class="ffc-list" style="margin-bottom:14px">${results.length ? results.map((org) => `<button class="ffc-result" type="button" data-open-org="${esc(org.id)}"><b>${esc(org.name)}</b> ${org.status !== 'active' ? `<span class="ffc-pill">${esc(org.status)}</span>` : ''}<br><span class="ffc-key">${esc(org.id)}${org.owner_email ? ` · ${esc(org.owner_email)}` : ''}</span></button>`).join('') : '<div class="ffc-empty">No organization matches that.</div>'}</div>` : '';
    return search + (S.org ? renderOrgDetail() : list);
  }
  function renderOrgDetail(){
    const { organization: org, flags } = S.org;
    const needle = S.orgFilter.trim().toLowerCase();
    const rows = flags.filter((flag) => !needle || `${flag.key} ${flag.label}`.toLowerCase().includes(needle));
    const body = rows.map((flag) => {
      if (flag.type !== 'boolean') return `<div class="ffc-orgflag"><span><b>${esc(flag.label)}</b><br><span class="ffc-key">${esc(flag.key)}</span></span><span class="ffc-sub">${esc(String(flag.value ?? ''))}</span></div>`;
      const selected = flag.explicit === true ? 'on' : flag.explicit === false ? 'off' : 'auto';
      const why = [SOURCE[flag.source] || flag.source];
      if (flag.rollout?.percent > 0) why.push(`rollout ${flag.rollout.percent}%, this organization is at ${flag.bucket}`);
      if (!flag.effective && flag.reason && String(flag.reason).startsWith('requires')) why.push(flag.reason);
      if (flag.country_rules) why.push('a country rule may apply');
      const seg = [['on','On'],['auto','Auto'],['off','Off']].map(([value, label]) => `<button type="button" data-v="${value}" data-set-org-flag="${esc(flag.key)}" aria-pressed="${selected === value}" ${canWrite() ? '' : 'disabled'}>${label}</button>`).join('');
      return `<div class="ffc-orgflag"><span><b>${esc(flag.label)}</b> <span class="ffc-pill ${flag.effective ? 'on' : ''}">${flag.effective ? 'On' : 'Off'}</span><br><span class="ffc-key">${esc(flag.key)}</span><br><span class="ffc-why">${esc(why.join(' · '))}</span></span><span class="ffc-seg" role="group" aria-label="${esc(flag.label)}">${seg}</span></div>`;
    }).join('');
    const history = (S.orgHistory || []).slice(0, 8).map((entry) => `<div class="ffc-why">${esc(when(entry.at))} · ${esc(entry.actor)} · ${esc(entry.summary)}${entry.note ? ` (${esc(entry.note)})` : ''}</div>`).join('');
    return `<div class="ffc-panel">
      <div class="ffc-row-actions"><div style="flex:1;min-width:0"><h3 style="margin:0">${esc(org.name)}</h3><div class="ffc-key">${esc(org.id)}${org.owner_email ? ` · ${esc(org.owner_email)}` : ''}</div></div>
      <button class="ffc-btn" type="button" data-action="org-back">Back to results</button></div>
      <p class="ffc-sub" style="margin:8px 0 0">Auto follows the default and any percentage. On and Off are explicit and beat a percentage.</p>
      ${history ? `<details style="margin-top:8px"><summary class="ffc-sub" style="cursor:pointer">Changes to this organization</summary>${history}</details>` : ''}
    </div>
    <input class="ffc-input" data-bind="orgFilter" placeholder="Filter this organization's flags" value="${esc(S.orgFilter)}" aria-label="Filter flags" style="width:100%;margin-bottom:10px">
    <div class="ffc-list">${body || '<div class="ffc-empty">No flag matches that.</div>'}</div>`;
  }

  // ---------------- paste tab ----------------
  const pickedIds = () => Object.keys(S.picked).filter((id) => S.picked[id]);
  function renderPaste(){
    const flags = (S.catalog?.flags || []).filter((flag) => flag.type === 'boolean');
    const resolved = S.resolved;
    const orgLine = (org) => `<b>${esc(org.name)}</b> <span class="ffc-key">${esc(org.id)}${org.owner_email ? ` · ${esc(org.owner_email)}` : ''}</span>`;
    const pick = (org) => `<label class="ffc-pick"><input type="checkbox" data-pick="${esc(org.id)}" ${S.picked[org.id] ? 'checked' : ''}><span>${orgLine(org)}</span></label>`;
    const preview = resolved ? `
      <div class="ffc-stats">
        <div class="ffc-stat"><b>${num(resolved.matched)}</b><span>matched</span></div>
        <div class="ffc-stat"><b>${num(resolved.ambiguous)}</b><span>need choosing</span></div>
        <div class="ffc-stat"><b>${num(resolved.unmatched)}</b><span>not found</span></div>
      </div>
      ${resolved.ambiguous ? `<div class="ffc-list" style="margin-bottom:12px"><div class="ffc-group">Need choosing: tick the ones you mean</div>${resolved.entries.filter((row) => row.status === 'ambiguous').map((row) => `<div class="ffc-entry"><span class="ffc-sub">“${esc(row.input)}” (${esc(row.matched_by)})</span></div>${row.organizations.map(pick).join('')}`).join('')}</div>` : ''}
      ${resolved.matched ? `<div class="ffc-list" style="margin-bottom:12px"><div class="ffc-group">Matched</div>${resolved.entries.filter((row) => row.status === 'matched').map((row) => `<label class="ffc-pick"><input type="checkbox" data-pick="${esc(row.organizations[0].id)}" ${S.picked[row.organizations[0].id] ? 'checked' : ''}><span>${orgLine(row.organizations[0])}<br><span class="ffc-sub">from “${esc(row.input)}” by ${esc(row.matched_by)}</span></span></label>`).join('')}</div>` : ''}
      ${resolved.unmatched ? `<div class="ffc-note ffc-warn"><b>Not found:</b> ${resolved.entries.filter((row) => row.status === 'unmatched').map((row) => esc(row.input)).join(', ')}</div>` : ''}
      <div class="ffc-panel"><h3>Apply to ${num(pickedIds().length)} organization${pickedIds().length === 1 ? '' : 's'}</h3>
        <div class="ffc-form">
          <div style="flex:1;min-width:220px"><label class="ffc-field" for="ffcPasteFlag">Flag</label><select id="ffcPasteFlag" class="ffc-select" data-bind="pasteFlag" style="width:100%">${flags.map((flag) => `<option value="${esc(flag.key)}" ${flag.key === S.pasteFlag ? 'selected' : ''}>${esc(flag.label)} (${esc(flag.key)})</option>`).join('')}</select></div>
          <div><span class="ffc-field">Turn</span><span class="ffc-seg" role="group" aria-label="Value">${[['on','On'],['off','Off'],['auto','Auto']].map(([value, label]) => `<button type="button" data-v="${value}" data-paste-value="${value}" aria-pressed="${S.pasteValue === value}">${label}</button>`).join('')}</span></div>
          <div style="flex:1;min-width:200px"><label class="ffc-field" for="ffcPasteNote">Why (kept in the audit log)</label><input id="ffcPasteNote" class="ffc-input" data-bind="pasteNote" value="${esc(S.pasteNote)}" style="width:100%"></div>
          <button class="ffc-btn ffc-primary" type="button" data-action="apply-bulk" ${pickedIds().length && canWrite() ? '' : 'disabled'}>Apply</button>
        </div>
      </div>` : '';
    const result = S.pasteResult ? `<div class="ffc-note ${S.pasteResult.failed.length ? 'ffc-warn' : 'ffc-ok'}">${num(S.pasteResult.changed)} changed, ${num(S.pasteResult.unchanged)} already that way${S.pasteResult.failed.length ? `, ${num(S.pasteResult.failed.length)} failed: ${S.pasteResult.failed.slice(0, 5).map((row) => esc(row.org_id)).join(', ')}` : ''}.</div>` : '';
    return `${result}<div class="ffc-panel"><label class="ffc-field" for="ffcPaste">Organization ids, names or emails, mixed, one per line or comma separated</label>
      <textarea id="ffcPaste" class="ffc-text" data-bind="pasteText" spellcheck="false" placeholder="org_abc123&#10;owner@example.com&#10;Acme Roofing, LLC">${esc(S.pasteText)}</textarea>
      <div class="ffc-row-actions" style="margin-top:8px"><button class="ffc-btn" type="button" data-action="resolve" ${S.pasteText.trim() ? '' : 'disabled'}>Preview matches</button><span class="ffc-sub">Nothing changes until you press Apply.</span></div>
    </div>${preview}`;
  }

  // ---------------- audit tab ----------------
  function renderAudit(){
    const flags = (S.catalog?.flags || []).filter((flag) => flag.type === 'boolean');
    const rows = (S.audit || []).map((entry) => {
      const open = S.auditOpen[entry.id];
      const detail = open ? `<div class="ffc-diff">${entry.note ? `Why: ${esc(entry.note)}\n` : ''}${entry.before !== null ? `Before: ${esc(JSON.stringify(entry.before))}\n` : ''}${entry.after !== null ? `After:  ${esc(JSON.stringify(entry.after))}\n` : ''}${(open.orgs || []).slice(0, 200).map((org) => `${esc(org.org_name || org.org_id)} (${esc(org.org_id)}): ${esc(JSON.stringify(org.before))} → ${esc(JSON.stringify(org.after))}`).join('\n')}${(open.orgs || []).length > 200 ? `\n… ${(open.orgs.length - 200).toLocaleString()} more` : ''}</div>` : '';
      return `<div class="ffc-audit"><div class="ffc-row-actions"><span style="flex:1;min-width:0"><b>${esc(entry.summary)}</b><br><span class="ffc-why">${esc(when(entry.at))} · ${esc(entry.actor)}</span></span><button class="ffc-link" type="button" data-audit-open="${esc(entry.id)}">${open ? 'Hide' : 'Details'}</button></div>${detail}</div>`;
    }).join('');
    return `<div class="ffc-row-actions" style="margin-bottom:12px"><select class="ffc-select" data-bind="auditFlag" aria-label="Filter by flag" style="flex:1;min-width:180px;max-width:420px"><option value="">Every flag</option>${flags.map((flag) => `<option value="${esc(flag.key)}" ${flag.key === S.auditFlag ? 'selected' : ''}>${esc(flag.label)}</option>`).join('')}</select></div>
      <div class="ffc-list">${S.audit ? (rows || '<div class="ffc-empty">No changes recorded yet.</div>') : '<div class="ffc-empty">Loading…</div>'}</div>
      ${S.audit?.length >= 50 ? '<div style="margin-top:10px"><button class="ffc-btn" type="button" data-action="audit-more">Older</button></div>' : ''}`;
  }

  // ---------------- keys tab ----------------
  function renderKeys(){
    if (!S.me?.can_manage_keys) return '<div class="ffc-note ffc-info">Only a platform administrator can create or revoke agent keys.</div>';
    const created = S.newKey ? `<div class="ffc-note ffc-ok"><b>Copy this now. It will not be shown again.</b><div class="ffc-secret">${esc(S.newKey.key)}</div>Save it in <code>~/.config/firstmate/feature-flags-key</code> on the agent's machine, then use <code>node tools/feature-flags/cli.mjs</code>. Docs: docs/architecture/feature-flags.md.</div>` : '';
    const rows = (S.keys || []).map((key) => `<div class="ffc-audit"><div class="ffc-row-actions"><span style="flex:1;min-width:0"><b>${esc(key.name)}</b> <span class="ffc-pill ${key.active ? (key.scope === 'write' ? 'pct' : 'on') : 'off'}">${key.active ? esc(key.scope) : key.revoked_at ? 'revoked' : 'expired'}</span><br><span class="ffc-why">${esc(key.prefix)}… · by ${esc(key.created_by)} · expires ${esc(when(key.expires_at))}${key.last_used_at ? ` · last used ${esc(when(key.last_used_at))}` : ''}</span></span>${key.active ? `<button class="ffc-btn ffc-danger" type="button" data-revoke-key="${esc(key.id)}">Revoke</button>` : ''}</div></div>`).join('');
    return `${created}<form class="ffc-panel" data-form="new-key"><h3>New key for a team agent</h3><div class="ffc-form">
        <div style="flex:1;min-width:200px"><label class="ffc-field" for="ffcKeyName">Who it is for</label><input id="ffcKeyName" class="ffc-input" name="name" required maxlength="120" placeholder="Jack's Claude Code" style="width:100%"></div>
        <div><label class="ffc-field" for="ffcKeyScope">Can</label><select id="ffcKeyScope" class="ffc-select" name="scope"><option value="read">Read flags</option><option value="write">Read and change flags</option></select></div>
        <div><label class="ffc-field" for="ffcKeyDays">Days</label><input id="ffcKeyDays" class="ffc-input" name="days" type="number" min="1" max="365" value="90" style="width:84px"></div>
        <button class="ffc-btn ffc-primary" type="submit">Create key</button></div></form>
      <div class="ffc-list">${S.keys ? (rows || '<div class="ffc-empty">No keys yet.</div>') : '<div class="ffc-empty">Loading…</div>'}</div>`;
  }

  // ---------------- country rules tab ----------------
  function renderCountry(){
    return `<div class="ffc-panel"><p class="ffc-sub" style="margin:0 0 8px">Set flags for every organization whose country of record is in the list. A rule beats a percentage and the stored value; an explicit per-organization value beats a rule. Later rules beat earlier ones.</p>
      <textarea class="ffc-text" data-bind="country" spellcheck="false" aria-label="Country rules" style="min-height:220px" placeholder='[{"countries":["FR","DE"],"values":{"firstmeasure.example_flag":true},"note":"Europe pilot"}]'>${esc(S.country ?? '')}</textarea>
      <div class="ffc-row-actions" style="margin-top:8px"><button class="ffc-btn ffc-primary" type="button" data-action="save-country" ${S.country !== null && canWrite() ? '' : 'disabled'}>Save country rules</button></div></div>`;
  }

  // ---------------- shell ----------------
  function render(){
    if (!root) return;
    const scrollTop = root.scrollTop, active = document.activeElement;
    const focusBind = active?.dataset?.bind, start = active?.selectionStart, end = active?.selectionEnd, focusId = active?.id;
    if (S.me === false) {
      root.innerHTML = `<div class="ffc-head"><div class="ffc-title"><h2>Feature flags</h2><span class="ffc-spacer"></span>${overlay ? '<button class="ffc-btn" type="button" data-action="close">Close</button>' : ''}</div><div style="height:12px"></div></div><div class="ffc-body"><div class="ffc-note ffc-bad">${esc(S.error || 'Only platform administrators can use the feature flag console.')}</div></div>`;
      return;
    }
    const body = { flags:renderFlags, org:renderOrg, paste:renderPaste, audit:renderAudit, keys:renderKeys, country:renderCountry }[S.tab]();
    root.innerHTML = `<div class="ffc-head">
        <div class="ffc-title"><h2>Feature flags</h2><span class="ffc-sub ffc-hide-small">${S.me ? esc(S.me.actor) : ''}${S.me && !S.me.can_write ? ' · read only' : ''}</span><span class="ffc-spacer"></span><span class="ffc-kbd ffc-hide-small">${HINT}</span>${overlay ? '<button class="ffc-btn" type="button" data-action="close">Close</button>' : ''}</div>
        <div class="ffc-tabs" role="tablist">${TABS.map(([id, label]) => `<button class="ffc-tab" type="button" role="tab" aria-selected="${S.tab === id}" data-tab="${id}">${label}</button>`).join('')}</div>
      </div>
      <div class="ffc-body">
        ${S.error ? `<div class="ffc-note ffc-bad" role="alert">${esc(S.error)}</div>` : ''}${S.status ? `<div class="ffc-note ffc-ok" role="status">${esc(S.status)}</div>` : ''}
        ${body}
      </div>`;
    root.scrollTop = scrollTop;
    const refocus = focusBind ? root.querySelector(`[data-bind="${focusBind}"]`) : focusId ? root.querySelector(`#${CSS_ESCAPE(focusId)}`) : null;
    if (refocus) { refocus.focus(); try { if (start != null) refocus.setSelectionRange(start, end); } catch {} }
  }
  const CSS_ESCAPE = (value) => (window.CSS?.escape ? window.CSS.escape(value) : value);

  // Lists that fill in as the page is used.
  async function loadCatalog(fresh){
    const data = await call('GET', `/catalog${fresh ? '?fresh=1' : ''}`);
    S.catalog = data;
  }
  async function loadTab(){
    if (S.tab === 'audit' && !S.audit) await act(async () => { S.audit = (await call('GET', `/audit?limit=50${S.auditFlag ? `&flag=${encodeURIComponent(S.auditFlag)}` : ''}`)).entries; });
    if (S.tab === 'keys' && S.me?.can_manage_keys && !S.keys) await act(async () => { S.keys = (await call('GET', '/keys')).keys; });
    if (S.tab === 'country' && S.country === null) {
      await act(async () => {
        const response = await fetch('/v1/internal/admin/capability-country-rules', { credentials:'same-origin', headers:{ Accept:'application/json' } });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Could not read the country rules.');
        S.country = JSON.stringify(data.rules || [], null, 2);
      });
    }
  }
  async function selectFlag(key){
    S.selected = key; S.percentDraft = null; S.coverage = null; S.flagHistory = null; render();
    const history = await call('GET', `/audit?flag=${encodeURIComponent(key)}&limit=5`).catch(() => null);
    if (S.selected === key) { S.flagHistory = history?.entries || []; render(); }
  }
  function scheduleCoverage(key, percent){
    clearTimeout(coverageTimer);
    coverageTimer = setTimeout(async () => {
      const data = await call('GET', `/catalog/${encodeURIComponent(key)}/coverage?percent=${percent}`).catch(() => null);
      if (data && S.selected === key && Number(S.percentDraft) === Number(percent)) { S.coverage = data; render(); }
    }, 220);
  }
  async function openOrg(id){
    await act(async () => { S.org = await call('GET', `/orgs/${encodeURIComponent(id)}`); S.orgFilter = ''; S.orgHistory = (await call('GET', `/audit?org=${encodeURIComponent(id)}&limit=8`)).entries; });
  }

  async function onClick(event){
    const el = event.target.closest('button,[data-tab]');
    if (!el || !root.contains(el)) return;
    const flagKey = el.dataset.selectFlag, orgId = el.dataset.openOrg;
    if (el.dataset.tab) { S.tab = el.dataset.tab; S.error = ''; S.status = ''; render(); return void loadTab(); }
    if (flagKey) return void selectFlag(flagKey);
    if (orgId) return void openOrg(orgId);
    if (el.dataset.setOrgFlag) {
      const value = { on:true, off:false, auto:null }[el.dataset.v];
      const org = S.org.organization;
      await act(async () => { await call('PUT', `/orgs/${encodeURIComponent(org.id)}/flags/${encodeURIComponent(el.dataset.setOrgFlag)}`, { value }); S.org = await call('GET', `/orgs/${encodeURIComponent(org.id)}`); S.orgHistory = (await call('GET', `/audit?org=${encodeURIComponent(org.id)}&limit=8`)).entries; S.audit = null; await loadCatalog(); }, 'Saved. Live within 15 seconds.');
      return;
    }
    if (el.dataset.pasteValue) { S.pasteValue = el.dataset.pasteValue; return render(); }
    if (el.dataset.auditOpen) {
      const id = el.dataset.auditOpen;
      if (S.auditOpen[id]) { delete S.auditOpen[id]; return render(); }
      await act(async () => { S.auditOpen[id] = (await call('GET', `/audit/${encodeURIComponent(id)}`)).entry; });
      return;
    }
    if (el.dataset.revokeKey) {
      if (!window.confirm('Revoke this key? The agent using it stops working at once.')) return;
      await act(async () => { await call('DELETE', `/keys/${encodeURIComponent(el.dataset.revokeKey)}`); S.keys = (await call('GET', '/keys')).keys; S.audit = null; }, 'Key revoked.');
      return;
    }
    const flag = S.catalog?.flags.find((item) => item.key === S.selected);
    switch (el.dataset.action) {
      case 'close': return close();
      case 'refresh': return void act(() => loadCatalog(true));
      case 'org-back': S.org = null; return render();
      case 'save-percent': {
        const percent = Number(S.percentDraft ?? flag.rollout?.percent ?? 0);
        const before = Number(flag.rollout?.percent || 0);
        if (percent < before && !window.confirm(`Lower ${flag.label} from ${before}% to ${percent}%? Organizations above ${percent}% lose it unless set explicitly.`)) return;
        await act(async () => { const result = await call('PUT', `/catalog/${encodeURIComponent(flag.key)}/rollout`, { percent }); S.percentDraft = null; S.coverage = result.coverage; S.audit = null; await loadCatalog(); S.flagHistory = (await call('GET', `/audit?flag=${encodeURIComponent(flag.key)}&limit=5`)).entries; return result; }, (result) => `${flag.label} is at ${percent}%, covering ${num(result.coverage.covered)} of ${num(result.coverage.total_orgs)} organizations. Live within 15 seconds.${result.warnings?.length ? ` ${result.warnings.join(' ')}` : ''}`);
        return;
      }
      case 'kill':
        if (!window.confirm(`Turn ${flag.label} off for every organization? This beats every percentage and explicit value until you restore it.`)) return;
        // falls through
      case 'unkill':
        await act(async () => { await call('PUT', `/catalog/${encodeURIComponent(flag.key)}/rollout`, { killed: el.dataset.action === 'kill' }); S.audit = null; await loadCatalog(); S.flagHistory = (await call('GET', `/audit?flag=${encodeURIComponent(flag.key)}&limit=5`)).entries; }, el.dataset.action === 'kill' ? 'Off for everyone within 15 seconds.' : 'Restored within 15 seconds.');
        return;
      case 'paste-for-flag': S.pasteFlag = flag.key; S.tab = 'paste'; return render();
      case 'resolve':
        await act(async () => {
          S.resolved = await call('POST', '/resolve', { text:S.pasteText });
          S.pasteResult = null; S.picked = {};
          S.resolved.entries.filter((row) => row.status === 'matched').forEach((row) => { S.picked[row.organizations[0].id] = true; });
        });
        return;
      case 'apply-bulk': {
        const ids = pickedIds();
        const word = { on:'on', off:'off', auto:'back to automatic' }[S.pasteValue];
        if (!window.confirm(`Turn ${S.pasteFlag} ${word} for ${ids.length} organization${ids.length === 1 ? '' : 's'}?`)) return;
        await act(async () => { S.pasteResult = await call('POST', '/bulk', { flag:S.pasteFlag, value:{ on:true, off:false, auto:null }[S.pasteValue], org_ids:ids, ...(S.pasteNote.trim() ? { note:S.pasteNote.trim() } : {}) }); S.audit = null; await loadCatalog(); });
        return;
      }
      case 'audit-more': {
        const before = S.audit[S.audit.length - 1]?.at;
        await act(async () => { S.audit = S.audit.concat((await call('GET', `/audit?limit=50&before=${before}${S.auditFlag ? `&flag=${encodeURIComponent(S.auditFlag)}` : ''}`)).entries); });
        return;
      }
      case 'save-country': {
        let rules;
        try { rules = JSON.parse(S.country || '[]'); } catch { S.error = 'Country rules must be valid JSON.'; S.status = ''; return render(); }
        await act(async () => {
          const response = await fetch('/v1/internal/admin/capability-country-rules', { method:'PUT', credentials:'same-origin', headers:{ Accept:'application/json', 'Content-Type':'application/json' }, body:JSON.stringify({ rules }) });
          const data = await response.json();
          if (!response.ok) throw new Error(data.message || 'Could not save the country rules.');
          S.country = JSON.stringify(data.rules || [], null, 2); S.audit = null;
        }, 'Country rules saved. Live within 15 seconds.');
        return;
      }
    }
  }
  function onInput(event){
    const el = event.target;
    if (el.dataset.bind) {
      S[el.dataset.bind] = el.value;
      // Typing fields keep focus and caret; only the filters redraw what they filter.
      if (el.dataset.bind === 'filter' || el.dataset.bind === 'orgFilter' || el.dataset.bind === 'pasteText') render();
      if (el.dataset.bind === 'auditFlag') { S.audit = null; S.auditOpen = {}; render(); loadTab(); }
      return;
    }
    if (el.dataset.percent !== undefined) {
      S.percentDraft = Math.max(0, Math.min(100, Number(el.value) || 0));
      S.coverage = null;
      root.querySelectorAll('[data-percent]').forEach((input) => { if (input !== el) input.value = S.percentDraft; });
      const save = root.querySelector('[data-action="save-percent"]');
      const flag = S.catalog?.flags.find((item) => item.key === S.selected);
      if (save) save.disabled = !canWrite() || Number(S.percentDraft) === Number(flag?.rollout?.percent || 0);
      scheduleCoverage(S.selected, S.percentDraft);
      return;
    }
    if (el.dataset.pick) { S.picked[el.dataset.pick] = el.checked; render(); }
  }
  async function onSubmit(event){
    const form = event.target;
    if (form.dataset.form === 'org-search') {
      event.preventDefault();
      if (!S.orgQuery.trim()) return;
      S.org = null;
      await act(async () => {
        const { organizations } = await call('GET', `/orgs?q=${encodeURIComponent(S.orgQuery.trim())}`);
        S.orgResults = organizations;
        if (organizations.length === 1) { S.org = await call('GET', `/orgs/${encodeURIComponent(organizations[0].id)}`); S.orgFilter = ''; S.orgHistory = (await call('GET', `/audit?org=${encodeURIComponent(organizations[0].id)}&limit=8`)).entries; }
      });
    }
    if (form.dataset.form === 'new-key') {
      event.preventDefault();
      const fields = new FormData(form);
      await act(async () => {
        S.newKey = await call('POST', '/keys', { name:String(fields.get('name') || ''), scope:String(fields.get('scope') || 'read'), days:Number(fields.get('days')) || 90 });
        S.keys = (await call('GET', '/keys')).keys; S.audit = null;
      });
    }
  }
  function ensureRoot(){
    injectCss();
    if (root) return root;
    root = document.createElement('div');
    root.className = 'ffc-root';
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    root.addEventListener('submit', onSubmit);
    return root;
  }
  async function load(){
    if (S.me && S.catalog) return render();
    render();
    try {
      S.me = await call('GET', '/me');
      S.error = '';
      render();
      await loadCatalog();
      S.error = '';
    } catch (error) {
      if (error.status === 401 || error.status === 403) { S.me = false; S.error = error.status === 401 ? 'Sign in with your platform administrator account to use the feature flag console.' : 'Only platform administrators can use the feature flag console.'; }
      else S.error = error.message || 'Could not load the flags.';
    }
    render();
    if (S.me) loadTab();
  }
  function close(){
    if (!overlay) return;
    overlay.remove();
    overlay = null; opened = false;
    root?.remove();
    document.documentElement.style.overflow = '';
    if (returnFocus?.isConnected) returnFocus.focus();
  }
  function openOverlay(){
    if (opened) return close();
    opened = true;
    returnFocus = document.activeElement;
    ensureRoot();
    overlay = document.createElement('div');
    overlay.className = 'ffc-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Feature flags');
    overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) close(); });
    overlay.appendChild(root);
    document.body.appendChild(overlay);
    document.documentElement.style.overflow = 'hidden';
    root.tabIndex = -1;
    root.focus();
    load();
  }
  // Capture on window, so a page's own keyboard handling (the editor's tools) never sees these while the console is up.
  window.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.code === 'KeyF') {
      event.preventDefault();
      event.stopImmediatePropagation();
      openOverlay();
      return;
    }
    if (!overlay) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); return; }
    event.stopImmediatePropagation();
  }, true);
  ['keyup', 'keypress'].forEach((type) => window.addEventListener(type, (event) => { if (overlay) event.stopImmediatePropagation(); }, true));

  /** The sidebar's Feature Flags view on the staff portal: the same console, in the page. */
  function mountInPortal(){
    const Portal = window.Portal;
    if (!Portal?.registerPlugin) return;
    const cfg = Portal.cfg || {}, user = cfg.user || {}, perms = cfg.perms || {};
    if (!(user.role === 'admin' || user.is_admin || perms.platform_admin || perms.manage_users || perms.manage_sales_users)) return;
    const host = document.getElementById('portalPluginViews');
    if (!host || document.getElementById('view-feature-flags')) return;
    const view = document.createElement('div');
    view.id = 'view-feature-flags';
    view.style.display = 'none';
    host.appendChild(view);
    Portal.registerPlugin({ id:'feature-flags', title:'Feature Flags', iconClass:'fas fa-flask' });
    const original = Portal.switchView.bind(Portal);
    Portal.switchView = async function(id, btn){
      const result = await original(id, btn);
      if (id === 'feature-flags') { close(); view.appendChild(ensureRoot()); load(); }
      return result;
    };
  }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', mountInPortal) : mountInPortal();

  window.FlagConsole = { open: () => { if (!opened) openOverlay(); }, close };
})();
