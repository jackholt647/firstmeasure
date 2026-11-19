// The equipment setup's own pages (guided experience `equipment.setup`, GP-15, docs/architecture/guided-experiences.md).
// It plays the first time someone opens the Equipment tab (a skip only puts it off) and from Operations' Equipment card,
// after the setup steps it requires (what kind of company, how many locations), each asked only while unanswered.
// One step that keeps its own pages:
//   locations  where the equipment is kept: one facility per location the company works out of (named here; the
//              address is added later in Equipment › Facilities). Facilities the fleet already has come back as they are.
//   equipment  what kinds of equipment it uses, from the list in the step's options (library data), suggested by the
//              kind of company: dump trucks, trailers, its own or rented dumpsters, porta potties… and its own.
//   units      how many of each it has at each location (a rented kind has none to count).
//   done       "We've set up your equipment", after equipment.setup.apply has written them; Done finishes the setup.
// Everything it shows is read through the publication layer (company-profile.profile, equipment-setup.status). The
// write is the published action, run as the person with a key of its own each time.
const array = (value) => Array.isArray(value) ? value : [];
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const clean = (value) => String(value ?? '').trim();
const slug = (value) => clean(value).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50);
const MAX_UNITS = 50, MAX_LOCATIONS = 20;

const css = `
.gxe{display:flex;flex-direction:column;gap:16px;min-width:0;padding:2px 0 8px;color:#101828}
.gxe p{margin:0;color:#475467;line-height:1.5}
.gxe-rows{display:flex;flex-direction:column;gap:8px}
.gxe-loc{display:flex;align-items:center;gap:10px}
.gxe-loc .gxe-icon{width:36px;height:36px;font-size:15px}
.gxe-input{flex:1 1 auto;min-width:0;height:42px;border:1px solid #d0d5dd;border-radius:11px;background:#fff;padding:0 12px;font:inherit;font-size:14px;color:#101828;outline:none;transition:border-color .15s,box-shadow .15s}
.gxe-input:focus{border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.14)}
.gxe-remove{flex:none;width:34px;height:34px;border:0;border-radius:9px;background:transparent;color:#98a2b3;font-size:15px;cursor:pointer}
.gxe-remove:hover{background:#f2f4f7;color:#475467}
.gxe-link{align-self:flex-start;display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 12px;border:1px dashed #d0d5dd;border-radius:10px;background:#fff;font:inherit;font-size:13px;font-weight:650;color:#344054;cursor:pointer}
.gxe-link:hover{background:#f9fafb}
.gxe-group{display:flex;flex-direction:column;gap:8px}
.gxe-group h3{margin:0;font-size:11.5px;font-weight:750;letter-spacing:.06em;text-transform:uppercase;color:#667085}
.gxe-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
.gxe-tile{position:relative;display:flex;align-items:flex-start;gap:12px;min-height:68px;padding:12px 40px 12px 12px;border:1px solid #e4e7ec;border-radius:13px;background:#fff;font:inherit;text-align:left;color:#101828;cursor:pointer;transition:border-color .15s,background .15s,box-shadow .2s,transform .15s}
.gxe-tile:hover{border-color:#c4c9d2;transform:translateY(-1px)}
.gxe-tile:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
.gxe-tile span{display:flex;flex-direction:column;gap:2px;min-width:0}
.gxe-tile strong{font-size:14px;font-weight:700;line-height:1.25}
.gxe-tile small{font-size:12px;color:#667085;line-height:1.35}
.gxe-tile[aria-pressed=true]{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.05);box-shadow:0 0 0 1px var(--primary,#d93025)}
.gxe-tick{position:absolute;top:10px;right:10px;width:22px;height:22px;border-radius:50%;border:1.5px solid #d0d5dd;display:grid;place-items:center;transition:background .15s,border-color .15s}
.gxe-tick svg{width:12px;height:12px;stroke:#fff;fill:none;stroke-width:3;opacity:0;transition:opacity .15s}
[aria-pressed=true]>.gxe-tick{background:var(--primary,#d93025);border-color:var(--primary,#d93025)}
[aria-pressed=true]>.gxe-tick svg{opacity:1}
.gxe-icon{flex:none;width:40px;height:40px;border-radius:12px;display:grid;place-items:center;background:rgba(var(--primary-rgb,217,48,37),.08);color:var(--primary,#d93025);font-size:17px}
.gxe-own{display:flex;gap:8px}
.gxe-table{display:flex;flex-direction:column;border:1px solid #eaecf0;border-radius:13px;background:#fff;overflow:hidden}
.gxe-trow{display:grid;grid-template-columns:minmax(0,1fr) repeat(var(--cols,1),minmax(92px,120px));align-items:center;gap:10px;padding:10px 14px;border-top:1px solid #f2f4f7}
.gxe-trow:first-child{border-top:0}
.gxe-trow.head{padding-top:8px;padding-bottom:8px;background:#f9fafb;font-size:11.5px;font-weight:700;color:#667085}
.gxe-trow.head span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gxe-name{display:flex;align-items:center;gap:10px;min-width:0}
.gxe-name .gxe-icon{width:32px;height:32px;font-size:14px;border-radius:10px}
.gxe-name strong{font-size:14px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gxe-name small{display:block;font-size:12px;color:#667085;font-weight:500}
.gxe-step{display:inline-flex;align-items:center;justify-self:start;height:34px;border:1px solid #d0d5dd;border-radius:10px;background:#fff;overflow:hidden}
.gxe-step button{width:30px;height:100%;border:0;background:transparent;font:inherit;font-size:16px;color:#475467;cursor:pointer}
.gxe-step button:hover{background:#f2f4f7}
.gxe-step input{width:36px;height:100%;border:0;border-left:1px solid #eaecf0;border-right:1px solid #eaecf0;text-align:center;font:inherit;font-size:14px;color:#101828;outline:none;-moz-appearance:textfield;appearance:textfield}
.gxe-step input::-webkit-outer-spin-button,.gxe-step input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.gxe-step:focus-within{border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.12)}
.gxe-rented{grid-column:2 / -1;font-size:12.5px;color:#667085}
.gxe-cell{display:flex;flex-direction:column;gap:4px;justify-self:start;min-width:0}
.gxe-at{display:none;font-size:11.5px;font-weight:600;color:#667085;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gxe-done{display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:14px;background:#ecfdf3;color:#05603a}
.gxe-done i{font-size:22px}
.gxe-done p{color:#05603a;font-size:14px;font-weight:600}
.gxe-row{display:flex;align-items:center;gap:12px;padding:10px 14px;border:1px solid #e4e7ec;border-radius:13px;background:#fff}
.gxe-row div{flex:1 1 auto;min-width:0}
.gxe-row strong{display:block;font-size:14px}
.gxe-row small{display:block;font-size:12px;color:#667085;margin-top:2px}
.gxe-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px}
.gxe-spacer{flex:1 1 auto}
.gxe-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:42px;padding:0 18px;border:1px solid #d0d5dd;border-radius:12px;background:#fff;font:inherit;font-size:14px;font-weight:650;color:#344054;cursor:pointer}
.gxe-btn.primary{border-color:var(--primary,#d93025);background:var(--primary,#d93025);color:#fff}
.gxe-btn:disabled{opacity:.55;cursor:default}
.gxe-btn:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
.gxe-busy{display:flex;align-items:center;gap:10px;min-height:120px;justify-content:center;color:#475467}
.gxe-error{color:#b42318;font-size:13px;margin:0}
.gxe-error:empty{display:none}
.gxe-note{font-size:12.5px}
/* A phone: each kind's name on its own line, its counts below it, each named by its location. */
@media(max-width:560px){.gxe-grid{grid-template-columns:minmax(0,1fr)}.gxe-trow{grid-template-columns:repeat(var(--cols,1),minmax(0,1fr));row-gap:8px}.gxe-trow .gxe-name,.gxe-rented{grid-column:1 / -1}.gxe-trow.head{display:none}.gxe-at{display:block}.gxe-actions .gxe-btn{flex:1 1 auto}}
@media(prefers-reduced-motion:reduce){.gxe *{transition:none!important}}
`;
const tick = '<span class="gxe-tick" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12 4 4 10-10"/></svg></span>';
function installStyle(){
  if (document.getElementById('gxe-css')) return;
  const style = document.createElement('style'); style.id = 'gxe-css'; style.textContent = css; document.head.append(style);
}

/** The kinds the step's options offer this company: those for its industry (or for everyone) first, in their order. */
export function offeredKinds(options, profile){
  const industry = clean(object(profile).industry), type = clean(object(profile).company_type);
  const fits = (entry) => { const industries = array(entry.industries), types = array(entry.company_types); return (!industries.length && !types.length) || !industry || industries.includes(industry) || types.includes(type); };
  return array(object(options).equipment).filter((entry) => clean(entry.id) && fits(entry));
}

export function mount(el, ctx){
  installStyle();
  const { esc } = ctx;
  const L = (key, fallback, values) => { let text = ctx.L(key, fallback); for (const [name, value] of Object.entries(values || {})) text = text.split(`{${name}}`).join(String(value)); return text; };
  const copy = (value, fallback = '') => value && typeof value === 'object' ? ctx.L(clean(value.key), clean(value.text) || fallback) : clean(value) || fallback;
  const orgId = String(window.__APP?.userOrgId || window.Portal?.currentUser?.orgId || ctx.orgId || '');
  const options = object(ctx.options);
  const groups = array(options.groups);
  let alive = true, busy = false, page = 0, kinds = [], locations = [], picked = new Set(), counts = {}, own = [], result = null;
  const pages = ['locations', 'equipment', 'units', 'done'];

  const errorLine = '<p class="gxe-error" role="alert" data-gxe-error></p>';
  const fail = (error) => { const node = el.querySelector('[data-gxe-error]'); if (node) node.textContent = clean(error?.message) || L('gx_eqs_error', 'That didn’t work. Try again.'); };
  const heading = el.closest('.gxs-step')?.querySelector('.gxs-titlebar h2'), stepHeading = heading?.innerHTML || '';
  function title(value){ ctx.setTitle?.(value); if (heading) heading.innerHTML = value ? esc(value) : stepHeading; }
  const icon = (name) => `<span class="gxe-icon" aria-hidden="true"><i class="fas ${esc(name || 'fa-toolbox')}"></i></span>`;
  const all = () => [...kinds, ...own];
  const chosen = () => all().filter((kind) => picked.has(kind.id));
  const counted = (kind) => kind.units !== false && kind.ownership !== 'rented';
  const unitsOf = (kind, at) => Math.max(0, Math.min(MAX_UNITS, Number(object(counts[kind.id])[at]) || 0));
  function selections(){
    return {
      facilities: locations.map((row) => ({ key: row.key, ...(row.id ? { id: row.id } : {}), name: clean(row.name) })),
      equipment: chosen().map((kind) => ({
        key: kind.id, name: kind.label,
        ...(kind.kind ? { kind: kind.kind } : {}), ...(kind.category ? { category: kind.category } : {}), ...(kind.icon ? { icon: kind.icon } : {}),
        ...(kind.hint ? { description: kind.hint } : {}), ...(array(kind.provides).length ? { provides: kind.provides } : {}),
        ownership: kind.ownership || 'owned',
        units: counted(kind) ? Object.fromEntries(locations.map((row) => [row.key, unitsOf(kind, row.key)])) : {}
      }))
    };
  }
  function report(){ ctx.change?.(selections(), chosen().map((kind) => kind.label).join(', ')); }
  function go(to){ page = Math.max(0, Math.min(to, pages.length - 1)); draw(); el.closest('.gxs-step')?.scrollTo?.({ top: 0 }); }
  const backButton = () => `<button type="button" class="gxe-btn" data-gxe-back><i class="fas fa-arrow-left" aria-hidden="true"></i>${esc(L('gx_ui_back', 'Back'))}</button>`;

  // ── Where do you keep your equipment? ──────────────────────────────────
  function drawLocations(){
    title(L('gx_eqs_locations_title', 'Where do you keep your equipment?'));
    const single = locations.length === 1;
    el.innerHTML = `<div class="gxe" data-gxe-page="locations">
      <p>${esc(single ? L('gx_eqs_locations_lead_one', 'Your equipment comes from one place. Give it a name your team uses.') : L('gx_eqs_locations_lead', 'Each location you work out of gets its own facility, so every unit has a home. Give each one a name your team uses.'))}</p>
      <div class="gxe-rows">${locations.map((row, at) => `<div class="gxe-loc" data-gxe-loc="${esc(row.key)}">${icon('fa-warehouse')}<input class="gxe-input" data-gxe-loc-name value="${esc(row.name)}" maxlength="120" aria-label="${esc(L('gx_eqs_location_name', 'Location name'))}" placeholder="${esc(L('gx_eqs_location_n', 'Location {n}', { n: at + 1 }))}">${!row.id && locations.length > 1 ? `<button type="button" class="gxe-remove" data-gxe-loc-remove aria-label="${esc(L('gx_eqs_location_remove', 'Remove this location'))}"><i class="fas fa-xmark" aria-hidden="true"></i></button>` : ''}</div>`).join('')}</div>
      ${locations.length < MAX_LOCATIONS ? `<button type="button" class="gxe-link" data-gxe-loc-add><i class="fas fa-plus" aria-hidden="true"></i>${esc(L('gx_eqs_location_add', 'Add a location'))}</button>` : ''}
      <p class="gxe-note">${esc(L('gx_eqs_locations_note', 'You can add each one’s address in Equipment › Facilities.'))}</p>
      ${errorLine}
      <div class="gxe-actions"><span class="gxe-spacer"></span><button type="button" class="gxe-btn primary" data-gxe-next>${esc(L('gx_ui_continue', 'Continue'))}</button></div>
    </div>`;
    el.querySelectorAll('[data-gxe-loc-name]').forEach((input) => input.addEventListener('input', () => {
      const row = locations.find((entry) => entry.key === input.closest('[data-gxe-loc]').dataset.gxeLoc); if (row) row.name = input.value; report();
    }));
    el.querySelectorAll('[data-gxe-loc-remove]').forEach((button) => button.addEventListener('click', () => {
      const key = button.closest('[data-gxe-loc]').dataset.gxeLoc; locations = locations.filter((row) => row.key !== key); report(); draw();
    }));
    el.querySelector('[data-gxe-loc-add]')?.addEventListener('click', () => {
      locations.push(newLocation(locations.length)); report(); draw();
      const inputs = el.querySelectorAll('[data-gxe-loc-name]'); inputs[inputs.length - 1]?.focus();
    });
    el.querySelector('[data-gxe-next]').addEventListener('click', () => {
      const empty = locations.findIndex((row) => !clean(row.name));
      if (empty >= 0) { fail({ message: L('gx_eqs_location_name_required', 'Give each location a name.') }); el.querySelectorAll('[data-gxe-loc-name]')[empty]?.focus(); return; }
      go(page + 1);
    });
  }
  function newLocation(at){
    const used = new Set(locations.map((row) => row.key));
    let n = at + 1; while (used.has(`loc${n}`)) n += 1;
    return { key: `loc${n}`, id: '', name: at === 0 ? L('gx_eqs_location_main', 'Main shop') : L('gx_eqs_location_n', 'Location {n}', { n: at + 1 }) };
  }

  // ── What equipment do you use? ─────────────────────────────────────────
  function tile(kind){
    return `<button type="button" class="gxe-tile" data-gxe-kind="${esc(kind.id)}" aria-pressed="${picked.has(kind.id)}">${icon(kind.icon)}<span><strong>${esc(kind.label)}</strong>${kind.hint ? `<small>${esc(kind.hint)}</small>` : ''}</span>${tick}</button>`;
  }
  function drawEquipment(){
    title(L('gx_eqs_equipment_title', 'What equipment do you use?'));
    const sections = groups.length
      ? [...groups.map((group) => ({ label: copy(group.label), kinds: kinds.filter((kind) => kind.group === clean(group.id)) })), { label: L('gx_eqs_group_other', 'Other equipment'), kinds: [...kinds.filter((kind) => !groups.some((group) => clean(group.id) === kind.group)), ...own] }]
      : [{ label: '', kinds: all() }];
    el.innerHTML = `<div class="gxe" data-gxe-page="equipment">
      <p>${esc(L('gx_eqs_equipment_lead', 'Check everything you use on your jobs. Leave off what you don’t: you can add more any time.'))}</p>
      ${sections.filter((section) => section.kinds.length).map((section) => `<div class="gxe-group">${section.label ? `<h3>${esc(section.label)}</h3>` : ''}<div class="gxe-grid">${section.kinds.map(tile).join('')}</div></div>`).join('')}
      <form class="gxe-own" data-gxe-own><input class="gxe-input" name="own" maxlength="80" autocomplete="off" placeholder="${esc(L('gx_eqs_own_placeholder', 'Something else? Type it here'))}" aria-label="${esc(L('gx_eqs_own', 'Other equipment'))}"><button type="submit" class="gxe-btn"><i class="fas fa-plus" aria-hidden="true"></i>${esc(L('gx_eqs_own_add', 'Add'))}</button></form>
      ${errorLine}
      <div class="gxe-actions">${backButton()}<span class="gxe-spacer"></span><button type="button" class="gxe-btn primary" data-gxe-next>${esc(L('gx_ui_continue', 'Continue'))}</button></div>
    </div>`;
    // A press changes its own tile in place; nothing it landed on is drawn again.
    el.querySelectorAll('[data-gxe-kind]').forEach((button) => button.addEventListener('click', () => {
      const id = button.dataset.gxeKind; if (picked.has(id)) picked.delete(id); else picked.add(id);
      button.setAttribute('aria-pressed', String(picked.has(id))); report();
    }));
    el.querySelector('[data-gxe-own]').addEventListener('submit', (event) => {
      event.preventDefault();
      const input = event.target.elements.own, label = clean(input.value).replace(/[<>]/g, '');
      const id = `custom_${slug(label)}`;
      if (!label || id === 'custom_') { input.focus(); return; }
      if (!all().some((kind) => kind.id === id)) own.push({ id, label, icon: 'fa-toolbox', kind: 'other', units: true });
      picked.add(id); report(); draw();
      el.querySelector('[data-gxe-own] input')?.focus();
    });
    el.querySelector('[data-gxe-back]').addEventListener('click', () => go(page - 1));
    el.querySelector('[data-gxe-next]').addEventListener('click', () => {
      if (!picked.size) { fail({ message: L('gx_eqs_equipment_required', 'Check at least one kind of equipment, or close the setup for now.') }); return; }
      go(page + 1);
    });
  }

  // ── How many do you have? ──────────────────────────────────────────────
  function drawUnits(){
    title(L('gx_eqs_units_title', 'How many do you have?'));
    const cols = locations.length;
    const stepper = (kind, row) => `<span class="gxe-cell">${cols > 1 ? `<small class="gxe-at">${esc(row.name)}</small>` : ''}<span class="gxe-step" data-gxe-count="${esc(kind.id)}" data-at="${esc(row.key)}"><button type="button" data-gxe-minus aria-label="${esc(L('gx_eqs_fewer', 'One fewer'))}">−</button><input type="number" inputmode="numeric" min="0" max="${MAX_UNITS}" value="${unitsOf(kind, row.key)}" aria-label="${esc(`${kind.label} · ${clean(row.name)}`)}"><button type="button" data-gxe-plus aria-label="${esc(L('gx_eqs_more', 'One more'))}">+</button></span></span>`;
    el.innerHTML = `<div class="gxe" data-gxe-page="units">
      <p>${esc(cols > 1 ? L('gx_eqs_units_lead_many', 'How many of each do you have at each location? We’ll add them to your fleet, numbered, and you can fill in the details later.') : L('gx_eqs_units_lead', 'How many of each do you have? We’ll add them to your fleet, numbered, and you can fill in the details later.'))}</p>
      <div class="gxe-table" style="--cols:${cols}">
        ${cols > 1 ? `<div class="gxe-trow head"><span></span>${locations.map((row) => `<span title="${esc(row.name)}">${esc(row.name)}</span>`).join('')}</div>` : ''}
        ${chosen().map((kind) => `<div class="gxe-trow" data-gxe-unit-row="${esc(kind.id)}"><span class="gxe-name">${icon(kind.icon)}<span><strong>${esc(kind.label)}</strong>${kind.existing ? `<small>${esc(L('gx_eqs_units_have', '{n} in your fleet now', { n: kind.existing }))}</small>` : ''}</span></span>${counted(kind) ? locations.map((row) => stepper(kind, row)).join('') : `<span class="gxe-rented">${esc(copy(kind.note, L('gx_eqs_units_rented', 'Rented when you need one: nothing to count.')))}</span>`}</div>`).join('')}
      </div>
      ${errorLine}
      <div class="gxe-actions">${backButton()}<span class="gxe-spacer"></span><button type="button" class="gxe-btn primary" data-gxe-apply>${esc(L('gx_eqs_apply', 'Set up my equipment'))}</button></div>
    </div>`;
    const set = (holder, value) => {
      const kind = all().find((entry) => entry.id === holder.dataset.gxeCount); if (!kind) return;
      const next = Math.max(0, Math.min(MAX_UNITS, Math.round(Number(value)) || 0));
      counts[kind.id] = { ...object(counts[kind.id]), [holder.dataset.at]: next };
      const input = holder.querySelector('input'); if (String(next) !== input.value) input.value = String(next);
      report();
    };
    el.querySelectorAll('[data-gxe-count]').forEach((holder) => {
      const input = holder.querySelector('input');
      holder.querySelector('[data-gxe-minus]').addEventListener('click', () => set(holder, Number(input.value) - 1));
      holder.querySelector('[data-gxe-plus]').addEventListener('click', () => set(holder, Number(input.value) + 1));
      input.addEventListener('change', () => set(holder, input.value));
    });
    el.querySelector('[data-gxe-back]').addEventListener('click', () => go(page - 1));
    el.querySelector('[data-gxe-apply]').addEventListener('click', (event) => apply(event.currentTarget));
  }
  async function apply(button){
    if (busy) return; busy = true; button.disabled = true;
    report();
    try {
      const target = { scope: 'organization', organizationId: orgId };
      const response = await window.PlatformAPI.publication.invoke(orgId, 'equipment.setup.apply', target, selections(), { idempotencyKey: `equipment.setup:${orgId}:${crypto.randomUUID()}` });
      if (!alive) return;
      result = object(response?.value ?? response?.result ?? response);
      // What was just written is no longer new: a Back and a second Set up only add what is still short.
      const ids = new Map(array(result.facilities).map((row) => [clean(row.name), clean(row.id)]));
      locations = locations.map((row) => ({ ...row, id: row.id || ids.get(clean(row.name)) || '' }));
      // The Equipment tab under the sheet (here, or in the top page under a project window) reads its fleet again.
      const windows = new Set([window]); try { if (window.top.location.origin === location.origin) windows.add(window.top); } catch (_) {}
      windows.forEach((win) => win.dispatchEvent(new win.CustomEvent('fm:equipment:changed', { detail: { source: 'equipment.setup' } })));
      go(pages.indexOf('done'));
    } catch (error) { fail(error); }
    finally { busy = false; if (button.isConnected) button.disabled = false; }
  }

  // ── We've set up your equipment ────────────────────────────────────────
  function drawDone(){
    title(L('gx_eqs_done_title', 'We’ve set up your equipment'));
    // What the fleet has now, as the action read it back: per facility, by its id.
    const fleet = (kind) => object(array(object(result).equipment).find((row) => clean(row.key) === kind.id)?.units);
    const total = (kind) => Object.values(fleet(kind)).reduce((sum, value) => sum + (Number(value) || 0), 0);
    const where = (kind) => locations.length > 1 ? locations.filter((row) => Number(fleet(kind)[row.id]) > 0).map((row) => `${clean(row.name)} ${Number(fleet(kind)[row.id])}`).join(' · ') : '';
    el.innerHTML = `<div class="gxe" data-gxe-page="done">
      <div class="gxe-done" role="status"><i class="fas fa-circle-check" aria-hidden="true"></i><p>${esc(L('gx_eqs_done_body', 'You can adjust your equipment at any time in the Equipment tab.'))}</p></div>
      <div class="gxe-rows">
        <div class="gxe-row">${icon('fa-warehouse')}<div><strong>${esc(locations.length === 1 ? clean(locations[0].name) : L('gx_eqs_done_locations', '{n} locations', { n: locations.length }))}</strong>${locations.length > 1 ? `<small>${esc(locations.map((row) => clean(row.name)).join(', '))}</small>` : ''}</div></div>
        ${chosen().map((kind) => `<div class="gxe-row" data-gxe-done="${esc(kind.id)}">${icon(kind.icon)}<div><strong>${esc(kind.label)}</strong><small>${esc(counted(kind) ? `${L('gx_eqs_done_units', '{n} in your fleet', { n: total(kind) })}${where(kind) ? ` · ${where(kind)}` : ''}` : copy(kind.note, L('gx_eqs_units_rented', 'Rented when you need one: nothing to count.')))}</small></div></div>`).join('')}
      </div>
      ${errorLine}
      <div class="gxe-actions"><span class="gxe-spacer"></span><button type="button" class="gxe-btn primary" data-gxe-finish>${esc(L('gx_ui_done', 'Done'))}</button></div>
    </div>`;
    el.querySelector('[data-gxe-finish]').addEventListener('click', (event) => finish(event.currentTarget));
  }
  async function finish(button){
    if (busy) return; busy = true; button.disabled = true;
    try { await ctx.complete?.(); } catch (error) { fail(error); } finally { busy = false; if (button.isConnected) button.disabled = false; }
  }

  function draw(){
    if (!alive) return;
    const name = pages[page];
    if (name === 'locations') drawLocations();
    else if (name === 'equipment') drawEquipment();
    else if (name === 'units') drawUnits();
    else drawDone();
  }

  el.innerHTML = '<div class="gxe"><div class="gxe-busy"><span class="gxs-spin" aria-hidden="true"></span></div></div>';
  Promise.all([ctx.read('company-profile', 'profile').catch(() => null), ctx.read('equipment-setup', 'status')]).then(([profile, status]) => {
    if (!alive) return;
    profile = object(profile); status = object(status);
    // The facilities the fleet has, then new ones up to the number of locations the company said it works out of.
    locations = array(status.facilities).map((row, at) => ({ key: `yard${at + 1}`, id: clean(row.id), name: clean(row.name) }));
    const wanted = Math.max(1, Math.min(MAX_LOCATIONS, Number(profile.locations) || 1));
    while (locations.length < wanted) locations.push(newLocation(locations.length));
    const made = new Map(array(status.equipment).map((row) => [clean(row.key), row]));
    kinds = offeredKinds(options, profile).map((entry) => ({
      id: clean(entry.id), label: copy(entry.label, clean(entry.id)), hint: copy(entry.hint), icon: clean(entry.icon), group: clean(entry.group),
      kind: clean(entry.kind), category: clean(entry.category), provides: array(entry.provides), ownership: clean(entry.ownership) || 'owned',
      units: entry.units !== false, note: entry.note
    }));
    // A kind set up before is checked again, with its units where they are (an answer kept across Back comes first).
    for (const [key, row] of made) {
      if (!kinds.some((kind) => kind.id === key)) own.push({ id: key, label: clean(row.name), icon: 'fa-toolbox', kind: 'other', units: true });
      picked.add(key);
      const kind = all().find((entry) => entry.id === key);
      const units = object(row.units);
      kind.existing = Object.values(units).reduce((sum, value) => sum + (Number(value) || 0), 0);
      counts[key] = Object.fromEntries(locations.map((loc) => [loc.key, Number(units[loc.id]) || 0]));
    }
    for (const kind of kinds) if (!counts[kind.id]) counts[kind.id] = Object.fromEntries(locations.map((loc, at) => [loc.key, at === 0 ? 1 : 0]));
    const answer = object(ctx.answer);
    if (array(answer.equipment).length) picked = new Set(array(answer.equipment).map((row) => clean(row.key)).filter((id) => all().some((kind) => kind.id === id)));
    report(); draw();
  }).catch((error) => { if (alive) { el.innerHTML = `<div class="gxe">${errorLine}</div>`; fail(error); } });
  return {
    valid: () => true,
    escape: () => busy,
    // The phone's back walks these pages first; once the equipment is written there is nothing to go back to.
    backDepth: () => pages[page] === 'done' ? 0 : page,
    back(){ if (pages[page] === 'done' || page === 0) return false; go(page - 1); return true; },
    destroy(){ alive = false; }
  };
}
export default mount;
