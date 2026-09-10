/* Prices: server-authorized configuration, preview and optimistic saves. */
(function () {
  const cfg = () => window.Portal?.cfg || window.PORTAL_CFG || {};
  const fields = [
    ['base_fee', 'Starting rush fee', '$', 0, 100, .1, '1–3-hour rush before multipliers.'],
    ['busy_adder', 'Busy-period increase', '$', 0, 100, .1, 'Added gradually as the estimated wait rises.'],
    ['fee_multiplier', 'Fee multiplier', '×', 0, 20, .01, 'Applies to both rush tiers.'],
    ['fast_multiplier', 'Under-one-hour multiplier', '×', 1, 20, .01, 'Extra multiplier for the fastest tier.'],
    ['rush_adder', '1–3-hour flat adder', '$', 0, 100, .01, 'Added after the multiplier.'],
    ['fast_adder', 'Under-one-hour flat adder', '$', 0, 100, .01, 'Must be at least the 1–3-hour adder.'],
    ['wait_min_minutes', 'Increase starts at', 'min', 0, 1440, 1, 'Wait at which the busy increase starts.'],
    ['wait_max_minutes', 'Maximum reached at', 'min', 1, 2880, 1, 'Wait at which the full busy increase applies.']
  ];
  let root, saved, csrf, previewTimer, previewSequence = 0, dirty = false, busy = false;
  const esc = value => Portal.escapeHtml(String(value));
  const base = () => String(cfg().endpoints.firstmeasure).replace(/\/$/, '') + '/admin/prices/';
  async function api(path = '', method = 'GET', body) {
    if (method !== 'GET') {
      const response = await fetch(String(cfg().endpoints.platform).replace(/\/$/, '') + '/auth/session', { credentials: 'include', cache: 'no-store' });
      const session = await response.json();
      if (!response.ok || !session.csrf_token) throw new Error('Your session expired. Sign in again.');
      csrf = session.csrf_token;
    }
    const response = await fetch(base() + path, { method, credentials: 'include', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-Platform-CSRF': csrf } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.message || data.error?.message || data.error || 'Unable to load prices.');
    return data;
  }
  function values() { return Object.fromEntries(fields.map(([key]) => [key, Number(root.querySelector(`[name="${key}"]`).value)])); }
  function message(text, error = false) { const el = root.querySelector('[data-message]'); el.textContent = text; el.dataset.error = String(error); }
  function buttons() { root.querySelector('[data-save]').disabled = busy || !dirty; root.querySelector('[data-reload]').disabled = busy; root.querySelector('[data-defaults]').disabled = busy || !saved; }
  async function preview() {
    const sequence = ++previewSequence;
    try {
      if (!root.querySelector('form').checkValidity()) throw new Error('Enter valid values to preview prices.');
      const data = await api('preview', 'POST', values());
      if (sequence !== previewSequence) return;
      root.querySelector('[data-preview]').innerHTML = `<table><caption>Report price · no add-ons</caption><thead><tr><th>Wait</th><th>Standard</th><th>1–3 hour</th><th>Under 1 hour</th></tr></thead><tbody>${data.samples.map(row => `<tr><th>${esc(row.wait_minutes)} min</th>${row.residential.map(price => `<td>$${Number(price).toFixed(2)}</td>`).join('')}</tr>`).join('')}</tbody></table><p class="prices-note">Commercial / multifamily, per structure at maximum wait: ${data.samples[2].commercial.map(price => '$' + Number(price).toFixed(2)).join(' / ')}.</p>`;
      root.querySelector('[data-current]').textContent = 'Current estimated wait: ' + data.current.options[0].estimated_wait_minutes + ' min';
    } catch (error) { if (sequence === previewSequence) root.querySelector('[data-preview]').textContent = error.message; }
  }
  function populate(config) { fields.forEach(([key]) => { root.querySelector(`[name="${key}"]`).value = config[key]; }); }
  async function load() {
    busy = true; buttons(); message('Loading prices…');
    try {
      const data = await api(); saved = data; populate(data.config); dirty = false;
      root.querySelector('fieldset').disabled = false;
      message(data.updated_at ? `Saved by ${data.updated_by || 'admin'} · ${new Date(data.updated_at).toLocaleString()} · revision ${data.revision}` : 'Original pricing defaults · no changes saved');
      await preview();
    } catch (error) { root.querySelector('fieldset').disabled = true; message(error.message, true); }
    finally { busy = false; buttons(); }
  }
  function init() {
    if (!cfg().flags?.can_manage_prices || !window.Portal) return;
    const host = document.getElementById('portalPluginViews'); if (!host) return;
    const style = document.createElement('style');
    style.textContent = `.prices-page{max-width:1160px;margin:auto;padding:28px;color:#17263b}.prices-page h1{font-size:30px;letter-spacing:-1px;margin:0 0 8px}.prices-page p{line-height:1.5}.prices-note{color:#64748b;font-size:13px}.prices-layout{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(320px,1fr);gap:22px;margin-top:24px}.prices-card{background:#fff;border:1px solid #dce3ed;border-radius:18px;padding:24px;box-shadow:0 4px 20px #14253d06}.prices-fields{display:grid;grid-template-columns:1fr 1fr;gap:22px 18px;border:0;padding:0;margin:0}.prices-fields label{font-size:13px;font-weight:700;display:block}.prices-input{display:flex;align-items:center;border:1px solid #c9d4e3;border-radius:9px;margin-top:8px;padding-right:12px;background:#fafcff}.prices-input:focus-within{outline:2px solid #2b6cec;outline-offset:2px}.prices-input input{min-width:0;width:100%;border:0;background:transparent;padding:11px;font-size:17px;color:#17263b}.prices-input span{font-size:13px;color:#64748b}.prices-fields small{display:block;font-weight:400;line-height:1.4;color:#64748b;margin-top:6px}.prices-page button{border-radius:9px;padding:10px 15px;border:1px solid #c9d4e3;background:white;color:#253753;cursor:pointer;font-weight:700}.prices-page button:disabled{opacity:.45;cursor:not-allowed}.prices-page [data-save]{background:#245de3;border-color:#245de3;color:white}.prices-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:24px}.prices-page table{width:100%;font-size:13px;border-collapse:collapse}.prices-page caption{text-align:left;font-weight:700;margin-bottom:14px}.prices-page th,.prices-page td{padding:12px 5px;text-align:right;border-bottom:1px solid #e6ecf4}.prices-page th:first-child{text-align:left}.prices-formula{background:#f0f5ff;border-radius:10px;padding:14px;font-size:13px;line-height:1.8}.prices-page [data-message]{margin-top:16px;font-size:13px;min-height:20px}.prices-page [data-error=true]{color:#b42318}@media(max-width:850px){.prices-layout{grid-template-columns:1fr}.prices-page{padding:16px}}@media(max-width:430px){.prices-fields{grid-template-columns:1fr}}`;
    document.head.appendChild(style);
    root = document.createElement('section'); root.id = 'view-prices'; root.style.display = 'none';
    root.innerHTML = `<div class="prices-page"><h1>Prices</h1><p class="prices-note">Expedite pricing · full internal admins only</p><div class="prices-layout"><form class="prices-card"><fieldset class="prices-fields" disabled>${fields.map(([key,label,unit,min,max,step,hint]) => `<label>${esc(label)}<div class="prices-input"><input required type="number" name="${key}" min="${min}" max="${max}" step="${step}"><span>${unit}</span></div><small>${esc(hint)}</small></label>`).join('')}</fieldset><div class="prices-actions"><button type="submit" data-save disabled>Save prices</button><button type="button" data-defaults disabled>Use original defaults</button><button type="button" data-reload>Reload saved</button></div><div data-message role="status" aria-live="polite"></div></form><aside class="prices-card"><h2 style="margin-top:0;font-size:18px">Preview before saving</h2><p data-current class="prices-note"></p><div data-preview aria-live="polite">Loading preview…</div><div class="prices-formula">Rush fee = (starting fee + busy increase) × multiplier + flat adder.<br>Under-one-hour rush also applies its extra multiplier.</div><p class="prices-note">The busy increase uses the existing Pacific-time wait estimate, not live queue counts. Wait thresholds change pricing only—not promised delivery windows. The starting fee plus busy increase rounds to $0.10 before multipliers; final fees round to cents.</p><p class="prices-note">Standard reports stay $7 residential / $12 per commercial or multifamily structure. Saved changes apply to new quotes; existing charged orders are not repriced.</p></aside></div></div>`;
    host.appendChild(root); Portal.registerPlugin({ id: 'prices', title: 'Prices', iconClass: 'fas fa-dollar-sign' });
    root.querySelector('form').addEventListener('input', () => { dirty = true; buttons(); message('Unsaved changes'); ++previewSequence; clearTimeout(previewTimer); previewTimer = setTimeout(preview, 300); });
    root.querySelector('form').addEventListener('submit', async event => {
      event.preventDefault(); if (busy || !saved) return;
      busy = true; buttons(); root.querySelector('fieldset').disabled = true;
      try { const data = await api('', 'PUT', { revision: saved.revision, config: values() }); saved = data; dirty = false; message(`Prices saved · revision ${data.revision}`); }
      catch (error) { message(error.message, true); }
      finally { busy = false; root.querySelector('fieldset').disabled = false; buttons(); }
    });
    root.querySelector('[data-defaults]').onclick = () => { populate(saved.defaults); dirty = true; buttons(); message('Original defaults staged—save to apply.'); void preview(); };
    root.querySelector('[data-reload]').onclick = () => { if (!dirty || window.confirm('Discard unsaved changes and reload?')) void load(); };
    const original = Portal.switchView.bind(Portal);
    Portal.switchView = async function (id, button) { await original(id, button); if (id === 'prices' && !saved) await load(); };
    window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
