(function(){
  if (!window.Portal) return;

  const esc = (value) => window.Portal.escapeHtml(String(value ?? ''));
  const fmt = new Intl.NumberFormat();
  const money = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const DEFAULT_BONUS_TIERS = [
    { customer_pays: 50, match_percent: 0 },
    { customer_pays: 100, match_percent: 25 },
    { customer_pays: 200, match_percent: 50 }
  ];
  const state = {
    loaded: false,
    loading: false,
    saving: false,
    campaigns: [],
    landingPages: [],
    landingPagesError: '',
    landingPageScan: null,
    report: null,
    selectedCampaignId: 'all',
    startDate: '',
    endDate: '',
    modalCampaign: null,
    activeView: 'overview',
    rawDataset: 'attributions'
  };

  function canAccess(){
    const cfg = window.Portal.cfg || window.PORTAL_CFG || {};
    const perms = cfg.perms || {};
    const user = cfg.user || {};
    return !!(user.is_admin || perms.manage_sales_users || perms.manage_users || perms.manage_company_settings);
  }

  function base(){
    const configured = window.Portal.cfg && window.Portal.cfg.endpoints
      ? (window.Portal.cfg.endpoints.crm_referrals || (String(window.Portal.cfg.endpoints.crm || '').replace(/\/+$/, '') + '/referrals'))
      : '/v1/internal/crm/referrals';
    return String(configured || '/v1/internal/crm/referrals').replace(/\/+$/, '') + '/acquisition';
  }

  async function request(path, options){
    const res = await fetch(base() + path, Object.assign({
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' }
    }, options || {}));
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { ok: false, error: text || 'Request failed.' }; }
    if (!res.ok || data.ok === false || data.success === false) {
      throw new Error(data.message || data.error || `Request failed (${res.status})`);
    }
    return data;
  }

  function defaultDates(){
    const pad = (n) => String(n).padStart(2, '0');
    const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 29);
    if (!state.startDate) state.startDate = fmtDate(start);
    if (!state.endDate) state.endDate = fmtDate(end);
  }

  function ensureStyles(){
    if (document.getElementById('acqCampaignStyles')) return;
    const style = document.createElement('style');
    style.id = 'acqCampaignStyles';
    style.textContent = `
      #view-acquisition-campaigns{min-width:0}
      .acq-shell{display:grid;gap:12px;color:#172033}
      .acq-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      .acq-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:1px solid #d7dce5;background:#fff;color:#344054;border-radius:8px;padding:9px 12px;font-size:12px;font-weight:900;cursor:pointer;white-space:nowrap}
      .acq-btn.primary{background:#d93025;border-color:#d93025;color:#fff}
      .acq-btn.dark{background:#f8fafc;border-color:#d7dce5;color:#344054}
      .acq-btn:disabled{opacity:.55;cursor:default}
      .acq-card{background:#fff;border:1px solid #e3e7ef;border-radius:12px;box-shadow:0 4px 16px rgba(15,23,42,.04);min-width:0}
      .acq-filters{display:flex;gap:10px;align-items:end;flex-wrap:wrap;padding:10px 12px;position:sticky;top:0;z-index:5}
      .acq-field{display:grid;gap:5px;min-width:150px}
      .acq-field label{font-size:10px;font-weight:900;color:#667085;text-transform:uppercase;letter-spacing:.05em}
      .acq-field input,.acq-field select,.acq-field textarea{box-sizing:border-box;width:100%;padding:9px 10px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;font:inherit;font-size:13px}
      .acq-field input[readonly]{background:#f8fafc;color:#475467}
      .acq-copy-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:end}
      .acq-copy-row .acq-field{min-width:0}
      .acq-copy-status{font-size:11px;font-weight:800;color:#067647;min-height:16px}
      .acq-landing-inline{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:end}
      .acq-landing-inline .acq-field{min-width:0}
      .acq-landing-copy-wrap{display:grid;gap:5px;min-width:92px}
      .acq-layout{display:grid;grid-template-columns:290px minmax(0,1fr);gap:16px;align-items:start;min-height:calc(100vh - 150px)}
      .acq-side{display:grid;grid-template-rows:auto minmax(0,1fr);gap:10px;padding:12px;max-height:calc(100vh - 150px);position:sticky;top:70px}
      .acq-side-title{font-size:11px;font-weight:900;color:#667085;text-transform:uppercase;letter-spacing:.05em;padding:0 4px}
      .acq-side-title-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 4px}
      .acq-side-count{font-size:10px;font-weight:900;color:#667085;background:#f2f4f7;border:1px solid #e4e7ec;border-radius:999px;padding:3px 7px;white-space:nowrap}
      .acq-campaign-list{display:grid;align-content:start;gap:8px;min-height:0;overflow:auto}
      .acq-campaign-item{border:1px solid #e5e7eb;background:#fff;border-radius:10px;padding:10px;cursor:pointer;text-align:left;display:grid;gap:7px}
      .acq-campaign-item:hover,.acq-campaign-item.active{border-color:#d93025;box-shadow:0 0 0 3px rgba(217,48,37,.08)}
      .acq-campaign-top{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}
      .acq-campaign-name{font-size:13px;font-weight:900;color:#101828;line-height:1.25}
      .acq-pill{display:inline-flex;align-items:center;border-radius:999px;padding:3px 7px;font-size:10px;font-weight:900;background:#eef2ff;color:#344054;white-space:nowrap}
      .acq-code{font-family:Consolas,monospace;font-size:11px;font-weight:900;color:#475467}
      .acq-mini-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
      .acq-mini-stat{background:#f8fafc;border:1px solid #edf2f7;border-radius:8px;padding:6px}
      .acq-mini-stat b{display:block;font-size:13px;color:#101828}
      .acq-mini-stat span{font-size:9px;text-transform:uppercase;font-weight:900;color:#8a94a6}
      .acq-side-divider{height:1px;background:#edf2f7;margin:4px 0}
      .acq-landing-list{display:grid;gap:7px;max-height:260px;overflow:auto}
      .acq-landing-item{display:grid;gap:4px;border:1px solid #e5e7eb;border-radius:9px;background:#fbfcff;padding:9px;text-align:left;cursor:pointer}
      .acq-landing-item:hover{border-color:#d93025;box-shadow:0 0 0 3px rgba(217,48,37,.07)}
      .acq-landing-name{font-size:12px;font-weight:900;color:#101828;line-height:1.25}
      .acq-landing-path{font-size:11px;font-weight:800;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .acq-main{display:grid;gap:16px;min-width:0}
      .acq-settings-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
      .acq-settings-grid .wide{grid-column:span 2}
      .acq-settings-grid .full{grid-column:1/-1}
      .acq-metrics{display:grid;grid-template-columns:repeat(6,minmax(120px,1fr));gap:10px}
      .acq-metric{padding:13px;border:1px solid #e3e7ef;border-radius:12px;background:#fff}
      .acq-metric span{display:block;font-size:10px;font-weight:900;color:#667085;text-transform:uppercase;letter-spacing:.04em}
      .acq-metric strong{display:block;margin-top:5px;font-size:24px;font-weight:900;color:#101828;letter-spacing:0}
      .acq-metric small{display:block;margin-top:3px;font-size:11px;color:#7b8797;font-weight:700}
      .acq-tabs{display:flex;gap:6px;align-items:center;overflow:auto;border:1px solid #e3e7ef;background:#fff;border-radius:12px;padding:6px;box-shadow:0 4px 16px rgba(15,23,42,.04)}
      .acq-tabs button{display:inline-flex;align-items:center;gap:7px;border:0;background:transparent;color:#667085;border-radius:8px;padding:9px 11px;font-size:12px;font-weight:900;cursor:pointer;white-space:nowrap}
      .acq-tabs button.active{background:#172033;color:#fff}
      .acq-view-card[hidden]{display:none!important}
      .acq-section-head{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;padding:13px 14px;border-bottom:1px solid #edf2f7;background:#f8fafc;border-radius:12px 12px 0 0}
      .acq-section-head h2{margin:0;font-size:12px;font-weight:900;color:#475467;text-transform:uppercase;letter-spacing:.05em}
      .acq-section-body{padding:14px;min-width:0}
      .acq-section-body h3{margin:0 0 8px;font-size:11px;font-weight:900;color:#667085;text-transform:uppercase;letter-spacing:.05em}
      .acq-stack{display:grid;gap:16px}
      .acq-chart{height:280px;position:relative;border:1px solid #edf2f7;border-radius:10px;background:#fbfcff;overflow:hidden}
      .acq-chart svg{width:100%;height:100%;display:block}
      .acq-chart-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#8a94a6;font-size:13px;font-weight:800}
      .acq-legend{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:11px;font-weight:800;color:#667085}
      .acq-dot{width:9px;height:9px;border-radius:50%;display:inline-block;margin-right:4px}
      .acq-grid-2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px}
      .acq-bars{display:grid;grid-template-columns:repeat(24,1fr);gap:3px;height:190px;align-items:end}
      .acq-hour{display:grid;gap:4px;align-items:end;min-width:0}
      .acq-hour-bar{border-radius:5px 5px 0 0;background:#d93025;min-height:2px}
      .acq-hour span{font-size:8px;color:#8a94a6;text-align:center;transform:rotate(-60deg);transform-origin:center top;height:24px}
      .acq-breakdown{display:grid;gap:8px}
      .acq-break-row{display:grid;grid-template-columns:minmax(0,1fr) 80px 80px 80px;gap:10px;align-items:center;font-size:12px}
      .acq-break-label{font-weight:900;color:#1f2937;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .acq-break-bar{height:7px;background:#eef2f7;border-radius:999px;overflow:hidden;grid-column:1/-1}
      .acq-break-fill{height:100%;background:#1f2937;border-radius:999px}
      .acq-table-wrap{overflow:auto}
      .acq-table{width:100%;border-collapse:collapse}
      .acq-table th,.acq-table td{padding:10px 11px;border-bottom:1px solid #edf2f7;text-align:left;font-size:12px;vertical-align:middle}
      .acq-table th{font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#667085;background:#f8fafc}
      .acq-table td.num,.acq-table th.num{text-align:right;font-variant-numeric:tabular-nums}
      .acq-table td{max-width:340px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .acq-bonus-editor{display:grid;gap:8px}
      .acq-bonus-set{display:grid;grid-template-columns:minmax(390px,1fr) max-content;gap:10px;align-items:center;border:1px solid #e3e7ef;border-radius:10px;background:#fbfcff;padding:9px;overflow:hidden}
      .acq-bonus-set-head{display:grid;grid-template-columns:minmax(190px,1fr) 86px auto;gap:7px;align-items:center;min-width:0}
      .acq-bonus-set-head input,.acq-bonus-set-head select{padding:8px 9px;border:1px solid #d0d5dd;border-radius:8px;font:inherit;font-size:12px;background:#fff}
      .acq-bonus-label{min-width:190px}
      .acq-bonus-token{font-family:Consolas,monospace;font-size:10px;font-weight:900;color:#667085;background:#fff;border:1px solid #edf2f7;border-radius:8px;padding:7px 8px;white-space:nowrap;max-width:96px;overflow:hidden;text-overflow:ellipsis}
      .acq-bonus-tiers{display:grid;grid-template-columns:repeat(3,max-content);gap:7px;min-width:0;justify-content:end}
      .acq-bonus-tier{display:grid;grid-template-columns:58px 50px;gap:5px;align-items:end;border:1px solid #edf2f7;border-radius:8px;background:#fff;padding:7px}
      .acq-bonus-tier-title{grid-column:1/-1;font-size:10px;font-weight:900;color:#667085;text-transform:uppercase;letter-spacing:.04em}
      .acq-bonus-tier .acq-field{min-width:0;gap:3px}
      .acq-bonus-tier .acq-field label{font-size:9px}
      .acq-bonus-tier .acq-field input{padding:6px 6px;font-size:12px;text-align:center}
      .acq-bonus-empty{border:1px dashed #cfd6e4;border-radius:10px;padding:12px;background:#fbfcff;color:#667085;font-size:12px;font-weight:800}
      .acq-bonus-stats{display:grid;gap:8px}
      .acq-bonus-stat{display:grid;grid-template-columns:minmax(0,1.2fr) repeat(5, minmax(74px,.5fr));gap:8px;align-items:center;border:1px solid #edf2f7;border-radius:9px;padding:9px;background:#fff;font-size:12px}
      .acq-bonus-stat b{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#101828}
      .acq-bonus-stat span{font-variant-numeric:tabular-nums;color:#475467;font-weight:800;text-align:right}
      .acq-compact-select{border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#344054;font-size:12px;font-weight:800;padding:8px 10px}
      .acq-export-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
      .acq-export-tile{display:grid;gap:5px;text-align:left;border:1px solid #e3e7ef;background:#fff;border-radius:10px;padding:13px;cursor:pointer}
      .acq-export-tile:hover{border-color:#d93025;box-shadow:0 0 0 3px rgba(217,48,37,.07)}
      .acq-export-tile strong{font-size:13px;color:#101828;font-weight:900}
      .acq-export-tile span{font-size:11px;line-height:1.35;color:#667085;font-weight:700}
      .acq-muted{color:#7b8797;font-weight:700}
      .acq-modal-wrap{position:fixed;inset:0;background:rgba(15,23,42,.55);display:none;align-items:center;justify-content:center;z-index:7000;padding:18px}
      .acq-modal-wrap.open{display:flex}
      .acq-modal{width:min(760px,96vw);max-height:92vh;overflow:auto;background:#fff;border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.28)}
      .acq-modal.landing-manager{width:min(980px,96vw)}
      .acq-modal-head,.acq-modal-foot{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:16px 18px;border-bottom:1px solid #edf2f7}
      .acq-modal-foot{border-top:1px solid #edf2f7;border-bottom:none}
      .acq-modal-head h3{margin:0;font-size:18px;font-weight:900}
      .acq-close{border:none;background:transparent;font-size:22px;cursor:pointer;color:#667085}
      .acq-modal-body{padding:18px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
      .acq-modal-body.landing-manager-body{grid-template-columns:minmax(0,1fr);gap:16px}
      .acq-field.full{grid-column:1/-1}
      .acq-manager-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}
      .acq-manager-panel{border:1px solid #e3e7ef;border-radius:12px;background:#fff;overflow:hidden}
      .acq-manager-panel h4{margin:0;padding:11px 12px;border-bottom:1px solid #edf2f7;background:#f8fafc;font-size:11px;font-weight:900;color:#475467;text-transform:uppercase;letter-spacing:.05em}
      .acq-manager-panel-body{display:grid;gap:12px;padding:12px}
      .acq-pair-card{display:grid;gap:6px;border:1px solid #edf2f7;border-radius:10px;padding:10px;background:#fbfcff}
      .acq-pair-card b{font-size:13px;color:#101828}
      .acq-pair-card span{font-size:11px;color:#667085;font-weight:800;word-break:break-all}
      .acq-inline-check{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:900;color:#344054}
      .acq-inline-check input{width:auto}
      .acq-landing-table{max-height:300px;overflow:auto;border:1px solid #edf2f7;border-radius:10px}
      .acq-landing-table table{width:100%;border-collapse:collapse}
      .acq-landing-table th,.acq-landing-table td{padding:9px 10px;border-bottom:1px solid #edf2f7;text-align:left;font-size:12px;vertical-align:middle}
      .acq-landing-table th{position:sticky;top:0;background:#f8fafc;font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#667085;z-index:1}
      .acq-landing-table td.path{font-family:Consolas,monospace;font-size:11px;color:#475467;word-break:break-all}
      .acq-status-line{min-height:18px;font-size:12px;font-weight:800;color:#667085}
      .acq-status-line.error{color:#b42318}
      .acq-status-line.success{color:#067647}
      .acq-help{font-size:12px;color:#667085;font-weight:700}
      @media (max-width:1200px){.acq-layout{grid-template-columns:1fr}.acq-metrics{grid-template-columns:repeat(3,1fr)}.acq-settings-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.acq-export-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
      @media (max-width:900px){.acq-bonus-set{grid-template-columns:1fr}.acq-bonus-tiers{grid-template-columns:repeat(3,max-content);justify-content:start}}
      @media (max-width:760px){.acq-metrics,.acq-grid-2,.acq-settings-grid,.acq-export-grid,.acq-manager-grid,.acq-bonus-tiers{grid-template-columns:1fr}.acq-settings-grid .wide{grid-column:1}.acq-modal-body{grid-template-columns:1fr}.acq-filters{align-items:stretch}.acq-field{min-width:100%}.acq-bonus-tier .acq-field{min-width:0}.acq-bonus-set-head{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }

  function ensureMarkup(){
    const host = document.getElementById('portalPluginViews');
    if (!host || document.getElementById('view-acquisition-campaigns')) return;
    const view = document.createElement('div');
    view.id = 'view-acquisition-campaigns';
    view.style.display = 'none';
    view.innerHTML = `
      <div class="acq-shell">
        <div class="acq-card acq-filters">
          <div class="acq-field" style="min-width:260px;">
            <label>Campaign</label>
            <select id="acqCampaignSelect"></select>
          </div>
          <div class="acq-field">
            <label>Start</label>
            <input type="date" id="acqStartDate">
          </div>
          <div class="acq-field">
            <label>End</label>
            <input type="date" id="acqEndDate">
          </div>
          <button class="acq-btn" id="acqLast7Btn"><i class="fas fa-calendar-week"></i> 7 Days</button>
          <button class="acq-btn" id="acqLast30Btn"><i class="fas fa-calendar-days"></i> 30 Days</button>
          <button class="acq-btn" id="acqApplyBtn"><i class="fas fa-chart-line"></i> Apply</button>
          <button class="acq-btn" data-csv-export="all"><i class="fas fa-download"></i> Export All CSV</button>
          <button class="acq-btn primary" id="acqNewCampaignBtn"><i class="fas fa-plus"></i> New Campaign</button>
        </div>
        <div class="acq-layout">
          <div class="acq-card acq-side">
            <div class="acq-side-title">Campaigns</div>
            <div class="acq-campaign-list" id="acqCampaignList"></div>
          </div>
          <div class="acq-main">
            <div class="acq-card" id="acqCampaignSettings"></div>
            <div class="acq-metrics" id="acqMetrics"></div>
            <div class="acq-tabs" id="acqViewTabs">
              <button class="active" data-acq-view="overview"><i class="fas fa-gauge-high"></i> Overview</button>
              <button data-acq-view="trends"><i class="fas fa-chart-line"></i> Trends</button>
              <button data-acq-view="breakdowns"><i class="fas fa-chart-pie"></i> Breakdowns</button>
              <button data-acq-view="signups"><i class="fas fa-user-plus"></i> Signups</button>
              <button data-acq-view="raw"><i class="fas fa-table"></i> Raw Data</button>
              <button data-acq-view="exports"><i class="fas fa-file-csv"></i> Exports</button>
            </div>
            <div class="acq-card acq-view-card" data-views="overview trends">
              <div class="acq-section-head">
                <h2>Trend Over Time</h2>
                <div class="acq-legend">
                  <span><i class="acq-dot" style="background:#d93025"></i>Views</span>
                  <span><i class="acq-dot" style="background:#f59e0b"></i>Unique</span>
                  <span><i class="acq-dot" style="background:#1a73e8"></i>Signups</span>
                  <span><i class="acq-dot" style="background:#16a34a"></i>Spend</span>
                </div>
              </div>
              <div class="acq-section-body"><div class="acq-chart" id="acqTrendChart"></div></div>
            </div>
            <div class="acq-grid-2">
              <div class="acq-card acq-view-card" data-views="overview trends">
                <div class="acq-section-head"><h2>Time Of Day</h2></div>
                <div class="acq-section-body"><div class="acq-bars" id="acqHourlyBars"></div></div>
              </div>
              <div class="acq-card acq-view-card" data-views="overview breakdowns">
                <div class="acq-section-head"><h2>Sources</h2></div>
                <div class="acq-section-body"><div class="acq-breakdown" id="acqSourceBreakdown"></div></div>
              </div>
            </div>
            <div class="acq-grid-2 acq-view-card" data-views="breakdowns">
              <div class="acq-card">
                <div class="acq-section-head"><h2>Device + Browser</h2></div>
                <div class="acq-section-body acq-stack">
                  <h3>Devices</h3><div class="acq-breakdown" id="acqDeviceBreakdown"></div>
                  <h3>Browsers</h3><div class="acq-breakdown" id="acqBrowserBreakdown"></div>
                </div>
              </div>
              <div class="acq-card">
                <div class="acq-section-head"><h2>Geo + Locale</h2></div>
                <div class="acq-section-body acq-stack">
                  <h3>Countries</h3><div class="acq-breakdown" id="acqCountryBreakdown"></div>
                  <h3>Cities</h3><div class="acq-breakdown" id="acqCityBreakdown"></div>
                  <h3>Languages</h3><div class="acq-breakdown" id="acqLanguageBreakdown"></div>
                </div>
              </div>
            </div>
            <div class="acq-card acq-view-card" data-views="signups">
              <div class="acq-section-head"><h2>Recent Signups</h2></div>
              <div class="acq-table-wrap"><table class="acq-table"><thead><tr><th>Signup</th><th>Campaign</th><th>Organization</th><th class="num">Spend</th><th>Source</th></tr></thead><tbody id="acqSignupRows"></tbody></table></div>
            </div>
            <div class="acq-card acq-view-card" data-views="raw">
              <div class="acq-section-head">
                <h2>Raw Source Data</h2>
                <div class="acq-actions">
                  <select id="acqRawDatasetSelect" class="acq-compact-select">
                    <option value="attributions">All Attribution Rows</option>
                    <option value="signups">Signup Rows</option>
                    <option value="spend_ledger">Spend Ledger</option>
                    <option value="events">Event Rows</option>
                    <option value="campaigns">Campaign Rows</option>
                    <option value="bonus_offers">Bonus Offer Stats</option>
                  </select>
                  <button class="acq-btn" data-csv-export="current_raw"><i class="fas fa-download"></i> Download Current CSV</button>
                </div>
              </div>
              <div class="acq-table-wrap"><table class="acq-table" id="acqRawTable"></table></div>
            </div>
            <div class="acq-card acq-view-card" data-views="exports">
              <div class="acq-section-head"><h2>CSV Exports</h2></div>
              <div class="acq-section-body">
                <div class="acq-export-grid">
                  <button class="acq-export-tile" data-csv-export="daily"><strong>Daily Trend</strong><span>Views, signups, spend, and order counts by day.</span></button>
                  <button class="acq-export-tile" data-csv-export="hourly"><strong>Hourly Trend</strong><span>Activity and spend by hour of day.</span></button>
                  <button class="acq-export-tile" data-csv-export="sources"><strong>Sources</strong><span>Source-level total views, unique visitors, and signups.</span></button>
                  <button class="acq-export-tile" data-csv-export="attributions"><strong>Attribution Rows</strong><span>Raw landing views and signup attribution metadata.</span></button>
                  <button class="acq-export-tile" data-csv-export="signups"><strong>Signup Rows</strong><span>Signed-up organizations with spend and metadata.</span></button>
                  <button class="acq-export-tile" data-csv-export="spend_ledger"><strong>Spend Ledger</strong><span>Underlying order/spend ledger entries for attributed orgs.</span></button>
                  <button class="acq-export-tile" data-csv-export="events"><strong>Event Rows</strong><span>Tracked campaign events.</span></button>
                  <button class="acq-export-tile" data-csv-export="bonus_offers"><strong>Bonus Offers</strong><span>Views, signups, spend, and conversion by assigned offer set.</span></button>
                  <button class="acq-export-tile" data-csv-export="all"><strong>All CSVs</strong><span>Download every available dataset as separate files.</span></button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    host.appendChild(view);

    const modal = document.createElement('div');
    modal.id = 'acqCampaignModal';
    modal.className = 'acq-modal-wrap';
    modal.innerHTML = `
      <div class="acq-modal">
        <div class="acq-modal-head">
          <h3 id="acqModalTitle">New Campaign</h3>
          <button class="acq-close" id="acqModalCloseBtn">&times;</button>
        </div>
        <div class="acq-modal-body">
          <div class="acq-field">
            <label>Name</label>
            <input id="acqNameInput" placeholder="Facebook Roof Measurements - June">
          </div>
          <div class="acq-field">
            <label>Campaign Code</label>
            <input id="acqCodeInput" placeholder="fb-roof-measurements-june">
          </div>
          <div class="acq-field">
            <label>Channel</label>
            <input id="acqChannelInput" placeholder="facebook">
          </div>
          <div class="acq-field">
            <label>Status</label>
            <select id="acqStatusInput"><option value="active">Active</option><option value="inactive">Inactive</option><option value="archived">Archived</option></select>
          </div>
          <div class="acq-field full">
            <label>Landing Page</label>
            <select id="acqLandingInput"></select>
          </div>
        </div>
        <div class="acq-modal-foot">
          <div class="acq-help" id="acqModalHelp">Landing pages are discovered from public/portal/landing.</div>
          <div class="acq-actions">
            <button class="acq-btn" id="acqModalCancelBtn">Cancel</button>
            <button class="acq-btn primary" id="acqModalSaveBtn"><i class="fas fa-save"></i> Save Campaign</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const landingModal = document.createElement('div');
    landingModal.id = 'acqLandingManagerModal';
    landingModal.className = 'acq-modal-wrap';
    landingModal.innerHTML = `
      <div class="acq-modal landing-manager">
        <div class="acq-modal-head">
          <div>
            <h3>Landing Page Manager</h3>
            <div class="acq-help" id="acqLandingManagerCampaign"></div>
          </div>
          <button class="acq-close" id="acqLandingManagerCloseBtn">&times;</button>
        </div>
        <div class="acq-modal-body landing-manager-body">
          <div class="acq-manager-grid">
            <div class="acq-manager-panel">
              <h4>Campaign Pairing</h4>
              <div class="acq-manager-panel-body">
                <div class="acq-pair-card" id="acqCurrentLandingSummary"></div>
                <div class="acq-field">
                  <label>Pair Campaign To</label>
                  <select id="acqManagerPairLandingInput"></select>
                </div>
                <div class="acq-actions">
                  <button class="acq-btn" id="acqManagerSavePairBtn"><i class="fas fa-link"></i> Save Pairing</button>
                </div>
              </div>
            </div>
            <div class="acq-manager-panel">
              <h4>Clone Landing Page</h4>
              <div class="acq-manager-panel-body">
                <div class="acq-field">
                  <label>Copy From</label>
                  <select id="acqCloneSourceInput"></select>
                </div>
                <div class="acq-field">
                  <label>New Page Slug</label>
                  <input id="acqCloneSlugInput" placeholder="facebook-summer-roof-measurements">
                </div>
                <div class="acq-field">
                  <label>Will Create</label>
                  <input id="acqCloneUrlPreview" readonly>
                </div>
                <label class="acq-inline-check">
                  <input type="checkbox" id="acqClonePairAfterInput" checked>
                  Pair cloned page to this campaign
                </label>
                <button class="acq-btn primary" id="acqManagerCloneBtn"><i class="fas fa-copy"></i> Clone Page</button>
              </div>
            </div>
          </div>
          <div class="acq-manager-panel">
            <h4>Detected Landing Pages</h4>
            <div class="acq-manager-panel-body">
              <div class="acq-status-line" id="acqLandingManagerStatus"></div>
              <div class="acq-landing-table" id="acqLandingManagerTable"></div>
            </div>
          </div>
        </div>
        <div class="acq-modal-foot">
          <div class="acq-help" id="acqLandingManagerRoot"></div>
          <div class="acq-actions">
            <button class="acq-btn" id="acqLandingManagerDoneBtn">Done</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(landingModal);
  }

  function metric(label, value, sub){
    return `<div class="acq-metric"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(sub || '')}</small></div>`;
  }

  function renderAll(){
    renderCampaignControls();
    renderCampaignList();
    renderCampaignSettings();
    renderReport();
  }

  function renderCampaignControls(){
    const select = document.getElementById('acqCampaignSelect');
    if (!select) return;
    if (state.selectedCampaignId !== 'all' && !state.campaigns.some(c => String(c.id) === String(state.selectedCampaignId))) {
      state.selectedCampaignId = 'all';
    }
    select.innerHTML = `<option value="all">All acquisition campaigns</option>` + state.campaigns.map(c => `<option value="${esc(c.id)}">${esc(c.display_name || c.id)}</option>`).join('');
    select.value = state.selectedCampaignId;
    document.getElementById('acqStartDate').value = state.startDate;
    document.getElementById('acqEndDate').value = state.endDate;
  }

  function selectedCampaign(){
    return state.campaigns.find(item => String(item.id) === String(state.selectedCampaignId)) || null;
  }

  function campaignStats(id){
    return (state.report?.campaign_breakdown || []).find(row => String(row.id) === String(id)) || {};
  }

  function renderCampaignList(){
    const el = document.getElementById('acqCampaignList');
    if (!el) return;
    if (state.loading && !state.campaigns.length) {
      el.innerHTML = `<div class="acq-muted" style="padding:10px;">Loading campaigns...</div>`;
      return;
    }
    if (!state.campaigns.length) {
      el.innerHTML = `<div class="acq-muted" style="padding:10px;">No campaigns yet. Create one to start tracking.</div>`;
      return;
    }
    el.innerHTML = state.campaigns.map(c => {
      const code = c.primary_code || {};
      const stats = campaignStats(c.id);
      return `
        <button class="acq-campaign-item ${state.selectedCampaignId === String(c.id) ? 'active' : ''}" data-campaign-id="${esc(c.id)}">
          <div class="acq-campaign-top">
            <div class="acq-campaign-name">${esc(c.display_name || c.id)}</div>
            <span class="acq-pill">${esc(c.status || 'active')}</span>
          </div>
          <div class="acq-code">${esc(code.code || '')}</div>
          <div class="acq-muted" style="font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(c.landing_page || 'No landing page paired')}</div>
          <div class="acq-mini-stats">
            <div class="acq-mini-stat"><b>${fmt.format(Number(stats.views || 0))}</b><span>Views</span></div>
            <div class="acq-mini-stat"><b>${fmt.format(Number(stats.unique_visitors || 0))}</b><span>Unique</span></div>
            <div class="acq-mini-stat"><b>${fmt.format(Number(stats.signups || 0))}</b><span>Signups</span></div>
            <div class="acq-mini-stat"><b>${money.format(Number(stats.spend || 0))}</b><span>Spend</span></div>
          </div>
        </button>
      `;
    }).join('');
  }

  function renderLandingInventory(){
    const list = document.getElementById('acqLandingInventory');
    const count = document.getElementById('acqLandingCount');
    if (count) count.textContent = `${state.landingPages.length} found`;
    if (!list) return;
    if (!state.landingPages.length) {
      const checked = Array.isArray(state.landingPageScan?.searched_roots) ? state.landingPageScan.searched_roots.length : 0;
      list.innerHTML = `<div class="acq-muted" style="padding:8px;">${esc(state.landingPagesError || `No landing pages found${checked ? ` after checking ${checked} folders` : ''}.`)}</div>`;
      return;
    }
    list.innerHTML = state.landingPages.map(page => `
      <button class="acq-landing-item" data-landing-url="${esc(page.url_path)}">
        <span class="acq-landing-name">${esc(page.label || page.variant || page.id)}</span>
        <span class="acq-landing-path">${esc(page.url_path || page.path || '')}</span>
      </button>
    `).join('');
  }

  function landingOptionsHtml(selected){
    return '<option value="">No landing page selected</option>' + state.landingPages.map(page => {
      const value = page.url_path || '';
      const selectedAttr = String(value) === String(selected || '') ? ' selected' : '';
      return `<option value="${esc(value)}" data-variant="${esc(page.variant)}"${selectedAttr}>${esc(page.label)} - ${esc(value)}</option>`;
    }).join('');
  }

  function campaignLandingUrl(landingPath, campaignCode){
    const path = String(landingPath || '').trim();
    if (!path) return '';
    const url = new URL(path, 'https://app.1m8.ai');
    const code = String(campaignCode || '').trim();
    if (code) url.searchParams.set('cid', code);
    return url.toString();
  }

  function currentSettingsLandingUrl(){
    const campaign = selectedCampaign();
    const landing = document.getElementById('acqSettingsLandingInput')?.value || campaign?.landing_page || '';
    const code = document.getElementById('acqSettingsCodeInput')?.value || campaign?.primary_code?.code || '';
    return campaignLandingUrl(landing, code);
  }

  function updateSettingsLandingUrl(){
    const status = document.getElementById('acqSettingsLandingCopyStatus');
    if (status) status.textContent = '';
  }

  async function copyText(value){
    const text = String(value || '');
    if (!text) return false;
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  }

  function bonusSetsForCampaign(campaign){
    const sets = campaign?.metadata?.bonus_offer_sets || {};
    if (Array.isArray(sets)) return sets;
    return Object.values(sets || {});
  }

  function renderBonusOfferEditor(campaign){
    const sets = bonusSetsForCampaign(campaign);
    const stats = state.report?.bonus_offers || [];
    const body = sets.length ? sets.map((set, index) => renderBonusSet(set, index, stats)).join('') : `
      <div class="acq-bonus-empty">No bonus offer sets yet. Add one set to start split testing campaign load offers.</div>
    `;
    return `
      <div class="acq-actions">
        <button class="acq-btn" type="button" data-bonus-add-set><i class="fas fa-plus"></i> Add Offer Set</button>
      </div>
      ${body}
      ${renderBonusStats(stats)}
    `;
  }

  function renderBonusSet(set, index, stats){
    const token = String(set.token || '');
    const tiers = normalizedBonusTiersForEditor(set.tiers);
    return `
      <div class="acq-bonus-set" data-bonus-set data-token="${esc(token)}">
        <div class="acq-bonus-set-head">
          <input class="acq-bonus-label" data-bonus-label value="${esc(set.label || `Offer Set ${index + 1}`)}" placeholder="Offer set name">
          <select data-bonus-status>
            <option value="active"${String(set.status || 'active') === 'active' ? ' selected' : ''}>Active</option>
            <option value="inactive"${String(set.status || '') === 'inactive' ? ' selected' : ''}>Inactive</option>
            <option value="archived"${String(set.status || '') === 'archived' ? ' selected' : ''}>Archived</option>
          </select>
          <div class="acq-actions">
            <span class="acq-bonus-token" title="Opaque URL token">${esc(token || 'auto token')}</span>
            <button class="acq-btn" type="button" data-bonus-remove-set><i class="fas fa-trash"></i></button>
          </div>
        </div>
        <div class="acq-bonus-tiers">
          ${tiers.map((tier, tierIndex) => renderBonusTier(tier, tierIndex)).join('')}
        </div>
      </div>
    `;
  }

  function normalizedBonusTiersForEditor(tiers){
    const provided = (Array.isArray(tiers) ? tiers : [])
      .map((tier) => ({
        customer_pays: Math.max(0, Math.round(Number(tier.customer_pays || tier.threshold || tier.amount || 0))),
        match_percent: Math.max(0, Number(tier.match_percent ?? tier.match ?? tier.percent ?? 0))
      }))
      .filter((tier) => tier.customer_pays > 0)
      .sort((a, b) => a.customer_pays - b.customer_pays)
      .slice(0, 3);
    return DEFAULT_BONUS_TIERS.map((fallback, index) => {
      const tier = provided[index] || fallback;
      return {
        id: `tier_${index + 1}`,
        customer_pays: tier.customer_pays,
        threshold: tier.customer_pays,
        match_percent: tier.match_percent
      };
    });
  }

  function renderBonusTier(tier, index){
    return `
      <div class="acq-bonus-tier" data-bonus-tier>
        <div class="acq-bonus-tier-title">Option ${index + 1}</div>
        <div class="acq-field">
          <label>Load</label>
          <input data-bonus-threshold inputmode="numeric" value="${esc(tier.customer_pays || tier.threshold || tier.amount || '')}" placeholder="100">
        </div>
        <div class="acq-field">
          <label>Match %</label>
          <input data-bonus-match inputmode="decimal" value="${esc(tier.match_percent ?? tier.match ?? tier.percent ?? 0)}" placeholder="50">
        </div>
      </div>
    `;
  }

  function renderBonusStats(stats){
    const rows = (Array.isArray(stats) ? stats : []).filter(row => !selectedCampaign() || String(row.campaign_id) === String(selectedCampaign()?.id));
    if (!rows.length) return `<div class="acq-help">Stats will appear here after landing-page visits receive a bonus offer assignment.</div>`;
    return `
      <div class="acq-bonus-stats">
        ${rows.map(row => `
          <div class="acq-bonus-stat">
            <b title="${esc(row.label || row.token)}">${esc(row.label || row.token)}</b>
            <span>${fmt.format(Number(row.views || 0))} views</span>
            <span>${fmt.format(Number(row.unique_visitors || 0))} unique</span>
            <span>${fmt.format(Number(row.signups || 0))} signups</span>
            <span>${pct(row.conversion_rate)}</span>
            <span>${money.format(Number(row.spend || 0))}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  function addBonusSet(){
    const editor = document.getElementById('acqBonusOfferEditor');
    if (!editor) return;
    const placeholder = editor.querySelector('.acq-bonus-empty');
    if (placeholder) placeholder.remove();
    const count = editor.querySelectorAll('[data-bonus-set]').length + 1;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderBonusSet({ label: `Offer Set ${count}`, status: 'active', tiers: DEFAULT_BONUS_TIERS }, count - 1, []);
    const firstStats = editor.querySelector('.acq-help,.acq-bonus-stats');
    editor.insertBefore(wrapper.firstElementChild, firstStats || null);
  }

  function collectBonusOfferSets(){
    const editor = document.getElementById('acqBonusOfferEditor');
    if (!editor) return [];
    return Array.from(editor.querySelectorAll('[data-bonus-set]')).map((setEl, index) => {
      const label = setEl.querySelector('[data-bonus-label]')?.value || `Offer Set ${index + 1}`;
      const token = setEl.getAttribute('data-token') || '';
      const tiers = normalizedBonusTiersForEditor(Array.from(setEl.querySelectorAll('[data-bonus-tier]')).map((tierEl) => {
        const threshold = Math.max(0, Math.round(Number(tierEl.querySelector('[data-bonus-threshold]')?.value || 0)));
        const match = Math.max(0, Number(tierEl.querySelector('[data-bonus-match]')?.value || 0));
        return { customer_pays: threshold, threshold, match_percent: match };
      }));
      return {
        id: slugify(label) || `offer-set-${index + 1}`,
        token,
        label,
        status: setEl.querySelector('[data-bonus-status]')?.value || 'active',
        tiers
      };
    }).filter(set => set.tiers.length);
  }

  function renderCampaignSettings(){
    const el = document.getElementById('acqCampaignSettings');
    if (!el) return;
    const campaign = selectedCampaign();
    if (!campaign) {
      el.innerHTML = `
        <div class="acq-section-head">
          <h2>Campaign Settings</h2>
          <button class="acq-btn primary" id="acqSettingsNewBtn"><i class="fas fa-plus"></i> New Campaign</button>
        </div>
        <div class="acq-section-body">
          <div class="acq-muted">Select a campaign to edit its code, channel, status, landing page, and bonus offers.</div>
        </div>
      `;
      return;
    }
    const code = campaign.primary_code || {};
    el.innerHTML = `
      <div class="acq-section-head">
        <h2>Campaign Settings</h2>
        <div class="acq-actions">
          <button class="acq-btn" id="acqSettingsLandingManagerBtn"><i class="fas fa-copy"></i> Manage Landing Pages</button>
          <button class="acq-btn primary" id="acqSettingsSaveBtn"><i class="fas fa-save"></i> Save Changes</button>
        </div>
      </div>
      <div class="acq-section-body">
        <div class="acq-settings-grid">
          <div class="acq-field wide">
            <label>Name</label>
            <input id="acqSettingsNameInput" value="${esc(campaign.display_name || '')}">
          </div>
          <div class="acq-field">
            <label>Campaign Code</label>
            <input id="acqSettingsCodeInput" value="${esc(code.code || '')}" placeholder="auto-generated-if-blank">
          </div>
          <div class="acq-field">
            <label>Status</label>
            <select id="acqSettingsStatusInput">
              <option value="active"${String(campaign.status || 'active') === 'active' ? ' selected' : ''}>Active</option>
              <option value="inactive"${String(campaign.status || '') === 'inactive' ? ' selected' : ''}>Inactive</option>
              <option value="archived"${String(campaign.status || '') === 'archived' ? ' selected' : ''}>Archived</option>
            </select>
          </div>
          <div class="acq-field">
            <label>Channel</label>
            <input id="acqSettingsChannelInput" value="${esc(campaign.campaign_type || campaign.metadata?.channel || '')}" placeholder="facebook">
          </div>
          <div class="acq-landing-inline wide">
            <div class="acq-field">
              <label>Landing Page</label>
              <select id="acqSettingsLandingInput">${landingOptionsHtml(campaign.landing_page || '')}</select>
            </div>
            <div class="acq-landing-copy-wrap">
              <button class="acq-btn" id="acqCopyLandingUrlBtn" type="button"><i class="fas fa-copy"></i> Copy Link</button>
              <div class="acq-copy-status" id="acqSettingsLandingCopyStatus"></div>
            </div>
          </div>
          <div class="acq-field full">
            <label>Bonus Offer Options</label>
            <div class="acq-bonus-editor" id="acqBonusOfferEditor">
              ${renderBonusOfferEditor(campaign)}
            </div>
          </div>
        </div>
        <div class="acq-help" style="margin-top:10px;">Leave code blank when creating a campaign to auto-generate it. Editing an existing code changes future attribution links if the new code is unused.</div>
      </div>
    `;
  }

  function renderReport(){
    const summary = state.report?.summary || {};
    const metrics = document.getElementById('acqMetrics');
    if (metrics) {
      metrics.innerHTML = [
        metric('Views', fmt.format(Number(summary.views || 0)), 'Tracked landing visits'),
        metric('Unique', fmt.format(Number(summary.unique_visitors || 0)), 'Deduped visitors by IP'),
        metric('Signups', fmt.format(Number(summary.signups || 0)), 'Completed organizations'),
        metric('Conversion', pct(summary.conversion_rate), 'Signup / unique visitor'),
        metric('Spend', money.format(Number(summary.spend || 0)), 'Negative credit ledger spend'),
        metric('Repeat', fmt.format(Number(summary.repeat_views || 0)), 'Refreshes and repeat visits')
      ].join('');
    }
    renderTrendChart();
    renderHourly();
    renderBreakdowns();
    renderTables();
    renderRawData();
    renderViewState();
  }

  function pct(value){
    const n = Number(value || 0) * 100;
    return `${n.toFixed(n >= 10 ? 0 : 1)}%`;
  }

  function renderTrendChart(){
    const el = document.getElementById('acqTrendChart');
    if (!el) return;
    const rows = state.report?.daily || [];
    if (!rows.length) {
      el.innerHTML = '<div class="acq-chart-empty">No daily data in this range.</div>';
      return;
    }
    const width = 1000;
    const height = 280;
    const pad = { l: 42, r: 18, t: 22, b: 34 };
    const innerW = width - pad.l - pad.r;
    const innerH = height - pad.t - pad.b;
    const maxCount = Math.max(1, ...rows.map(r => Math.max(Number(r.views || 0), Number(r.unique_visitors || 0), Number(r.signups || 0))));
    const maxSpend = Math.max(1, ...rows.map(r => Number(r.spend || 0)));
    const x = (i) => pad.l + (rows.length === 1 ? innerW / 2 : (i / (rows.length - 1)) * innerW);
    const yCount = (v) => pad.t + innerH - (Number(v || 0) / maxCount) * innerH;
    const ySpend = (v) => pad.t + innerH - (Number(v || 0) / maxSpend) * innerH;
    const line = (field, yFn) => rows.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${yFn(r[field]).toFixed(1)}`).join(' ');
    const area = (field, yFn) => `${rows.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${yFn(r[field]).toFixed(1)}`).join(' ')} L${x(rows.length - 1).toFixed(1)},${pad.t + innerH} L${x(0).toFixed(1)},${pad.t + innerH} Z`;
    const ticks = rows.filter((_, i) => i === 0 || i === rows.length - 1 || i % Math.ceil(rows.length / 6) === 0);
    el.innerHTML = `
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Campaign trend chart">
        <rect x="0" y="0" width="${width}" height="${height}" fill="#fbfcff"></rect>
        ${[0,.25,.5,.75,1].map(t => `<line x1="${pad.l}" x2="${width-pad.r}" y1="${pad.t + innerH*t}" y2="${pad.t + innerH*t}" stroke="#e8edf5" stroke-width="1"/>`).join('')}
        <path d="${area('views', yCount)}" fill="rgba(217,48,37,.09)"></path>
        <path d="${line('views', yCount)}" fill="none" stroke="#d93025" stroke-width="3"></path>
        <path d="${line('unique_visitors', yCount)}" fill="none" stroke="#f59e0b" stroke-width="3"></path>
        <path d="${line('signups', yCount)}" fill="none" stroke="#1a73e8" stroke-width="3"></path>
        <path d="${line('spend', ySpend)}" fill="none" stroke="#16a34a" stroke-width="3"></path>
        ${ticks.map(r => `<text x="${x(rows.indexOf(r)).toFixed(1)}" y="${height-10}" text-anchor="middle" font-size="10" fill="#667085">${esc(String(r.date || '').slice(5))}</text>`).join('')}
      </svg>
    `;
  }

  function renderHourly(){
    const el = document.getElementById('acqHourlyBars');
    if (!el) return;
    const rows = state.report?.hourly || [];
    const max = Math.max(1, ...rows.map(r => Math.max(Number(r.views || 0), Number(r.unique_visitors || 0), Number(r.signups || 0))));
    el.innerHTML = rows.map(r => {
      const value = Math.max(Number(r.views || 0), Number(r.signups || 0));
      const h = Math.max(2, Math.round((value / max) * 160));
      return `<div class="acq-hour" title="${esc(r.label)} - ${fmt.format(Number(r.views || 0))} views, ${fmt.format(Number(r.unique_visitors || 0))} unique"><div class="acq-hour-bar" style="height:${h}px"></div><span>${esc(String(r.hour))}</span></div>`;
    }).join('');
  }

  function renderBreakdowns(){
    renderBreakdown('acqSourceBreakdown', state.report?.sources || []);
    renderBreakdown('acqDeviceBreakdown', state.report?.devices || []);
    renderBreakdown('acqBrowserBreakdown', state.report?.browsers || []);
    renderBreakdown('acqCountryBreakdown', state.report?.countries || []);
    renderBreakdown('acqCityBreakdown', state.report?.cities || []);
    renderBreakdown('acqLanguageBreakdown', state.report?.languages || []);
  }

  function renderBreakdown(id, rows){
    const el = document.getElementById(id);
    if (!el) return;
    if (!rows.length) {
      el.innerHTML = '<div class="acq-muted">No data in this range.</div>';
      return;
    }
    const max = Math.max(1, ...rows.map(r => Number(r.count || 0)));
    el.innerHTML = rows.slice(0, 8).map(r => `
      <div class="acq-break-row">
        <div class="acq-break-label" title="${esc(r.label)}">${esc(r.label)}</div>
        <div class="num">${fmt.format(Number(r.count || 0))} views</div>
        <div class="num">${fmt.format(Number(r.unique_visitors || 0))} unique</div>
        <div class="num">${fmt.format(Number(r.signups || 0))} signups</div>
        <div class="acq-break-bar"><div class="acq-break-fill" style="width:${Math.max(2, Math.round((Number(r.count || 0) / max) * 100))}%"></div></div>
      </div>
    `).join('');
  }

  function renderTables(){
    const signupRows = document.getElementById('acqSignupRows');
    if (signupRows) {
      const rows = state.report?.recent_signups || [];
      signupRows.innerHTML = rows.length ? rows.map(r => `
        <tr>
          <td><strong>${esc(r.email || '-')}</strong><div class="acq-muted">${esc(formatDate(r.signed_up_at))}</div></td>
          <td>${esc(r.campaign_name || '')}</td>
          <td class="acq-code">${esc(r.org_id || '')}</td>
          <td class="num">${money.format(Number(r.spend || 0))}</td>
          <td>${esc((r.metadata && (r.metadata.utm_source || r.metadata.source_type)) || '')}</td>
        </tr>
      `).join('') : '<tr><td colspan="5" class="acq-muted">No signups in this range.</td></tr>';
    }
  }

  function renderViewState(){
    document.querySelectorAll('#acqViewTabs [data-acq-view]').forEach((button) => {
      button.classList.toggle('active', button.getAttribute('data-acq-view') === state.activeView);
    });
    document.querySelectorAll('.acq-view-card').forEach((card) => {
      const views = String(card.getAttribute('data-views') || '').split(/\s+/).filter(Boolean);
      card.hidden = views.length && !views.includes(state.activeView);
    });
  }

  function rawDatasetRows(key){
    const raw = state.report?.raw || {};
    if (key === 'daily') return state.report?.daily || [];
    if (key === 'hourly') return state.report?.hourly || [];
    if (key === 'sources') return state.report?.sources || [];
    if (key === 'bonus_offers') return state.report?.bonus_offers || [];
    return Array.isArray(raw[key]) ? raw[key] : [];
  }

  function flattenRow(row, prefix){
    const out = {};
    Object.entries(row || {}).forEach(([key, value]) => {
      const name = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        Object.assign(out, flattenRow(value, name));
      } else if (Array.isArray(value)) {
        out[name] = value.join('|');
      } else {
        out[name] = value ?? '';
      }
    });
    return out;
  }

  function preferredColumns(rows){
    const seen = new Set();
    const ordered = [];
    rows.slice(0, 200).forEach((row) => {
      Object.keys(flattenRow(row)).forEach((key) => {
        if (!seen.has(key)) {
          seen.add(key);
          ordered.push(key);
        }
      });
    });
    const priority = [
      'attribution_id','event_id','id','campaign_id','campaign_name','name','code','status','source',
      'email','org_id','created_at','signed_up_at','signup_completed_at','views','unique_visitors','repeat_views','spend','orders',
      'landing_page','token','set_id','acquisition_bonus_token','acquisition_bonus_set_id','acquisition_bonus_label','utm_source','utm_medium','utm_campaign','client_ip','signup_client_ip','country','city','browser','device','timezone'
    ];
    return [
      ...priority.filter((key) => seen.has(key)),
      ...ordered.filter((key) => !priority.includes(key) && !key.startsWith('metadata.') && !key.startsWith('request.')),
      ...ordered.filter((key) => key.startsWith('metadata.') || key.startsWith('request.'))
    ];
  }

  function renderRawData(){
    const select = document.getElementById('acqRawDatasetSelect');
    if (select) {
      select.value = state.rawDataset;
    }
    const table = document.getElementById('acqRawTable');
    if (!table) return;
    const rows = rawDatasetRows(state.rawDataset);
    if (!rows.length) {
      table.innerHTML = `<tbody><tr><td class="acq-muted">No raw rows available for this dataset and date range.</td></tr></tbody>`;
      return;
    }
    const flatRows = rows.slice(0, 250).map((row) => flattenRow(row));
    const columns = preferredColumns(rows).slice(0, 18);
    table.innerHTML = `
      <thead><tr>${columns.map((col) => `<th>${esc(col)}</th>`).join('')}</tr></thead>
      <tbody>
        ${flatRows.map((row) => `<tr>${columns.map((col) => `<td title="${esc(row[col] ?? '')}">${esc(row[col] ?? '')}</td>`).join('')}</tr>`).join('')}
      </tbody>
    `;
  }

  function formatDate(value){
    const d = new Date(value || '');
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
  }

  function csvCell(value){
    if (value == null) return '';
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function rowsToCsv(rows){
    const data = Array.isArray(rows) ? rows : [];
    if (!data.length) return '';
    const flatRows = data.map((row) => flattenRow(row));
    const columns = preferredColumns(data);
    return [
      columns.map(csvCell).join(','),
      ...flatRows.map((row) => columns.map((col) => csvCell(row[col])).join(','))
    ].join('\r\n');
  }

  function exportName(key){
    const campaign = state.selectedCampaignId === 'all' ? 'all-campaigns' : slugify(selectedCampaign()?.display_name || state.selectedCampaignId || 'campaign');
    return `acquisition-${campaign}-${key}-${state.startDate || 'start'}-to-${state.endDate || 'end'}.csv`;
  }

  function downloadText(filename, text){
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportDataset(key){
    const resolved = key === 'current_raw' ? state.rawDataset : key;
    const rows = rawDatasetRows(resolved);
    if (!rows.length) {
      alert('No rows to export for this dataset and date range.');
      return;
    }
    downloadText(exportName(resolved), rowsToCsv(rows));
  }

  function exportAllDatasets(){
    ['daily', 'hourly', 'sources', 'bonus_offers', 'attributions', 'signups', 'spend_ledger', 'events', 'campaigns'].forEach((key) => {
      const rows = rawDatasetRows(key);
      if (rows.length) downloadText(exportName(key), rowsToCsv(rows));
    });
  }

  function handleCsvExport(key){
    if (!state.report) return;
    if (key === 'all') exportAllDatasets();
    else exportDataset(key);
  }

  function setLastDays(days){
    const pad = (n) => String(n).padStart(2, '0');
    const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - (Number(days) - 1));
    state.startDate = fmtDate(start);
    state.endDate = fmtDate(end);
    renderCampaignControls();
    loadReport();
  }

  async function loadCampaigns(){
    const data = await request('/campaigns');
    state.campaigns = Array.isArray(data.campaigns) ? data.campaigns : [];
  }

  async function loadLandingPages(){
    const data = await request('/landing-pages');
    state.landingPages = Array.isArray(data.landing_pages) ? data.landing_pages : [];
    state.landingPagesError = '';
    state.landingPageScan = {
      root: data.root || '',
      searched_roots: Array.isArray(data.searched_roots) ? data.searched_roots : []
    };
  }

  function landingPageByUrl(url){
    const value = String(url || '');
    return state.landingPages.find(page => String(page.url_path || '') === value) || null;
  }

  function currentSettingsFormValues(campaign){
    return {
      name: document.getElementById('acqSettingsNameInput')?.value || campaign.display_name || '',
      code: document.getElementById('acqSettingsCodeInput')?.value || campaign.primary_code?.code || '',
      channel: document.getElementById('acqSettingsChannelInput')?.value || campaign.campaign_type || campaign.metadata?.channel || 'marketing',
      status: document.getElementById('acqSettingsStatusInput')?.value || campaign.status || 'active',
      bonus_offer_sets: collectBonusOfferSets()
    };
  }

  function renderLandingManager(){
    const campaign = selectedCampaign();
    if (!campaign) return;
    const currentLanding = document.getElementById('acqSettingsLandingInput')?.value || campaign.landing_page || '';
    const currentPage = landingPageByUrl(currentLanding);
    const currentLabel = currentPage ? (currentPage.label || currentPage.variant || currentPage.url_path) : (currentLanding || 'None');
    const campaignLabel = document.getElementById('acqLandingManagerCampaign');
    if (campaignLabel) campaignLabel.textContent = campaign.display_name || campaign.id || '';
    const root = document.getElementById('acqLandingManagerRoot');
    if (root) root.textContent = state.landingPageScan?.root ? `Root: ${state.landingPageScan.root}` : '';
    const summary = document.getElementById('acqCurrentLandingSummary');
    if (summary) {
      summary.innerHTML = `
        <b>${esc(currentLabel)}</b>
        <span>${esc(currentLanding || 'No landing page paired to this campaign')}</span>
      `;
    }
    const pairSelect = document.getElementById('acqManagerPairLandingInput');
    if (pairSelect) {
      pairSelect.innerHTML = landingOptionsHtml(currentLanding);
      pairSelect.value = currentLanding || '';
    }
    const sourceSelect = document.getElementById('acqCloneSourceInput');
    if (sourceSelect) {
      const sourceValue = currentLanding || '/portal/landing/variants/measurements/';
      sourceSelect.innerHTML = landingOptionsHtml(sourceValue).replace('No landing page selected', 'Choose source page');
      sourceSelect.value = landingPageByUrl(sourceValue) ? sourceValue : (state.landingPages[0]?.url_path || '');
    }
    const slugInput = document.getElementById('acqCloneSlugInput');
    if (slugInput && !slugInput.value) slugInput.value = slugify(`${campaign.display_name || 'campaign'} page`);
    updateClonePreview();
    renderLandingManagerTable();
  }

  function renderLandingManagerTable(){
    const table = document.getElementById('acqLandingManagerTable');
    const status = document.getElementById('acqLandingManagerStatus');
    if (!table) return;
    if (status) {
      const checked = Array.isArray(state.landingPageScan?.searched_roots) ? state.landingPageScan.searched_roots.length : 0;
      status.textContent = state.landingPages.length ? `${state.landingPages.length} landing pages detected` : (state.landingPagesError || `No landing pages found${checked ? ` after checking ${checked} folders` : ''}.`);
      status.className = `acq-status-line${state.landingPages.length ? '' : ' error'}`;
    }
    if (!state.landingPages.length) {
      table.innerHTML = '<div class="acq-muted" style="padding:12px;">No landing pages found.</div>';
      return;
    }
    const currentPair = document.getElementById('acqManagerPairLandingInput')?.value || '';
    const currentSource = document.getElementById('acqCloneSourceInput')?.value || '';
    table.innerHTML = `
      <table>
        <thead><tr><th>Page</th><th>URL</th><th>Variant</th><th></th></tr></thead>
        <tbody>
          ${state.landingPages.map(page => {
            const url = page.url_path || '';
            const sourceActive = String(url) === String(currentSource);
            const pairActive = String(url) === String(currentPair);
            return `
              <tr>
                <td><strong>${esc(page.label || page.variant || page.id)}</strong></td>
                <td class="path">${esc(url)}</td>
                <td>${esc(page.variant || '')}</td>
                <td>
                  <div class="acq-actions">
                    <button class="acq-btn" data-manager-source="${esc(url)}">${sourceActive ? 'Source' : 'Use Source'}</button>
                    <button class="acq-btn" data-manager-pair="${esc(url)}">${pairActive ? 'Paired' : 'Pair'}</button>
                  </div>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  }

  function updateClonePreview(){
    const slug = slugify(document.getElementById('acqCloneSlugInput')?.value || '');
    const preview = document.getElementById('acqCloneUrlPreview');
    if (preview) preview.value = slug ? `/portal/landing/variants/${slug}/` : '';
  }

  function setLandingManagerStatus(message, tone){
    const status = document.getElementById('acqLandingManagerStatus');
    if (!status) return;
    status.textContent = message || '';
    status.className = `acq-status-line${tone ? ` ${tone}` : ''}`;
  }

  function openLandingManager(){
    const campaign = selectedCampaign();
    if (!campaign) return;
    renderLandingManager();
    document.getElementById('acqLandingManagerModal')?.classList.add('open');
  }

  function closeLandingManager(){
    document.getElementById('acqLandingManagerModal')?.classList.remove('open');
  }

  async function saveLandingPairing(landingUrl){
    const campaign = selectedCampaign();
    if (!campaign || state.saving) return;
    const selectedUrl = landingUrl ?? document.getElementById('acqManagerPairLandingInput')?.value ?? '';
    const selectedPage = landingPageByUrl(selectedUrl);
    const formValues = currentSettingsFormValues(campaign);
    const payload = {
      id: campaign.id,
      display_name: formValues.name,
      code: formValues.code,
      campaign_type: formValues.channel || 'marketing',
      channel: formValues.channel || 'marketing',
      status: formValues.status || 'active',
      landing_page: selectedUrl || '',
      landing_variant: selectedPage?.variant || '',
      bonus_offer_sets: formValues.bonus_offer_sets
    };
    await saveCampaignPayload(payload, document.getElementById('acqManagerSavePairBtn'), false);
    setLandingManagerStatus('Landing page pairing saved.', 'success');
    renderLandingManager();
  }

  async function cloneLandingPageFromManager(){
    const campaign = selectedCampaign();
    if (!campaign || state.saving) return;
    const source = document.getElementById('acqCloneSourceInput')?.value || '';
    const slug = slugify(document.getElementById('acqCloneSlugInput')?.value || '');
    if (!slug) {
      setLandingManagerStatus('Enter a landing page slug.', 'error');
      return;
    }
    if (!source) {
      setLandingManagerStatus('Choose a source landing page.', 'error');
      return;
    }
    const cloneBtn = document.getElementById('acqManagerCloneBtn');
    if (cloneBtn) cloneBtn.disabled = true;
    setLandingManagerStatus('Cloning landing page...', '');
    try {
      const data = await request('/landing-pages/clone', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, source_url_path: source })
      });
      state.landingPages = Array.isArray(data.landing_pages) ? data.landing_pages : state.landingPages;
      const newUrl = data.landing_page?.url_path || `/portal/landing/variants/${slug}/`;
      const pairSelect = document.getElementById('acqManagerPairLandingInput');
      if (pairSelect) pairSelect.value = newUrl;
      const sourceSelect = document.getElementById('acqCloneSourceInput');
      if (sourceSelect) sourceSelect.value = newUrl;
      const settingsSelect = document.getElementById('acqSettingsLandingInput');
      if (settingsSelect) settingsSelect.value = newUrl;
      if (document.getElementById('acqClonePairAfterInput')?.checked) {
        await saveLandingPairing(newUrl);
      } else {
        setLandingManagerStatus('Landing page cloned.', 'success');
      }
      document.getElementById('acqCloneSlugInput').value = '';
      renderLandingManager();
    } catch (err) {
      setLandingManagerStatus(err?.message || 'Could not clone landing page.', 'error');
    } finally {
      if (cloneBtn) cloneBtn.disabled = false;
    }
  }

  function slugify(value){
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 64);
  }

  async function loadReport(){
    defaultDates();
    const params = new URLSearchParams({
      campaign_id: state.selectedCampaignId,
      start_date: state.startDate,
      end_date: state.endDate,
      timezone_offset_minutes: String(new Date().getTimezoneOffset())
    });
    state.report = await request('/report?' + params.toString());
    renderAll();
  }

  async function refreshAll(){
    state.loading = true;
    renderCampaignList();
    try {
      await Promise.all([
        loadCampaigns(),
        loadLandingPages().catch((err) => {
          state.landingPages = [];
          state.landingPagesError = err?.message || 'Could not refresh landing pages.';
        })
      ]);
      await loadReport();
    } finally {
      state.loading = false;
      renderAll();
    }
  }

  function openModal(campaign, selectedLandingPage){
    state.modalCampaign = campaign || null;
    const modal = document.getElementById('acqCampaignModal');
    document.getElementById('acqModalTitle').textContent = campaign ? 'Edit Campaign' : 'New Campaign';
    document.getElementById('acqNameInput').value = campaign?.display_name || '';
    const codeInput = document.getElementById('acqCodeInput');
    codeInput.value = campaign?.primary_code?.code || '';
    codeInput.disabled = false;
    document.getElementById('acqChannelInput').value = campaign?.campaign_type || campaign?.metadata?.channel || '';
    document.getElementById('acqStatusInput').value = campaign?.status || 'active';
    document.getElementById('acqModalHelp').textContent = campaign
      ? 'The campaign code is editable. Changing it changes future attribution links if the new code is unused.'
      : 'Leave campaign code blank to auto-generate one from the name.';
    renderLandingOptions(campaign?.landing_page || selectedLandingPage || '');
    modal.classList.add('open');
  }

  function renderLandingOptions(selected){
    const select = document.getElementById('acqLandingInput');
    if (!select) return;
    select.innerHTML = landingOptionsHtml(selected);
    select.value = selected || '';
  }

  function closeModal(){
    document.getElementById('acqCampaignModal')?.classList.remove('open');
  }

  async function saveCampaign(){
    if (state.saving) return;
    const landingSelect = document.getElementById('acqLandingInput');
    const selectedOption = landingSelect?.selectedOptions?.[0];
    const payload = {
      id: state.modalCampaign?.id || undefined,
      display_name: document.getElementById('acqNameInput').value,
      code: document.getElementById('acqCodeInput').value,
      campaign_type: document.getElementById('acqChannelInput').value || 'marketing',
      channel: document.getElementById('acqChannelInput').value || 'marketing',
      status: document.getElementById('acqStatusInput').value || 'active',
      landing_page: landingSelect?.value || '',
      landing_variant: selectedOption?.dataset?.variant || ''
    };
    await saveCampaignPayload(payload, document.getElementById('acqModalSaveBtn'), true);
  }

  async function saveSelectedCampaign(){
    const campaign = selectedCampaign();
    if (!campaign || state.saving) return;
    const landingSelect = document.getElementById('acqSettingsLandingInput');
    const selectedOption = landingSelect?.selectedOptions?.[0];
    const payload = {
      id: campaign.id,
      display_name: document.getElementById('acqSettingsNameInput').value,
      code: document.getElementById('acqSettingsCodeInput').value,
      campaign_type: document.getElementById('acqSettingsChannelInput').value || 'marketing',
      channel: document.getElementById('acqSettingsChannelInput').value || 'marketing',
      status: document.getElementById('acqSettingsStatusInput').value || 'active',
      landing_page: landingSelect?.value || '',
      landing_variant: selectedOption?.dataset?.variant || '',
      bonus_offer_sets: collectBonusOfferSets()
    };
    await saveCampaignPayload(payload, document.getElementById('acqSettingsSaveBtn'), false);
  }

  async function saveCampaignPayload(payload, saveBtn, closeAfterSave){
    state.saving = true;
    if (saveBtn) saveBtn.disabled = true;
    try {
      const data = await request('/campaigns', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      state.selectedCampaignId = data.campaign?.id || state.selectedCampaignId;
      if (closeAfterSave) closeModal();
      await refreshAll();
    } catch (err) {
      alert(err?.message || 'Could not save campaign.');
    } finally {
      state.saving = false;
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  function bindEvents(){
    document.getElementById('acqNewCampaignBtn')?.addEventListener('click', () => openModal(null));
    document.getElementById('acqCampaignSelect')?.addEventListener('change', (e) => {
      state.selectedCampaignId = e.target.value || 'all';
      loadReport();
    });
    document.getElementById('acqStartDate')?.addEventListener('change', (e) => { state.startDate = e.target.value || ''; });
    document.getElementById('acqEndDate')?.addEventListener('change', (e) => { state.endDate = e.target.value || ''; });
    document.getElementById('acqApplyBtn')?.addEventListener('click', loadReport);
    document.getElementById('acqLast7Btn')?.addEventListener('click', () => setLastDays(7));
    document.getElementById('acqLast30Btn')?.addEventListener('click', () => setLastDays(30));
    document.getElementById('acqViewTabs')?.addEventListener('click', (e) => {
      const button = e.target.closest('[data-acq-view]');
      if (!button) return;
      state.activeView = button.getAttribute('data-acq-view') || 'overview';
      renderViewState();
      renderRawData();
    });
    document.getElementById('acqRawDatasetSelect')?.addEventListener('change', (e) => {
      state.rawDataset = e.target.value || 'attributions';
      renderRawData();
    });
    document.getElementById('view-acquisition-campaigns')?.addEventListener('click', (e) => {
      const button = e.target.closest('[data-csv-export]');
      if (!button) return;
      handleCsvExport(button.getAttribute('data-csv-export') || 'current_raw');
    });
    document.getElementById('acqCampaignList')?.addEventListener('click', (e) => {
      const row = e.target.closest('[data-campaign-id]');
      if (!row) return;
      state.selectedCampaignId = row.getAttribute('data-campaign-id') || 'all';
      loadReport();
    });
    document.getElementById('acqCampaignList')?.addEventListener('dblclick', (e) => {
      const row = e.target.closest('[data-campaign-id]');
      if (!row) return;
      const campaign = state.campaigns.find(item => String(item.id) === String(row.getAttribute('data-campaign-id')));
      if (campaign) openModal(campaign);
    });
    document.getElementById('acqCampaignSettings')?.addEventListener('click', async (e) => {
      const target = e.target.closest('button');
      if (!target) return;
      if (target.id === 'acqSettingsSaveBtn') {
        await saveSelectedCampaign();
      } else if (target.id === 'acqSettingsNewBtn') {
        openModal(null);
      } else if (target.matches('[data-bonus-add-set]')) {
        addBonusSet();
      } else if (target.matches('[data-bonus-remove-set]')) {
        target.closest('[data-bonus-set]')?.remove();
        const editor = document.getElementById('acqBonusOfferEditor');
        if (editor && !editor.querySelector('[data-bonus-set]')) {
          const empty = document.createElement('div');
          empty.className = 'acq-bonus-empty';
          empty.textContent = 'No bonus offer sets yet. Add one set to start split testing campaign load offers.';
          const firstStats = editor.querySelector('.acq-help,.acq-bonus-stats');
          editor.insertBefore(empty, firstStats || null);
        }
      } else if (target.id === 'acqCopyLandingUrlBtn') {
        const url = currentSettingsLandingUrl();
        const status = document.getElementById('acqSettingsLandingCopyStatus');
        if (!url) {
          if (status) status.textContent = 'Select a landing page first.';
          return;
        }
        try {
          await copyText(url);
          if (status) status.textContent = 'Copied.';
        } catch {
          if (status) status.textContent = 'Copy failed.';
        }
      } else if (target.id === 'acqSettingsLandingManagerBtn') {
        openLandingManager();
      }
    });
    document.getElementById('acqCampaignSettings')?.addEventListener('input', (e) => {
      if (e.target?.id === 'acqSettingsCodeInput') updateSettingsLandingUrl();
    });
    document.getElementById('acqCampaignSettings')?.addEventListener('change', (e) => {
      if (e.target?.id === 'acqSettingsLandingInput') updateSettingsLandingUrl();
    });
    document.getElementById('acqModalCloseBtn')?.addEventListener('click', closeModal);
    document.getElementById('acqModalCancelBtn')?.addEventListener('click', closeModal);
    document.getElementById('acqCampaignModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'acqCampaignModal') closeModal();
    });
    document.getElementById('acqModalSaveBtn')?.addEventListener('click', saveCampaign);
    document.getElementById('acqLandingManagerCloseBtn')?.addEventListener('click', closeLandingManager);
    document.getElementById('acqLandingManagerDoneBtn')?.addEventListener('click', closeLandingManager);
    document.getElementById('acqLandingManagerModal')?.addEventListener('click', async (e) => {
      if (e.target.id === 'acqLandingManagerModal') {
        closeLandingManager();
        return;
      }
      const sourceButton = e.target.closest('[data-manager-source]');
      if (sourceButton) {
        const value = sourceButton.getAttribute('data-manager-source') || '';
        const sourceSelect = document.getElementById('acqCloneSourceInput');
        if (sourceSelect) sourceSelect.value = value;
        renderLandingManagerTable();
        return;
      }
      const pairButton = e.target.closest('[data-manager-pair]');
      if (pairButton) {
        const value = pairButton.getAttribute('data-manager-pair') || '';
        const pairSelect = document.getElementById('acqManagerPairLandingInput');
        if (pairSelect) pairSelect.value = value;
        renderLandingManagerTable();
        return;
      }
      if (e.target.closest('#acqManagerSavePairBtn')) {
        await saveLandingPairing();
        return;
      }
      if (e.target.closest('#acqManagerCloneBtn')) {
        await cloneLandingPageFromManager();
      }
    });
    document.getElementById('acqCloneSlugInput')?.addEventListener('input', updateClonePreview);
    document.getElementById('acqCloneSourceInput')?.addEventListener('change', renderLandingManagerTable);
    document.getElementById('acqManagerPairLandingInput')?.addEventListener('change', renderLandingManagerTable);
  }

  const AcquisitionCampaigns = {
    init(){
      if (state.loaded || !canAccess()) return;
      defaultDates();
      ensureStyles();
      ensureMarkup();
      bindEvents();
      state.loaded = true;
    },
    async onShow(){
      this.init();
      await refreshAll();
    }
  };

  if (canAccess()) {
    AcquisitionCampaigns.init();
    window.Portal.registerPlugin({ id: 'acquisition-campaigns', title: 'Campaigns', iconClass: 'fas fa-bullhorn' });
    const prevSwitch = window.Portal.switchView ? window.Portal.switchView.bind(window.Portal) : null;
    if (prevSwitch) {
      window.Portal.switchView = async function(id, btn){
        const result = await prevSwitch(id, btn);
        if (id === 'acquisition-campaigns') await AcquisitionCampaigns.onShow();
        return result;
      };
    }
  }

  window.AcquisitionCampaigns = AcquisitionCampaigns;
})();
