/* public/libraries/apps/smoke/independent-load.js */
(function(){
  const apps = (window.FirstMateAppsManifest?.apps || []).filter((app) => app.enabled !== false);
  const tbody = document.getElementById('results');
  const runButton = document.getElementById('runSmoke');
  const rows = new Map();

  function escapeHtml(value){
    return String(value ?? '').replace(/[&<>"']/g, (match) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[match]));
  }

  function renderRows(){
    tbody.innerHTML = apps.map((app) => `
      <tr data-app-id="${escapeHtml(app.id)}">
        <td><code>${escapeHtml(app.id)}</code><div>${escapeHtml(app.title || '')}</div></td>
        <td>${escapeHtml(app.kind || '')}</td>
        <td>${(app.dependencies || []).map((id) => `<code>${escapeHtml(id)}</code>`).join(', ') || '<span class="pending">none</span>'}</td>
        <td class="status pending">Pending</td>
        <td class="details"></td>
      </tr>
    `).join('');
    tbody.querySelectorAll('tr[data-app-id]').forEach((row) => rows.set(row.dataset.appId, row));
  }

  function setResult(appId, status, details = ''){
    const row = rows.get(appId);
    if (!row) return;
    const statusCell = row.querySelector('.status');
    statusCell.className = `status ${status === 'pass' ? 'pass' : (status === 'fail' ? 'fail' : 'pending')}`;
    statusCell.textContent = status === 'pass' ? 'Pass' : (status === 'fail' ? 'Fail' : 'Running');
    row.querySelector('.details').innerHTML = details ? `<code>${escapeHtml(details).slice(0, 900)}</code>` : '';
  }

  function frameHtml(app){
    const base = new URL('.', window.location.href).href;
    const cacheBust = String(window.__FM_SMOKE_CACHE || Date.now());
    const versioned = (src) => `${src}?smoke_v=${encodeURIComponent(cacheBust)}`;
    return `<!doctype html>
<html><head><base href="${base}"><meta charset="utf-8">
<style>
  html,body,#smokeRoot{height:100%;margin:0}
  body{font-family:Inter,Arial,sans-serif}
  .smoke-left{display:none}
  .fm-app-unavailable{padding:18px;font-weight:900;color:#475467}
</style>
<script>window.__FM_APP_SMOKE_CASE=${JSON.stringify({ id: app.id, cacheBust })};<\/script>
<script src="${versioned('../../app-runtime/firstmate-embeddable-apps.js')}"><\/script>
<script src="${versioned('../../app-runtime/firstmate-app-context.js')}"><\/script>
<script src="${versioned('independent-load-frame.js')}"><\/script>
</head><body>
  <div id="smokeRoot"></div>
  <div id="smokeLeft" class="smoke-left"></div>
  <div id="smokeOverlay"></div>
</body></html>`;
  }

  function runCase(app){
    return new Promise((resolve) => {
      const iframe = document.createElement('iframe');
      const timeout = window.setTimeout(() => {
        iframe.remove();
        resolve({ appId: app.id, ok: false, error: 'Timed out waiting for smoke result.' });
      }, 15000);

      function onMessage(event){
        if (event.source !== iframe.contentWindow) return;
        const data = event.data || {};
        if (data.type !== 'fm-app-smoke-result' || data.appId !== app.id) return;
        window.clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        iframe.remove();
        resolve(data);
      }

      window.addEventListener('message', onMessage);
      document.body.appendChild(iframe);
      iframe.srcdoc = frameHtml(app);
    });
  }

  async function runAll(){
    runButton.disabled = true;
    for (const app of apps) {
      setResult(app.id, 'running');
      const result = await runCase(app);
      setResult(app.id, result.ok ? 'pass' : 'fail', result.ok ? (result.detail || 'mounted') : (result.error || 'failed'));
    }
    runButton.disabled = false;
  }

  renderRows();
  runButton.addEventListener('click', runAll);
  if (new URLSearchParams(window.location.search).get('autorun') === '1') runAll();
})();
