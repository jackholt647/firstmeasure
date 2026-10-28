/* Synthetic data (public/v1/development/synthetic-data.ts): adds sample records to this sandbox organization. Retries are additive and safe. */
export async function mount(root, { api, T, esc }) {
  const dev = (path, options) => api('/v1/signup-sandbox/development' + path, options);
  root.innerHTML = `<p class="fm-dc-empty">${esc(T('dc_loading', 'Loading…'))}</p>`;
  const catalog = await dev('');
  root.innerHTML = `<p class="fm-dc-intro">${esc(T('dc_synthetic_intro', 'Adds sample records to this sandbox organization. Running it again adds more; what you edited stays.'))}</p>
    <div class="fm-dc-fields"><label class="fm-dc-field">${esc(T('dc_synthetic_company', 'Company type'))}<select data-dev-company></select></label><label class="fm-dc-field">${esc(T('dc_synthetic_amount', 'Amount'))}<select data-dev-amount><option value="1">1×</option><option value="3">3×</option><option value="5">5×</option><option value="10">10×</option></select></label></div>
    <h3 class="fm-dc-h">${esc(T('dc_synthetic_categories', 'What to add'))} <span data-dev-count></span></h3><div data-dev-categories></div>
    <div class="fm-dc-actions"><button type="button" class="fm-dc-btn fm-dc-primary" data-dev-generate><i class="fas fa-plus" aria-hidden="true"></i> ${esc(T('dc_synthetic_add', 'Add synthetic data'))}</button></div>
    <div class="fm-dc-note" role="status" aria-live="polite" data-dev-results hidden></div>`;
  for (const company of catalog.companies) root.querySelector('[data-dev-company]').append(new Option(company.label, company.id));
  for (const category of catalog.categories) {
    const row = document.createElement('label'); row.className = 'fm-dc-row';
    row.innerHTML = `<i class="fas ${esc(category.icon)}" aria-hidden="true" style="width:16px;color:#667085"></i><span>${esc(category.label)}</span><input type="checkbox" class="fm-dc-switch" role="switch" checked data-dev-category="${esc(category.id)}" aria-label="${esc(category.label)}">`;
    root.querySelector('[data-dev-categories]').append(row);
  }
  const generate = root.querySelector('[data-dev-generate]'), report = root.querySelector('[data-dev-results]');
  let busy = false, requestId = null;
  const update = () => {
    const count = root.querySelectorAll('[data-dev-category]:checked').length;
    root.querySelector('[data-dev-count]').textContent = `· ${count}/${catalog.categories.length}`;
    generate.disabled = busy || !count;
  };
  root.addEventListener('change', update); update();
  generate.onclick = async () => {
    if (busy) return;
    requestId ||= crypto.randomUUID(); busy = true; update();
    report.hidden = false; report.textContent = T('dc_synthetic_adding', 'Adding your sample data…');
    root.querySelectorAll('input,select').forEach((el) => { el.disabled = true; });
    try {
      const result = await dev('/synthetic-data', { method: 'POST', body: {
        company: root.querySelector('[data-dev-company]').value,
        amount: Number(root.querySelector('[data-dev-amount]').value),
        request_id: requestId,
        categories: Object.fromEntries([...root.querySelectorAll('[data-dev-category]')].map((el) => [el.dataset.devCategory, el.checked]))
      } });
      const failed = Object.values(result.results).some((r) => r.status === 'failed');
      if (!failed) requestId = null;
      report.replaceChildren();
      const heading = document.createElement('strong'); heading.textContent = failed ? T('dc_synthetic_attention', 'Some samples need attention') : T('dc_synthetic_added', 'Data added');
      report.append(heading);
      for (const [key, value] of Object.entries(result.results)) {
        const line = document.createElement('div'); if (value.status === 'failed') line.className = 'fm-dc-error';
        const label = catalog.categories.find((c) => c.id === key)?.label || key;
        const count = typeof value.created === 'number' ? value.created : Object.values(value.created || {}).reduce((a, b) => a + Number(b || 0), 0);
        line.textContent = `${label}: ${value.status === 'failed' ? value.error : key === 'communication' ? `${count} emails · ${Number(value.channels?.messages || 0)} channel messages` : `${count} added${value.drafts ? ` · ${value.drafts} drafts` : ''}`}`;
        report.append(line);
      }
      const refresh = document.createElement('button'); refresh.type = 'button'; refresh.className = 'fm-dc-btn'; refresh.style.marginTop = '8px';
      refresh.textContent = T('dc_synthetic_refresh', 'Refresh workspace'); refresh.onclick = () => location.reload();
      report.append(refresh);
      window.dispatchEvent(new CustomEvent('development:synthetic-data', { detail: result }));
    } catch (error) {
      report.textContent = error.message || T('dc_synthetic_failed', 'Could not add sample data. You can retry safely.');
    } finally {
      busy = false; root.querySelectorAll('input,select').forEach((el) => { el.disabled = false; }); update();
    }
  };
}
