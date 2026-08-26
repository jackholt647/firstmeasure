(function(){
  if (!window.Portal) return;

  const cfg = () => window.Portal.cfg || window.PORTAL_CFG || {};
  const esc = (value) => window.Portal.escapeHtml(String(value ?? ''));
  const state = {
    targetEmail: 'mine',
    mode: 'week',
    compare: 'last_week',
    startDate: '',
    endDate: '',
    listId: '',
    activeTab: 'pipeline',
    loading: false,
    loadedOnce: false,
    data: null,
    cache: {},
    prefetching: {},
    requestSeq: 0,
    visibleMetrics: {
      info_sent: true,
      info_received: true,
      sign_ups: true,
      funded_500_plus: true,
      funded_value: true,
      calls_made: true,
      conversations: true
    }
  };

  function caps(){
    return cfg().capabilities || {};
  }

  function canManage(){
    return !!caps().manage_sales_users
      || !!caps().view_all_callers_list_progress
      || !!caps().view_other_callers_detailed_analytics
      || !!caps().view_geographic_list_analytics;
  }

  function api(data){
    return fetch(cfg().endpoints?.server || window.Portal.internalLegacyEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data || {})
    }).then((res) => res.json());
  }

  function ensureDefaultTarget(){
    if (canManage() && state.targetEmail === 'mine') state.targetEmail = '__all__';
  }

  function defaultRangeForMode(mode){
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (mode === 'day') return { startDate: fmt(today), endDate: fmt(today) };
    if (mode === 'month') {
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      return { startDate: fmt(first), endDate: fmt(last) };
    }
    const weekday = today.getDay() || 7;
    const monday = new Date(today);
    monday.setDate(today.getDate() - (weekday - 1));
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return { startDate: fmt(monday), endDate: fmt(sunday) };
  }

  function ensureDateDefaults(){
    if (state.startDate && state.endDate) return;
    const range = defaultRangeForMode(state.mode);
    state.startDate = range.startDate;
    state.endDate = range.endDate;
  }

  function buildPayload(overrides = {}){
    ensureDefaultTarget();
    const mode = overrides.mode || state.mode;
    const compare = overrides.compare || state.compare;
    const targetEmail = overrides.targetEmail || state.targetEmail;
    const listId = Object.prototype.hasOwnProperty.call(overrides, 'listId') ? overrides.listId : state.listId;
    let startDate = Object.prototype.hasOwnProperty.call(overrides, 'startDate') ? overrides.startDate : state.startDate;
    let endDate = Object.prototype.hasOwnProperty.call(overrides, 'endDate') ? overrides.endDate : state.endDate;
    if (!startDate || !endDate) {
      const defaults = defaultRangeForMode(mode);
      startDate = defaults.startDate;
      endDate = defaults.endDate;
    }
    return {
      action: 'lead_analytics',
      target_email: targetEmail,
      mode,
      compare,
      start_date: startDate,
      end_date: endDate,
      list_id: listId,
      viewer_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || ''
    };
  }

  function payload(){
    ensureDateDefaults();
    return buildPayload();
  }

  function cacheKey(params){
    return [
      params.target_email || 'mine',
      params.mode || 'week',
      params.compare || 'last_week',
      params.start_date || '',
      params.end_date || '',
      params.list_id || ''
    ].join('|');
  }

  function getSalesUsers(){
    return Array.isArray(state.data?.sales_users) ? state.data.sales_users : [];
  }

  function getLists(){
    return Array.isArray(state.data?.lists) ? state.data.lists : [];
  }

  function formatMetric(value, currency){
    const n = Number(value || 0);
    if (currency) return `$${Math.round(n).toLocaleString()}`;
    return Math.round(n).toLocaleString();
  }

  function formatPct(value){
    const n = Number(value || 0);
    return `${Math.round(n)}%`;
  }

  function trendClass(trend){
    if (trend === 'up') return 'up';
    if (trend === 'down') return 'down';
    return 'flat';
  }

  function pctClass(value){
    const n = Number(value || 0);
    if (n >= 60) return 'high';
    if (n >= 40) return 'mid';
    return 'low';
  }

  function ensureStyles(){
    if (document.getElementById('crmAnalyticsStyles')) return;
    const style = document.createElement('style');
    style.id = 'crmAnalyticsStyles';
    style.textContent = `
      .analytics-tab{display:grid;gap:20px;color:#1a1f2e}
      .analytics-page-hdr{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}
      .analytics-page-hdr h1{margin:0;font-size:22px;font-weight:900;letter-spacing:-.02em}
      .analytics-page-sub{font-size:12px;color:#8b95a8;font-weight:600;margin-top:4px}
      .analytics-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
      .analytics-refresh-note{font-size:12px;color:#667085;font-weight:700;min-width:88px;text-align:right}
      .analytics-btn,.analytics-input,.analytics-select{font:inherit}
      .analytics-btn{border:1px solid #d4dae6;border-radius:10px;background:#fff;color:#6b7588;padding:10px 13px;font-weight:800;cursor:pointer}
      .analytics-btn:hover{background:#f6f8fb;color:#1a1f2e;border-color:#cbd5e1}
      .analytics-btn:disabled{opacity:.6;cursor:default}
      .analytics-btn.refreshing{background:#d93025;border-color:#d93025;color:#fff;box-shadow:0 0 0 3px rgba(217,48,37,.14)}
      .analytics-filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
      .analytics-select,.analytics-input{padding:8px 12px;border:1px solid #d4dae6;border-radius:8px;background:#fff;color:#4d566b;font-weight:600;min-width:0}
      .analytics-compare{display:flex;align-items:center;gap:6px;padding:6px 12px;border:1px solid #d4dae6;border-radius:8px;background:#fff;font-size:12px;font-weight:700;color:#4d566b}
      .analytics-compare i{color:#1a6bd9}
      .analytics-toggle{display:inline-flex;border:1px solid #d4dae6;border-radius:8px;overflow:hidden;background:#fff}
      .analytics-toggle button{border:none;background:#fff;padding:8px 16px;font-size:12px;font-weight:800;color:#6b7588;cursor:pointer}
      .analytics-toggle button.active{background:#1a1f2e;color:#fff}
      .analytics-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
      .analytics-card{background:#fff;border:1px solid #d4dae6;border-radius:10px;padding:14px}
      .analytics-card-label{font-size:10px;font-weight:900;text-transform:uppercase;color:#8b95a8;letter-spacing:.04em}
      .analytics-card-main{display:flex;align-items:baseline;gap:8px;margin-top:4px}
      .analytics-card-value{font-size:24px;font-weight:900;color:#1a1f2e}
      .analytics-card-prev{font-size:13px;font-weight:600;color:#8b95a8}
      .analytics-card-change{font-size:11px;font-weight:700;margin-top:2px}
      .analytics-card-change.up{color:#1a8a4a}
      .analytics-card-change.down{color:#d93025}
      .analytics-card-change.flat{color:#8b95a8}
      .analytics-card-bar{height:4px;border-radius:3px;background:#edf0f5;margin-top:6px;overflow:hidden}
      .analytics-card-bar-fill{height:100%;border-radius:3px}
      .analytics-section{background:#fff;border:1px solid #d4dae6;border-radius:14px;overflow:hidden}
      .analytics-section-head{padding:14px 20px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;background:#f6f8fb;border-bottom:1px solid #edf0f5}
      .analytics-section-head h2{margin:0;font-size:14px;font-weight:900;text-transform:uppercase;letter-spacing:.04em;color:#6b7588}
      .analytics-section-body{padding:20px}
      .analytics-chip-row{display:flex;gap:4px;flex-wrap:wrap}
      .analytics-chip{border:1px solid #d4dae6;background:#fff;border-radius:999px;padding:4px 10px;font-size:11px;font-weight:700;color:#6b7588;cursor:pointer;display:flex;align-items:center;gap:5px}
      .analytics-chip.active{background:#1a1f2e;color:#fff;border-color:#1a1f2e}
      .analytics-avatar{width:18px;height:18px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-weight:900;font-size:8px;color:#fff}
      .analytics-legend{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:16px}
      .analytics-legend-item{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:700;color:#4d566b;cursor:pointer;padding:3px 8px;border-radius:999px;border:1px solid transparent}
      .analytics-legend-item:hover{background:#f6f8fb}
      .analytics-legend-item.off{opacity:.35}
      .analytics-dot{width:10px;height:10px;border-radius:50%}
      .analytics-chart{position:relative;height:300px;border:1px solid #edf0f5;border-radius:10px;background:#f6f8fb;overflow:hidden}
      .analytics-chart-y{position:absolute;left:0;top:0;bottom:30px;width:44px;display:flex;flex-direction:column;justify-content:space-between;padding:8px 0}
      .analytics-chart-y span{font-size:9px;color:#8b95a8;font-weight:700;text-align:right;padding-right:6px}
      .analytics-chart-x{position:absolute;bottom:0;left:44px;right:0;height:30px;display:flex;justify-content:space-between;align-items:center;padding:0 10px;gap:6px}
      .analytics-chart-x span{font-size:9px;color:#8b95a8;font-weight:700;white-space:nowrap}
      .analytics-chart-grid{position:absolute;top:8px;bottom:30px;left:44px;right:0}
      .analytics-chart-gridline{position:absolute;left:0;right:0;height:1px;background:#edf0f5}
      .analytics-chart-svg{position:absolute;top:8px;bottom:30px;left:44px;right:0}
      .analytics-chart-note{position:absolute;top:12px;right:14px;font-size:10px;color:#8b95a8;font-weight:600;background:rgba(255,255,255,.88);padding:4px 8px;border-radius:4px;border:1px solid #edf0f5}
      .analytics-pacing{display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap;margin-top:12px;padding:10px 14px;background:#e8f0fe;border-radius:8px;font-size:12px;color:#1a6bd9}
      .analytics-pacing strong{color:#1a1f2e}
      .analytics-tabs{display:flex;gap:0;border-bottom:1px solid #d4dae6;margin-bottom:16px}
      .analytics-tab-btn{padding:10px 16px;font-size:13px;font-weight:800;color:#8b95a8;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
      .analytics-tab-btn.active{color:#1a1f2e;border-bottom-color:#d93025}
      .analytics-table-wrap{overflow:auto}
      .analytics-table{width:100%;border-collapse:collapse}
      .analytics-table th{padding:10px 12px;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.04em;color:#8b95a8;border-bottom:2px solid #d4dae6;text-align:left;white-space:nowrap}
      .analytics-table td{padding:10px 12px;border-bottom:1px solid #edf0f5;font-size:13px}
      .analytics-table td.num,.analytics-table th.num{text-align:right;font-variant-numeric:tabular-nums}
      .analytics-table tr:last-child td{border-bottom:none}
      .analytics-table tr:hover td{background:#f6f8fb}
      .analytics-table tr.total td{background:#f6f8fb;font-weight:800;border-top:2px solid #d4dae6}
      .analytics-person{display:flex;align-items:center;gap:8px;font-weight:700}
      .analytics-money{color:#1a8a4a;font-weight:800}
      .analytics-pct{display:inline-flex;align-items:center;padding:2px 6px;border-radius:4px;font-weight:800;font-size:12px}
      .analytics-pct.high{background:#e6f4ec;color:#1a8a4a}
      .analytics-pct.mid{background:#fef3e0;color:#c4700a}
      .analytics-pct.low{background:#fce8e6;color:#d93025}
      .analytics-empty{padding:26px 12px;text-align:center;color:#98a2b3;font-style:italic}
      .analytics-loading{padding:42px 18px;text-align:center;color:#6b7280;font-weight:800}
      .analytics-shell{display:grid;gap:20px}
      .analytics-skeleton{position:relative;overflow:hidden;background:#edf0f5;border-radius:8px}
      .analytics-skeleton::after{content:'';position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,rgba(255,255,255,.65),transparent);animation:analyticsShimmer 1.3s infinite}
      .analytics-skeleton-line{height:12px}
      .analytics-skeleton-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
      .analytics-skeleton-card{background:#fff;border:1px solid #d4dae6;border-radius:10px;padding:14px;display:grid;gap:10px}
      @keyframes analyticsShimmer{100%{transform:translateX(100%)}}
    `;
    document.head.appendChild(style);
  }

  function loadingShell(){
    return `
      <div class="analytics-shell">
        <div class="analytics-page-hdr">
          <div>
            <h1>Analytics</h1>
            <div class="analytics-page-sub">Loading detailed performance data...</div>
          </div>
          <div class="analytics-actions">
            <span class="analytics-refresh-note">Refreshing...</span>
            <button class="analytics-btn refreshing" disabled><i class="fas fa-spinner fa-spin"></i> Refreshing...</button>
          </div>
        </div>
        <div class="analytics-skeleton-grid">
          ${Array.from({ length: 7 }).map(() => `
            <div class="analytics-skeleton-card">
              <div class="analytics-skeleton analytics-skeleton-line" style="width:40%"></div>
              <div class="analytics-skeleton analytics-skeleton-line" style="width:65%;height:24px"></div>
              <div class="analytics-skeleton analytics-skeleton-line" style="width:55%"></div>
            </div>
          `).join('')}
        </div>
        <section class="analytics-section">
          <div class="analytics-section-head">
            <h2>Performance Over Time</h2>
          </div>
          <div class="analytics-section-body">
            <div class="analytics-skeleton" style="height:300px;border-radius:10px"></div>
          </div>
        </section>
      </div>
    `;
  }

  function polyline(values, maxValue, color, dashed){
    if (!Array.isArray(values) || values.length < 2) return '';
    const safeMax = Math.max(1, Number(maxValue || 0));
    const width = 700;
    const height = 270;
    const step = values.length > 1 ? (width - 40) / (values.length - 1) : width - 40;
    const points = values.map((value, index) => {
      const x = 20 + (index * step);
      const y = height - ((Number(value || 0) / safeMax) * (height - 20)) - 10;
      return `${x},${Math.max(8, Math.min(height - 8, y))}`;
    }).join(' ');
    const circles = values.map((value, index) => {
      const x = 20 + (index * step);
      const y = height - ((Number(value || 0) / safeMax) * (height - 20)) - 10;
      return `<circle cx="${x}" cy="${Math.max(8, Math.min(height - 8, y))}" r="${dashed ? 0 : 3.5}" />`;
    }).join('');
    return `
      <polyline fill="none" stroke="${color}" stroke-width="${dashed ? 1.5 : 2.5}" stroke-linecap="round" stroke-linejoin="round" ${dashed ? 'stroke-dasharray="6,6" opacity=".3"' : ''} points="${points}"></polyline>
      ${dashed ? '' : `<g fill="${color}">${circles}</g>`}
    `;
  }

  function renderSummaryCards(){
    const cards = Array.isArray(state.data?.summary_cards) ? state.data.summary_cards : [];
    return cards.map((card) => {
      const previousLabel = card.currency ? formatMetric(card.previous, true) : formatMetric(card.previous, false);
      const currentLabel = card.currency ? formatMetric(card.current, true) : formatMetric(card.current, false);
      const denominator = Math.max(1, Number(card.previous || card.current || 1));
      const fill = Math.max(6, Math.min(100, Math.round((Number(card.current || 0) / denominator) * 100)));
      return `
        <div class="analytics-card">
          <div class="analytics-card-label">${esc(card.label)}</div>
          <div class="analytics-card-main">
            <span class="analytics-card-value">${esc(currentLabel)}</span>
            <span class="analytics-card-prev">vs ${esc(previousLabel)}</span>
          </div>
          <div class="analytics-card-change ${trendClass(card.trend)}">
            <i class="fas ${card.trend === 'up' ? 'fa-arrow-up' : card.trend === 'down' ? 'fa-arrow-down' : 'fa-minus'}"></i>
            ${esc(card.delta_text || '0%')} ${state.data?.compare_label ? `vs ${state.data.compare_label.toLowerCase()}` : ''}
          </div>
          <div class="analytics-card-bar"><div class="analytics-card-bar-fill" style="width:${fill}%;background:${esc(card.color || '#2563eb')}"></div></div>
        </div>
      `;
    }).join('');
  }

  function renderChart(){
    const chart = state.data?.chart || {};
    const labels = Array.isArray(chart.labels) ? chart.labels : [];
    const current = chart.current || {};
    const previous = chart.previous || {};
    const metrics = chart.metrics || {};
    const visibleKeys = Object.keys(state.visibleMetrics).filter((key) => state.visibleMetrics[key] && metrics[key]);
    const maxValue = Math.max(5, Number(chart.max_value || 0));
    const yLabels = [5, 4, 3, 2, 1, 0].map((step) => Math.round((maxValue / 5) * step));
    const legend = visibleKeys.map((key) => `
      <div class="analytics-legend-item" data-toggle-metric="${esc(key)}">
        <div class="analytics-dot" style="background:${esc(metrics[key].color || '#2563eb')}"></div>${esc(metrics[key].label || key)}
      </div>
    `).join('');
    const hiddenLegend = Object.keys(metrics).filter((key) => !state.visibleMetrics[key]).map((key) => `
      <div class="analytics-legend-item off" data-toggle-metric="${esc(key)}">
        <div class="analytics-dot" style="background:${esc(metrics[key].color || '#2563eb')}"></div>${esc(metrics[key].label || key)}
      </div>
    `).join('');
    const lines = visibleKeys.map((key) => polyline(previous[key] || [], maxValue, metrics[key].color, true) + polyline(current[key] || [], maxValue, metrics[key].color, false)).join('');
    const note = state.data?.compare_label ? `<div class="analytics-chart-note"><i class="fas fa-info-circle" style="color:#1a6bd9"></i> Dashed lines = ${esc(state.data.compare_label)}</div>` : '';
    const pacing = state.data?.chart?.pacing_note || {};
    return `
      <div class="analytics-legend">
        ${legend}
        ${hiddenLegend}
        ${state.data?.compare_label ? `<div class="analytics-legend-item" style="margin-left:auto;border:1px solid #d4dae6;background:#f6f8fb"><div class="analytics-dot" style="background:transparent;border:2px dashed #8b95a8"></div>${esc(state.data.compare_label)}</div>` : ''}
      </div>
      <div class="analytics-chart">
        <div class="analytics-chart-y">${yLabels.map((label) => `<span>${esc(label)}</span>`).join('')}</div>
        <div class="analytics-chart-grid">
          ${[0, 20, 40, 60, 80].map((pct) => `<div class="analytics-chart-gridline" style="top:${pct}%"></div>`).join('')}
        </div>
        <svg class="analytics-chart-svg" viewBox="0 0 700 270" preserveAspectRatio="none" style="width:100%;height:100%">${lines}</svg>
        ${note}
        <div class="analytics-chart-x">${labels.map((label) => `<span>${esc(label)}</span>`).join('')}</div>
      </div>
      <div class="analytics-pacing">
        <div><strong>Pacing:</strong> Through ${esc(pacing.through_label || state.endDate || '')} this range: <strong>${esc(String(pacing.current ?? 0))} ${esc(pacing.metric || '')}</strong> vs ${esc(String(pacing.previous ?? 0))} ${esc(pacing.compare_label || 'comparison period')}.</div>
        <div style="font-weight:800">${Number(pacing.current || 0) >= Number(pacing.previous || 0) ? 'Ahead of pace' : 'Below previous pace'}</div>
      </div>
    `;
  }

  function renderPipelineTable(){
    const rows = Array.isArray(state.data?.tables?.pipeline) ? state.data.tables.pipeline : [];
    if (!rows.length) return '<div class="analytics-empty">No pipeline data matched these filters yet.</div>';
    return `
      <div class="analytics-table-wrap">
        <table class="analytics-table">
          <thead>
            <tr>
              <th>Rep</th>
              <th class="num">Leads</th>
              <th class="num">Contacted</th>
              <th class="num">C %</th>
              <th class="num">Info Sent</th>
              <th class="num">S %</th>
              <th class="num">Info Recv</th>
              <th class="num">R %</th>
              <th class="num">Signed Up</th>
              <th class="num">Funded</th>
              <th class="num">Funded $</th>
              <th class="num">10 Orders</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((row) => `
              <tr class="${row.is_total ? 'total' : ''}">
                <td>
                  <div class="analytics-person">
                    <span class="analytics-avatar" style="background:${esc(row.avatar_color || '#6b7588')}">${esc(row.avatar_initials || 'T')}</span>
                    <span>${esc(row.rep_name || 'Unknown')}</span>
                  </div>
                </td>
                <td class="num">${esc(String(row.leads || 0))}</td>
                <td class="num">${esc(String(row.contacted || 0))}</td>
                <td class="num"><span class="analytics-pct ${pctClass(row.contacted_pct)}">${esc(formatPct(row.contacted_pct))}</span></td>
                <td class="num">${esc(String(row.info_sent || 0))}</td>
                <td class="num"><span class="analytics-pct ${pctClass(row.info_sent_pct)}">${esc(formatPct(row.info_sent_pct))}</span></td>
                <td class="num">${esc(String(row.info_received || 0))}</td>
                <td class="num"><span class="analytics-pct ${pctClass(row.info_received_pct)}">${esc(formatPct(row.info_received_pct))}</span></td>
                <td class="num">${esc(String(row.sign_ups || 0))}</td>
                <td class="num">${esc(String(row.funded || 0))}</td>
                <td class="num analytics-money">${esc(formatMetric(row.funded_value, true))}</td>
                <td class="num">${esc(String(row.orders_10 || 0))}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderGeographicTable(){
    const rows = Array.isArray(state.data?.tables?.geographic) ? state.data.tables.geographic : [];
    if (!rows.length) return '<div class="analytics-empty">No geographic data matched these filters yet.</div>';
    return `
      <div class="analytics-table-wrap">
        <table class="analytics-table">
          <thead>
            <tr>
              <th>State</th>
              <th class="num">Leads</th>
              <th class="num">Info Sent</th>
              <th class="num">Info Recv</th>
              <th class="num">Signed Up</th>
              <th class="num">Funded</th>
              <th class="num">Funded $</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((row) => `
              <tr class="${row.is_total ? 'total' : ''}">
                <td><span class="geo-name">${esc(row.label || row.state || 'Unknown')}</span></td>
                <td class="num">${esc(String(row.leads || 0))}</td>
                <td class="num">${esc(String(row.info_sent || 0))}</td>
                <td class="num">${esc(String(row.info_received || 0))}</td>
                <td class="num">${esc(String(row.sign_ups || 0))}</td>
                <td class="num">${esc(String(row.funded || 0))}</td>
                <td class="num analytics-money">${esc(formatMetric(row.funded_value, true))}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderSequenceTable(){
    const rows = Array.isArray(state.data?.tables?.sequences) ? state.data.tables.sequences : [];
    if (!rows.length) return '<div class="analytics-empty">No sequence activity matched this range yet.</div>';
    return `
      <div class="analytics-table-wrap">
        <table class="analytics-table">
          <thead>
            <tr>
              <th>Sequence</th>
              <th class="num">Active</th>
              <th class="num">Completed</th>
              <th class="num">Paused</th>
              <th class="num">Stopped</th>
              <th class="num">Total</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((row) => `
              <tr class="${row.is_total ? 'total' : ''}">
                <td>${esc(row.name || 'Untitled Sequence')}</td>
                <td class="num">${esc(String(row.active || 0))}</td>
                <td class="num">${esc(String(row.completed || 0))}</td>
                <td class="num">${esc(String(row.paused || 0))}</td>
                <td class="num">${esc(String(row.stopped || 0))}</td>
                <td class="num">${esc(String(row.total || 0))}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderVelocityTable(){
    const rows = Array.isArray(state.data?.tables?.velocity) ? state.data.tables.velocity : [];
    if (!rows.length) return '<div class="analytics-empty">Not enough stage history exists yet to calculate velocity.</div>';
    return `
      <div class="analytics-table-wrap">
        <table class="analytics-table">
          <thead>
            <tr>
              <th>Transition</th>
              <th class="num">Avg Days</th>
              <th class="num">Median Days</th>
              <th class="num">Min</th>
              <th class="num">Max</th>
              <th class="num">Count</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((row) => `
              <tr>
                <td>${esc(row.label || 'Transition')}</td>
                <td class="num">${esc(String(row.avg_days ?? 0))}</td>
                <td class="num">${esc(String(row.median_days ?? 0))}</td>
                <td class="num">${esc(String(row.min_days ?? 0))}</td>
                <td class="num">${esc(String(row.max_days ?? 0))}</td>
                <td class="num">${esc(String(row.count ?? 0))}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderDetailTable(){
    if (state.activeTab === 'geo' && canManage()) return renderGeographicTable();
    if (state.activeTab === 'seq') return renderSequenceTable();
    if (state.activeTab === 'velocity') return renderVelocityTable();
    return renderPipelineTable();
  }

  function render(){
    const mount = document.getElementById('analyticsRoot');
    if (!mount) return;
    ensureStyles();
    if (state.loading && !state.loadedOnce) {
      mount.innerHTML = loadingShell();
      return;
    }
    const salesUsers = getSalesUsers();
    const lists = getLists();
    const allRepOption = canManage() ? `<option value="__all__" ${state.targetEmail === '__all__' ? 'selected' : ''}>All Reps</option>` : '';
    const myOption = `<option value="mine" ${state.targetEmail === 'mine' ? 'selected' : ''}>My Analytics</option>`;
    const repOptions = salesUsers.map((user) => {
      const email = String(user.email || '').trim().toLowerCase();
      return `<option value="${esc(email)}" ${state.targetEmail === email ? 'selected' : ''}>${esc(user.name || email)}</option>`;
    }).join('');
    const listOptions = lists.map((list) => `<option value="${esc(String(list.id || ''))}" ${state.listId === String(list.id || '') ? 'selected' : ''}>${esc(list.name || 'Unnamed List')}</option>`).join('');
    const repChips = [
      { key: '__all__', label: 'Team', initials: 'T', color: '#6b7588' },
      ...salesUsers.map((user, index) => ({
        key: String(user.email || '').trim().toLowerCase(),
        label: user.name || user.email || 'Rep',
        initials: String(user.name || user.email || 'R').split(/\s+/).slice(0, 2).map((part) => part.charAt(0).toUpperCase()).join('').slice(0, 2) || 'R',
        color: ['#2563eb','#7c3aed','#dc2626','#059669','#d97706','#4f46e5','#0891b2','#be185d'][index % 8]
      }))
    ];
    const visibleRepKey = canManage() && state.targetEmail === '__all__' ? '__all__' : state.targetEmail;
    mount.innerHTML = `
      <div class="analytics-tab">
        <div class="analytics-page-hdr">
          <div>
            <h1><i class="fas fa-chart-line" style="color:#1a6bd9;margin-right:6px"></i>Analytics</h1>
            <div class="analytics-page-sub">Compare performance, pipeline throughput, and conversion pace against prior periods.</div>
          </div>
          <div class="analytics-actions">
            <span class="analytics-refresh-note">${state.loading ? 'Refreshing...' : ''}</span>
            <button class="analytics-btn ${state.loading ? 'refreshing' : ''}" id="analyticsRefreshBtn" ${state.loading ? 'disabled' : ''}>
              <i class="fas ${state.loading ? 'fa-spinner fa-spin' : 'fa-rotate-right'}"></i> ${state.loading ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
        </div>
        <div class="analytics-filters">
          <div class="analytics-toggle">
            <button type="button" data-analytics-mode="day" class="${state.mode === 'day' ? 'active' : ''}">Day</button>
            <button type="button" data-analytics-mode="week" class="${state.mode === 'week' ? 'active' : ''}">Week</button>
            <button type="button" data-analytics-mode="month" class="${state.mode === 'month' ? 'active' : ''}">Month</button>
          </div>
          <input type="date" id="analyticsStartDate" class="analytics-input" value="${esc(state.startDate)}">
          <span style="color:#8b95a8;font-weight:700;font-size:12px">to</span>
          <input type="date" id="analyticsEndDate" class="analytics-input" value="${esc(state.endDate)}">
          <select id="analyticsRepSelect" class="analytics-select">
            ${allRepOption}
            ${myOption}
            ${repOptions}
          </select>
          <select id="analyticsListSelect" class="analytics-select">
            <option value="">All Lists</option>
            ${listOptions}
          </select>
          <div style="flex:1"></div>
          <div class="analytics-compare">
            <i class="fas fa-exchange-alt"></i>
            <span>Compare to:</span>
            <select id="analyticsCompareSelect" class="analytics-select" style="padding:4px 8px">
              <option value="last_week" ${state.compare === 'last_week' ? 'selected' : ''}>Last Week</option>
              <option value="previous_period" ${state.compare === 'previous_period' ? 'selected' : ''}>Previous Period</option>
              <option value="none" ${state.compare === 'none' ? 'selected' : ''}>None</option>
            </select>
          </div>
        </div>

        <div class="analytics-summary">${renderSummaryCards()}</div>

        <section class="analytics-section">
          <div class="analytics-section-head">
            <h2>Performance Over Time</h2>
            <div class="analytics-chip-row">
              ${repChips.map((rep) => `
                <button type="button" class="analytics-chip ${visibleRepKey === rep.key ? 'active' : ''}" data-analytics-target="${esc(rep.key)}">
                  <span class="analytics-avatar" style="background:${esc(rep.color)}">${esc(rep.initials)}</span>
                  ${esc(rep.label)}
                </button>
              `).join('')}
            </div>
          </div>
          <div class="analytics-section-body">
            ${renderChart()}
          </div>
        </section>

        <section class="analytics-section">
          <div class="analytics-section-head">
            <h2>Detailed Breakdown</h2>
          </div>
          <div class="analytics-section-body">
            <div class="analytics-tabs">
              <div class="analytics-tab-btn ${state.activeTab === 'pipeline' ? 'active' : ''}" data-analytics-tab="pipeline">Pipeline by Rep</div>
              ${canManage() ? `<div class="analytics-tab-btn ${state.activeTab === 'geo' ? 'active' : ''}" data-analytics-tab="geo">Geographic</div>` : ''}
              <div class="analytics-tab-btn ${state.activeTab === 'seq' ? 'active' : ''}" data-analytics-tab="seq">Sequences</div>
              <div class="analytics-tab-btn ${state.activeTab === 'velocity' ? 'active' : ''}" data-analytics-tab="velocity">Velocity</div>
            </div>
            ${renderDetailTable()}
          </div>
        </section>
      </div>
    `;
  }

  async function prefetchModes(){
    const modes = ['day', 'week', 'month'].filter((mode) => mode !== state.mode);
    for (const mode of modes) {
      const range = defaultRangeForMode(mode);
      const params = buildPayload({
        mode,
        startDate: range.startDate,
        endDate: range.endDate
      });
      const key = cacheKey(params);
      if (state.cache[key] || state.prefetching[key]) continue;
      state.prefetching[key] = true;
      try {
        const result = await api(params);
        if (result && result.success) state.cache[key] = result;
      } catch (_) {
      } finally {
        delete state.prefetching[key];
      }
    }
  }

  async function load(options = {}){
    const params = buildPayload();
    const key = cacheKey(params);
    const announce = !!options.announce;
    const silent = !!options.silent;
    const force = !!options.force;
    if (!force && state.cache[key]) {
      state.data = state.cache[key];
      state.loadedOnce = true;
      state.startDate = String(state.data?.filters?.start_date || params.start_date || '');
      state.endDate = String(state.data?.filters?.end_date || params.end_date || '');
      render();
      if (!silent) setTimeout(() => { prefetchModes(); }, 0);
      return state.data;
    }
    const seq = ++state.requestSeq;
    state.loading = true;
    render();
    try {
      const result = await api(params);
      if (!result || !result.success) throw new Error(result?.error || 'Could not load analytics.');
      if (seq !== state.requestSeq) return state.data;
      state.data = result;
      state.cache[key] = result;
      state.loadedOnce = true;
      state.startDate = String(result.filters?.start_date || params.start_date || '');
      state.endDate = String(result.filters?.end_date || params.end_date || '');
      state.listId = String(result.filters?.list_id || params.list_id || '');
      if (announce) setTimeout(() => { prefetchModes(); }, 0);
      else setTimeout(() => { prefetchModes(); }, 0);
      return result;
    } catch (error) {
      if (window.showToast) window.showToast(error?.message || 'Could not load analytics.');
    } finally {
      if (seq === state.requestSeq) {
        state.loading = false;
        render();
      }
    }
  }

  function bindEvents(){
    document.addEventListener('click', async (event) => {
      const refreshBtn = event.target.closest('#analyticsRefreshBtn');
      if (refreshBtn) {
        if (window.showToast) window.showToast('Refreshing analytics...');
        await load();
        return;
      }
      const modeBtn = event.target.closest('[data-analytics-mode]');
      if (modeBtn) {
        const mode = modeBtn.getAttribute('data-analytics-mode');
        if (!mode || mode === state.mode) return;
        state.mode = mode;
        state.startDate = '';
        state.endDate = '';
        ensureDateDefaults();
        await load();
        return;
      }
      const metricToggle = event.target.closest('[data-toggle-metric]');
      if (metricToggle) {
        const key = metricToggle.getAttribute('data-toggle-metric');
        if (!key || !(key in state.visibleMetrics)) return;
        state.visibleMetrics[key] = !state.visibleMetrics[key];
        render();
        return;
      }
      const detailTab = event.target.closest('[data-analytics-tab]');
      if (detailTab) {
        const tab = detailTab.getAttribute('data-analytics-tab') || 'pipeline';
        state.activeTab = tab;
        render();
        return;
      }
      const targetChip = event.target.closest('[data-analytics-target]');
      if (targetChip) {
        const target = targetChip.getAttribute('data-analytics-target') || 'mine';
        if (target === state.targetEmail) return;
        state.targetEmail = target;
        await load();
      }
    });

    document.addEventListener('change', async (event) => {
      const target = event.target;
      if (!target) return;
      if (target.id === 'analyticsRepSelect') {
        state.targetEmail = target.value || 'mine';
        await load();
      } else if (target.id === 'analyticsListSelect') {
        state.listId = target.value || '';
        await load();
      } else if (target.id === 'analyticsCompareSelect') {
        state.compare = target.value || 'last_week';
        await load();
      } else if (target.id === 'analyticsStartDate') {
        state.startDate = target.value || '';
        await load();
      } else if (target.id === 'analyticsEndDate') {
        state.endDate = target.value || '';
        await load();
      }
    });
  }

  window.AnalyticsTab = {
    init(){
      ensureStyles();
      bindEvents();
    },
    async onShow(){
      ensureDefaultTarget();
      ensureDateDefaults();
      await load({ silent: !state.loadedOnce });
    }
  };
})();
