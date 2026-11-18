/* Leads (public/v1/development/synthetic-leads.ts): made-up leads in this sandbox organization, each received as a real
 * lead is (receiveLead), so matching, sources, routing and the organization's lead.received rules run. */
// crypto.randomUUID needs a secure context; a plain-http dev host still gets a version 4 id.
const uuid = () => crypto.randomUUID?.() || '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));

export async function mount(root, { api, T, esc }) {
  const dev = (options) => api('/v1/signup-sandbox/development/synthetic-leads', options);
  root.innerHTML = `<p class="fm-dc-empty">${esc(T('dc_loading', 'Loading…'))}</p>`;
  const options = await dev();
  const label = (field) => T(`dc_leads_field_${field.id}`, field.label);
  root.innerHTML = `<p class="fm-dc-intro">${esc(T('dc_leads_intro', 'Adds made-up leads to this sandbox organization. Each arrives as a real lead does: routing and your new-lead rules run.'))}</p>
    <div class="fm-dc-fields"><label class="fm-dc-field">${esc(T('dc_leads_count', 'How many'))}<input type="number" inputmode="numeric" min="1" max="${Number(options.max) || 25}" value="1" data-dev-lead-count></label></div>
    <h3 class="fm-dc-h">${esc(T('dc_leads_fields', 'What each lead has'))}</h3><div data-dev-lead-fields></div>
    <div class="fm-dc-actions"><button type="button" class="fm-dc-btn fm-dc-primary" data-dev-lead-add><i class="fas fa-plus" aria-hidden="true"></i> <span data-dev-lead-label></span></button></div>
    <div class="fm-dc-note" role="status" aria-live="polite" data-dev-lead-results hidden></div>`;
  const list = root.querySelector('[data-dev-lead-fields]');
  for (const field of options.fields) {
    const row = document.createElement('label'); row.className = 'fm-dc-row';
    row.innerHTML = `<i class="fas ${esc(field.icon)}" aria-hidden="true" style="width:16px;color:#667085"></i><span>${esc(label(field))}</span><input type="checkbox" class="fm-dc-switch" role="switch" ${field.default ? 'checked' : ''} data-dev-lead-field="${esc(field.id)}" aria-label="${esc(label(field))}">`;
    list.append(row);
    if (field.id === 'source' && options.sources?.length) {
      // The organization's own sources; Random picks one per lead.
      const choose = document.createElement('label'); choose.className = 'fm-dc-field'; choose.style.margin = '0 0 8px 24px';
      choose.innerHTML = `<select data-dev-lead-source aria-label="${esc(label(field))}"><option value="">${esc(T('dc_leads_source_random', 'Random source'))}</option></select>`;
      for (const source of options.sources) choose.firstElementChild.append(new Option(source.label, source.id));
      list.append(choose);
    }
  }
  const add = root.querySelector('[data-dev-lead-add]'), report = root.querySelector('[data-dev-lead-results]');
  const countInput = root.querySelector('[data-dev-lead-count]'), sourceSelect = root.querySelector('[data-dev-lead-source]');
  const max = Number(options.max) || 25;
  let busy = false, requestId = null;
  const count = () => Math.round(Number(countInput.value));
  const chosen = () => Object.fromEntries([...root.querySelectorAll('[data-dev-lead-field]')].map((el) => [el.dataset.devLeadField, el.checked]));
  const update = () => {
    const n = count(), fields = chosen();
    const valid = n >= 1 && n <= max && ['name', 'phone', 'email', 'address', 'note'].some((id) => fields[id]);
    root.querySelector('[data-dev-lead-label]').textContent = n > 1 ? T('dc_leads_add_many', 'Add {n} leads').replace('{n}', String(n)) : T('dc_leads_add_one', 'Add a lead');
    if (sourceSelect) sourceSelect.closest('label').hidden = !fields.source;
    add.disabled = busy || !valid;
  };
  // A changed form is a new request; a retry of the same one (after an error) makes only the leads still missing.
  root.addEventListener('input', () => { requestId = null; update(); });
  root.addEventListener('change', () => { requestId = null; update(); });
  update();
  add.onclick = async () => {
    if (busy) return;
    requestId ||= uuid(); busy = true; update();
    report.hidden = false; report.className = 'fm-dc-note'; report.textContent = T('dc_leads_adding', 'Adding leads…');
    root.querySelectorAll('input,select').forEach((el) => { el.disabled = true; });
    try {
      const result = await dev({ method: 'POST', body: { count: count(), fields: chosen(), source_id: sourceSelect?.value || '', request_id: requestId } });
      requestId = null;
      report.replaceChildren();
      const heading = document.createElement('strong');
      heading.textContent = result.created === 1 ? T('dc_leads_added_one', '1 lead added') : T('dc_leads_added_many', '{n} leads added').replace('{n}', String(result.created));
      report.append(heading);
      for (const lead of result.leads) {
        const line = document.createElement('div'); line.style.marginTop = '6px';
        const open = window.FirstMateProjectWindows?.open;
        const name = document.createElement(open ? 'button' : 'span');
        if (open) { name.type = 'button'; name.className = 'fm-dc-link'; name.style.width = 'auto'; name.style.fontWeight = '600'; name.onclick = () => open(lead.project_id); }
        name.textContent = lead.name || lead.title || lead.project_id;
        const details = document.createElement('small'); details.className = 'fm-dc-sub';
        details.textContent = [lead.phone, lead.email, lead.address, lead.source && `${T('dc_leads_source', 'Source')}: ${lead.source}`, lead.routed ? `${T('dc_leads_routed', 'Routed to')} ${lead.routed}` : lead.new_lead && T('dc_leads_new_lead', 'New lead, no scope yet'), lead.matched && T('dc_leads_matched', 'matched an existing contact')].filter(Boolean).join(' · ');
        line.append(name, details); report.append(line);
      }
      window.dispatchEvent(new CustomEvent('development:synthetic-leads', { detail: result }));
    } catch (error) {
      report.className = 'fm-dc-note fm-dc-warn';
      report.textContent = error.message || T('dc_leads_failed', 'Could not add the leads. You can retry safely.');
    } finally {
      busy = false; root.querySelectorAll('input,select').forEach((el) => { el.disabled = false; }); update();
    }
  };
}
