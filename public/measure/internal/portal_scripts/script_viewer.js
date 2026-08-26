(function(){
  const STORAGE_USAGE_KEY = 'callScriptsUsageV1';
  const STORAGE_SELECTED_KEY = 'callScriptsSelectedV1';
  const STORAGE_EXPANDED_KEY = 'callScriptsExpandedV1';
  const STORAGE_WIDTH_KEY = 'callScriptsWidthV3';

  const state = {
    scripts: [],
    selectedId: '',
    open: false,
    expanded: false,
    activeTab: 'scripts',
    canManage: false,
    usage: {},
    touchedThisSession: new Set(),
    editorId: '',
    width: 840,
    editorDirty: false,
    editorSnapshot: '',
    toolsSettings: null,
    toolsSettingsLoaded: false,
    toolsSettingsLoading: false,
    calc: {
      provider: 'eagleview',
      reportsSliderValue: 12,
      reportsPerWeek: 10,
      residentialPct: 80,
      commercialPct: 20,
      bidPct: 100,
      premiumPct: 20,
      otherResPrice: 20,
      otherComPrice: 40,
      calculated: false,
    },
  };

  function esc(value){
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtTs(ts){
    const n = Number(ts || 0);
    return n ? new Date(n * 1000).toLocaleString() : '-';
  }

  function normalizeScriptBodyForEditor(body){
    const raw = String(body || '');
    if (raw.trim() === '') return '';
    if (/<[a-z][\s\S]*>/i.test(raw)) return raw;
    return esc(raw).replace(/\n/g, '<br>');
  }

  function currentEditorHtml(){
    return document.getElementById('callScriptEditorRich')?.innerHTML || '';
  }

  function updateEditorDirty(){
    state.editorDirty = currentEditorHtml() !== state.editorSnapshot ||
      (document.getElementById('callScriptEditorName')?.value || '') !== (document.getElementById('callScriptEditorName').dataset.initialValue || '') ||
      (document.getElementById('callScriptEditorDescription')?.value || '') !== (document.getElementById('callScriptEditorDescription').dataset.initialValue || '');
    const badge = document.getElementById('callScriptEditorDirty');
    if (badge) badge.textContent = state.editorDirty ? 'Unsaved changes' : 'Saved';
  }

  function execEditor(cmd, value){
    const editor = document.getElementById('callScriptEditorRich');
    if (!editor) return;
    editor.focus();
    document.execCommand(cmd, false, value);
    updateEditorDirty();
  }

  function maybeCancelEditor(){
    if (!state.editorDirty) {
      closeEditor(true);
      return;
    }
    if (confirm('Discard your unsaved changes?')) {
      closeEditor(true);
    }
  }

  function canManage(){
    if (state.canManage) return true;
    const perms = window.Portal?.cfg?.perms || {};
    const role = String(window.Portal?.cfg?.user?.role || '').toLowerCase();
    return !!(perms.manage_users || perms.manage_sales_users || perms.create_users || ['admin', 'system_admin', 'lead', 'sales_manager'].includes(role));
  }

  function fmtUsd(value){
    const amount = Number(value || 0);
    return `$${Math.round(amount).toLocaleString()}`;
  }

  function fmtUsdPrecise(value){
    const amount = Number(value || 0);
    return `$${amount.toLocaleString(undefined, {
      minimumFractionDigits: amount % 1 ? 2 : 0,
      maximumFractionDigits: 2,
    })}`;
  }

  function toolsCalculatorConfig(){
    return {
      fmResidentialPrice: 7,
      fmCommercialPrice: 12,
      providers: [
        { id: 'eagleview', name: 'EagleView' },
        { id: 'quickmeasure', name: 'QuickMeasure' },
        { id: 'roofr', name: 'Roofr' },
        { id: 'other', name: 'Other' },
      ],
      defaults: {
        reportsSliderValue: 12,
        reportsPerWeek: 10,
        residentialPct: 80,
        commercialPct: 20,
        bidPct: 100,
        premiumPct: 20,
        otherResPrice: 20,
        otherComPrice: 40,
      },
    };
  }

  function toolsComparisonMatrix(){
    return {
      title: 'FirstMate vs. Competitor Reports',
      columns: [
        { key: 'feature', label: 'Feature', tone: 'dark' },
        { key: 'firstmate', label: 'FirstMate', tone: 'brand' },
        { key: 'eagleview', label: 'Eagleview', tone: 'brand' },
        { key: 'roofr', label: 'Roofr', tone: 'brand' },
        { key: 'quickmeasure', label: 'GAF QuickMeasure', headerLines: ['GAF', 'QuickMeasure'], tone: 'brand' },
        { key: 'roofscope', label: 'RoofScope', tone: 'brand' },
      ],
      rows: [
        { feature: 'Cover Page Summary', firstmate: 'Included', eagleview: 'Included', roofr: { label: 'Limited' }, quickmeasure: 'Included', roofscope: 'Included' },
        { feature: 'Top-Down Roof View', firstmate: 'Included', eagleview: 'Included', roofr: 'Included', quickmeasure: 'Included', roofscope: 'Included' },
        { feature: 'Multiple Angle Views', firstmate: 'Included', eagleview: 'Included', roofr: 'Not Included', quickmeasure: 'Included', roofscope: 'Not Included' },
        { feature: '3D Model', firstmate: 'Included', eagleview: 'Included', roofr: 'Not Included', quickmeasure: 'Included', roofscope: 'Not Included' },
        { feature: 'Pitch Breakdown', firstmate: 'Included', eagleview: 'Included', roofr: 'Included', quickmeasure: 'Included', roofscope: 'Included' },
        { feature: 'Area & Line Measurements', firstmate: 'Included', eagleview: 'Included', roofr: 'Included', quickmeasure: 'Included', roofscope: 'Included' },
        { feature: 'Waste Calculations', firstmate: 'Included', eagleview: 'Included', roofr: 'Included', quickmeasure: 'Included', roofscope: 'Included' },
        { feature: 'Material List', firstmate: 'Included', eagleview: 'Not Included', roofr: 'Included', quickmeasure: { label: 'Limited', tooltip: 'GAF QuickMeasure only includes GAF materials on the materials list.' }, roofscope: 'Not Included' },
        { feature: 'Ventilation Summary', firstmate: 'Included', eagleview: 'Not Included', roofr: 'Not Included', quickmeasure: 'Not Included', roofscope: 'Not Included' },
        { feature: 'Notes Page', firstmate: 'Included', eagleview: 'Not Included', roofr: 'Not Included', quickmeasure: 'Not Included', roofscope: 'Not Included' },
        { feature: 'Customizable Reports', firstmate: 'Included', eagleview: 'Not Included', roofr: 'Not Included', quickmeasure: 'Not Included', roofscope: 'Not Included' },
      ],
    };
  }

  function calculatorProviders(){
    return toolsCalculatorConfig().providers;
  }

  function normalizeProviderId(value){
    return String(value || '').trim().toLowerCase();
  }

  function currentProvider(){
    const providerId = normalizeProviderId(state.calc.provider || 'eagleview');
    return calculatorProviders().find((provider) => provider.id === providerId) || calculatorProviders()[0];
  }

  function reportsPerWeekFromSlider(value){
    const slider = Math.max(0, Math.min(100, Number(value || 0)));
    if (slider <= 33) return Math.max(1, Math.round(1 + (slider / 33) * 24));
    if (slider <= 67) return Math.round(25 + ((slider - 33) / 34) * 50);
    return Math.round(75 + ((slider - 67) / 33) * 75);
  }

  function syncCalculatorToProvider(providerValue, preserveCalculated){
    const provider = calculatorProviders().find((item) => item.id === normalizeProviderId(providerValue)) || calculatorProviders()[0];
    state.calc = {
      ...state.calc,
      provider: provider.id,
      calculated: !!preserveCalculated && !!state.calc.calculated,
    };
  }

  function calculatorResult(calc){
    const config = toolsCalculatorConfig();
    const provider = calculatorProviders().find((item) => item.id === normalizeProviderId(calc?.provider)) || calculatorProviders()[0];
    if (!provider) return null;
    const reportsPerWeek = Math.max(1, Number(calc?.reportsPerWeek || config.defaults.reportsPerWeek) || config.defaults.reportsPerWeek);
    const residentialPct = Math.max(0, Math.min(100, Number(calc?.residentialPct ?? config.defaults.residentialPct) || 0));
    const commercialPct = Math.max(0, 100 - residentialPct);
    const residentialRpw = reportsPerWeek * (residentialPct / 100);
    const commercialRpw = reportsPerWeek * (commercialPct / 100);
    const bidPct = Math.max(0, Math.min(100, Number(calc?.bidPct ?? config.defaults.bidPct) || 0)) / 100;
    const premiumPct = Math.max(0, Math.min(100, Number(calc?.premiumPct ?? config.defaults.premiumPct) || 0)) / 100;
    const otherResPrice = Math.max(0, Number(calc?.otherResPrice ?? config.defaults.otherResPrice) || 0);
    const otherComPrice = Math.max(0, Number(calc?.otherComPrice ?? config.defaults.otherComPrice) || 0);
    const weeksPerYear = 52;
    let currentAnnual = 0;
    let providerResidentialAnnual = 0;
    let providerCommercialAnnual = 0;
    let residentialBidRpw = 0;
    let residentialBidAnnual = 0;
    let residentialPremiumRpw = 0;
    let residentialPremiumAnnual = 0;
    let roofrSubscriptionAnnual = 0;
    let roofrReportsAnnual = 0;
    let providerLabel = provider.name;

    if (provider.id === 'eagleview') {
      residentialBidRpw = residentialRpw * bidPct;
      residentialPremiumRpw = residentialRpw * premiumPct;
      residentialBidAnnual = residentialBidRpw * 18 * weeksPerYear;
      residentialPremiumAnnual = residentialPremiumRpw * 60 * weeksPerYear;
      providerCommercialAnnual = commercialRpw * 89.5 * weeksPerYear;
      providerResidentialAnnual = residentialBidAnnual + residentialPremiumAnnual;
      currentAnnual = providerResidentialAnnual + providerCommercialAnnual;
    } else if (provider.id === 'quickmeasure') {
      providerResidentialAnnual = residentialRpw * 18 * weeksPerYear;
      providerCommercialAnnual = commercialRpw * 54 * weeksPerYear;
      currentAnnual = providerResidentialAnnual + providerCommercialAnnual;
    } else if (provider.id === 'roofr') {
      roofrSubscriptionAnnual = 145 * 12;
      roofrReportsAnnual = reportsPerWeek * 13 * weeksPerYear;
      currentAnnual = roofrSubscriptionAnnual + roofrReportsAnnual;
    } else {
      providerResidentialAnnual = residentialRpw * otherResPrice * weeksPerYear;
      providerCommercialAnnual = commercialRpw * otherComPrice * weeksPerYear;
      currentAnnual = providerResidentialAnnual + providerCommercialAnnual;
      providerLabel = 'your current provider';
    }

    const fmResidentialAnnual = residentialRpw * config.fmResidentialPrice * weeksPerYear;
    const fmCommercialAnnual = commercialRpw * config.fmCommercialPrice * weeksPerYear;
    const fmAnnual = fmResidentialAnnual + fmCommercialAnnual;
    const annualSavings = currentAnnual - fmAnnual;
    const pctSaved = currentAnnual > 0 ? Math.round((annualSavings / currentAnnual) * 100) : 0;

    return {
      provider,
      providerLabel,
      reportsPerWeek,
      residentialPct,
      commercialPct,
      residentialRpw,
      commercialRpw,
      bidPct: Math.round(bidPct * 100),
      premiumPct: Math.round(premiumPct * 100),
      otherResPrice,
      otherComPrice,
      currentAnnual,
      fmAnnual,
      annualSavings,
      pctSaved,
      fmResidentialAnnual,
      fmCommercialAnnual,
      providerResidentialAnnual,
      providerCommercialAnnual,
      residentialBidRpw,
      residentialBidAnnual,
      residentialPremiumRpw,
      residentialPremiumAnnual,
      roofrSubscriptionAnnual,
      roofrReportsAnnual,
    };
  }

  function calculatorBreakdown(result){
    if (!result) return [];
    const sections = [];
    if (result.provider.id === 'eagleview') {
      const rows = [];
      if (result.bidPct > 0) rows.push({ label: 'BidPerfect Residential', calc: `$18 each x ${result.residentialBidRpw.toFixed(1)} per week`, amount: fmtUsd(result.residentialBidAnnual) });
      if (result.premiumPct > 0) rows.push({ label: 'Premium Residential', calc: `$60 each x ${result.residentialPremiumRpw.toFixed(1)} per week`, amount: fmtUsd(result.residentialPremiumAnnual) });
      if (result.commercialPct > 0) rows.push({ label: 'Commercial', calc: `$89.50 each x ${result.commercialRpw.toFixed(1)} per week`, amount: fmtUsd(result.providerCommercialAnnual) });
      sections.push({ heading: 'EagleView Cost', rows, totalAmount: `${fmtUsd(result.currentAnnual)}/yr`, tone: 'negative' });
    } else if (result.provider.id === 'quickmeasure') {
      sections.push({
        heading: 'QuickMeasure Cost',
        rows: [
          { label: 'Residential', calc: `$18 each x ${result.residentialRpw.toFixed(1)} per week`, amount: fmtUsd(result.providerResidentialAnnual) },
          { label: 'Commercial', calc: `$54 each x ${result.commercialRpw.toFixed(1)} per week`, amount: fmtUsd(result.providerCommercialAnnual) },
        ],
        totalAmount: `${fmtUsd(result.currentAnnual)}/yr`,
        tone: 'negative',
      });
    } else if (result.provider.id === 'roofr') {
      sections.push({
        heading: 'Roofr Cost',
        rows: [
          { label: 'Monthly Subscription', calc: '$145 per month x 12 months', amount: fmtUsd(result.roofrSubscriptionAnnual) },
          { label: 'All Reports', calc: `$13 each x ${result.reportsPerWeek} per week`, amount: fmtUsd(result.roofrReportsAnnual) },
        ],
        totalAmount: `${fmtUsd(result.currentAnnual)}/yr`,
        tone: 'negative',
      });
    } else {
      sections.push({
        heading: 'Your Current Provider Cost',
        rows: [
          { label: 'Residential', calc: `${fmtUsdPrecise(result.otherResPrice)} each x ${result.residentialRpw.toFixed(1)} per week`, amount: fmtUsd(result.providerResidentialAnnual) },
          { label: 'Commercial', calc: `${fmtUsdPrecise(result.otherComPrice)} each x ${result.commercialRpw.toFixed(1)} per week`, amount: fmtUsd(result.providerCommercialAnnual) },
        ],
        totalAmount: `${fmtUsd(result.currentAnnual)}/yr`,
        tone: 'negative',
      });
    }
    sections.push({
      heading: 'FirstMate Cost',
      rows: [
        { label: 'Residential', calc: `$7 each x ${result.residentialRpw.toFixed(1)} per week`, amount: fmtUsd(result.fmResidentialAnnual) },
        { label: 'Commercial / Multi-Family', calc: `$12 each x ${result.commercialRpw.toFixed(1)} per week`, amount: fmtUsd(result.fmCommercialAnnual) },
      ],
      totalAmount: `${fmtUsd(result.fmAnnual)}/yr`,
      totalMeta: 'No hidden fees',
      tone: 'positive',
    });
    return sections;
  }

  function syncCalculatorVisuals(root){
    if (!(root instanceof HTMLElement)) return;
    root.querySelectorAll('[data-slider-tone]').forEach((slider) => {
      if (!(slider instanceof HTMLInputElement)) return;
      const min = Number(slider.min || 0);
      const max = Number(slider.max || 100);
      const value = Number(slider.value || 0);
      const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
      const tone = slider.getAttribute('data-slider-tone') || 'red';
      const color = tone === 'neutral' ? '#374151' : '#dc2626';
      slider.style.background = `linear-gradient(to right, ${color} 0%, ${color} ${pct}%, #E5E7EB ${pct}%, #E5E7EB 100%)`;
    });
  }

  function comparisonCellHtml(value){
    const rawLabel = value && typeof value === 'object' ? value.label : value;
    const tooltip = value && typeof value === 'object' ? value.tooltip : '';
    const normalized = String(rawLabel || '').trim().toLowerCase();
    if (normalized === 'included') {
      return '<span class="call-tools-status" aria-label="Included"><span class="call-tools-status-icon yes"><i class="fas fa-check"></i></span></span>';
    }
    if (normalized === 'not included') {
      return '<span class="call-tools-status" aria-label="Not Included"><span class="call-tools-status-icon no"><i class="fas fa-times"></i></span></span>';
    }
    if (normalized.includes('limited')) {
      return `<span class="call-tools-status-pill">Limited${tooltip ? ` <span class="call-tools-status-tip" title="${esc(tooltip)}"><i class="fas fa-info"></i></span>` : ''}</span>`;
    }
    return esc(rawLabel || '-');
  }

  function api(data){
    const url = window.Portal?.cfg?.endpoints?.server
      || window.LEAD_VIEWER_CFG?.server
      || window.Portal?.internalLegacyEndpoint?.()
      || ((location.hostname === '127.0.0.1' || location.hostname === 'localhost')
        ? 'http://127.0.0.1:3111/v1/internal/legacy-action'
        : `${location.origin}/v1/internal/legacy-action`);
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data || {})
    }).then(r => r.json());
  }

  function loadLocalState(){
    try { state.usage = JSON.parse(localStorage.getItem(STORAGE_USAGE_KEY) || '{}') || {}; } catch (_) { state.usage = {}; }
    state.selectedId = localStorage.getItem(STORAGE_SELECTED_KEY) || '';
    state.expanded = localStorage.getItem(STORAGE_EXPANDED_KEY) === '1';
    state.width = clampWidth(localStorage.getItem(STORAGE_WIDTH_KEY) || 840);
  }

  function persistLocalState(){
    localStorage.setItem(STORAGE_USAGE_KEY, JSON.stringify(state.usage || {}));
    localStorage.setItem(STORAGE_SELECTED_KEY, state.selectedId || '');
    localStorage.setItem(STORAGE_EXPANDED_KEY, state.expanded ? '1' : '0');
    localStorage.setItem(STORAGE_WIDTH_KEY, String(state.width || 840));
  }

  function clampWidth(width){
    return Math.max(620, Math.min(1200, Number(width || 840)));
  }

  function usageScore(script){
    const local = state.usage[String(script.id || '')] || {};
    return {
      localCount: Number(local.count || 0),
      localTs: Number(local.lastUsedAt || 0),
      serverCount: Number(script.usage_count || 0),
      serverTs: Number(script.last_used_at || 0),
    };
  }

  function rankedScripts(){
    return [...state.scripts].sort((a, b) => {
      const sa = usageScore(a);
      const sb = usageScore(b);
      if (sb.localCount !== sa.localCount) return sb.localCount - sa.localCount;
      if (sb.localTs !== sa.localTs) return sb.localTs - sa.localTs;
      if (sb.serverCount !== sa.serverCount) return sb.serverCount - sa.serverCount;
      if (sb.serverTs !== sa.serverTs) return sb.serverTs - sa.serverTs;
      return String(a.title || '').localeCompare(String(b.title || ''));
    });
  }

  function selectedScript(){
    return state.scripts.find(script => String(script.id) === String(state.selectedId)) || rankedScripts()[0] || null;
  }

  async function loadScripts(preserveSelection){
    const data = await api({ action: 'call_script_list' }).catch(() => ({}));
    state.scripts = Array.isArray(data.scripts) ? data.scripts : [];
    state.canManage = !!data.can_manage;
    const current = selectedScript();
    if (!preserveSelection || !current) {
      state.selectedId = state.scripts[0] ? String(rankedScripts()[0].id) : '';
      persistLocalState();
    }
    render();
  }

  async function touchScript(id){
    if (!id || state.touchedThisSession.has(id)) return;
    state.touchedThisSession.add(id);
    const rec = state.usage[id] || { count: 0, lastUsedAt: 0 };
    rec.count = Number(rec.count || 0) + 1;
    rec.lastUsedAt = Math.floor(Date.now() / 1000);
    state.usage[id] = rec;
    persistLocalState();
    api({ action: 'call_script_touch', id }).catch(() => ({}));
  }

  function selectScript(id){
    if (!id) return;
    state.selectedId = String(id);
    persistLocalState();
    render();
    touchScript(String(id));
  }

  function ensureStyles(){
    if (document.getElementById('callScriptsStyles')) return;
    const style = document.createElement('style');
    style.id = 'callScriptsStyles';
    style.textContent = `
      :root{--call-script-width:840px}
      .call-scripts-fab{position:fixed;right:22px;bottom:22px;z-index:3100;border:none;border-radius:999px;background:#d93025;color:#fff;width:42px;height:42px;padding:0;font:inherit;font-weight:900;box-shadow:0 12px 30px rgba(217,48,37,.28);cursor:pointer;display:flex;align-items:center;justify-content:center;gap:0}
      .call-scripts-fab i{font-size:15px}
      .call-scripts-drawer{position:fixed;top:0;right:0;width:var(--call-script-width);height:100vh;background:#fff;border-left:1px solid #dfe4ec;box-shadow:-12px 0 32px rgba(28,39,58,.12);z-index:3050;transform:translateX(100%);transition:transform .22s ease;display:flex;flex-direction:column}
      body.call-scripts-open .call-scripts-drawer{transform:translateX(0)}
      body.call-scripts-open .main-content{margin-right:var(--call-script-width)}
      body.call-scripts-open .lead-callback-shell{margin-right:calc(var(--call-script-width) + 22px)}
      .call-scripts-resize{position:absolute;left:-6px;top:0;width:12px;height:100%;cursor:col-resize;z-index:2}
      .call-scripts-resize::before{content:'';position:absolute;left:5px;top:50%;transform:translateY(-50%);width:2px;height:76px;border-radius:999px;background:#d6dde8}
      .call-scripts-resize::after{content:'⇠⇢';position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font-size:10px;font-weight:900;letter-spacing:-1px;color:#8b96a7;background:#fff;border:1px solid #d6dde8;border-radius:999px;padding:4px 3px;line-height:1;box-shadow:0 2px 8px rgba(24,34,52,.08)}
      .call-scripts-head{padding:14px 14px 10px;border-bottom:1px solid #edf1f6;background:#fff;position:sticky;top:0;z-index:2}
      .call-scripts-headtop{display:flex;justify-content:space-between;align-items:center;gap:10px}
      .call-scripts-headactions{display:flex;align-items:center;gap:8px}
      .call-scripts-title{font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:#607086}
      .call-scripts-tabrow{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px}
      .call-scripts-tabs{display:flex;gap:6px;flex-wrap:wrap;min-width:0}
      .call-scripts-tab{border:1px solid #d7dee9;background:#fff;border-radius:9px;padding:6px 10px;font:inherit;font-size:11px;font-weight:800;color:#4f6076;cursor:pointer}
      .call-scripts-tab.active{background:#1c273a;border-color:#1c273a;color:#fff}
      .call-scripts-topgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:10px}
      .call-scripts-shortcut{border:1px solid #e5c0bc;background:#fff;border-radius:9px;padding:6px 10px;font:inherit;font-size:11px;font-weight:800;color:#642c27;cursor:pointer;line-height:1.2;min-height:36px;display:flex;align-items:center;justify-content:center;text-align:center;white-space:normal;word-break:break-word;overflow-wrap:anywhere}
      .call-scripts-shortcut.active{background:#d93025;border-color:#d93025;color:#fff}
      .call-scripts-current{margin-top:12px;padding-top:12px;border-top:1px solid #e7ebf2}
      .call-scripts-current h3{margin:0;font-size:16px;line-height:1.2;color:#223040}
      .call-scripts-current p{margin:6px 0 0;font-size:12px;color:#697486;line-height:1.4}
      .call-scripts-body{flex:1;overflow:auto;padding:14px}
      .call-scripts-content{white-space:pre-wrap;line-height:1.5;font-size:14px;color:#243041}
      .call-tools-panel{display:grid;gap:14px}
      .call-tools-calc{display:grid;gap:14px}
      .call-tools-calc-hero{display:grid;gap:6px;padding:18px;border-radius:18px;background:linear-gradient(135deg,#fef2f2 0%,#fff 55%,#f6f8fb 100%);border:1px solid #f3d7d4}
      .call-tools-calc-eyebrow{font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.08em;color:#a4372f}
      .call-tools-calc-hero h3{margin:0;font-size:26px;line-height:1.05;font-weight:900;color:#1f2937;letter-spacing:-.03em}
      .call-tools-calc-hero h3 span{color:#d93025}
      .call-tools-calc-hero p{margin:0;font-size:13px;line-height:1.5;color:#5f6c7d}
      .call-tools-calc-field,.call-tools-linked-group,.call-tools-provider-group,.call-tools-other-section,.call-tools-breakdown-section,.call-tools-empty{border:1px solid #e5e9f0;border-radius:16px;background:#fff;padding:14px}
      .call-tools-calc-field{display:grid;gap:10px}
      .call-tools-calc-field-label{display:flex;align-items:center;justify-content:space-between;gap:10px}
      .call-tools-calc-field-label span{font-size:12px;font-weight:800;color:#223040}
      .call-tools-calc-field-value{display:inline-flex;align-items:center;justify-content:center;min-width:54px;padding:6px 10px;border-radius:999px;background:#fee2e2;color:#b42318;font-size:12px;font-weight:900}
      .call-tools-calc-field-value.neutral{background:#eef2f7;color:#334155}
      .call-tools-range{appearance:none;width:100%;height:8px;border-radius:999px;background:#e5e7eb;outline:none}
      .call-tools-range::-webkit-slider-thumb{appearance:none;width:18px;height:18px;border-radius:50%;background:#d93025;border:2px solid #fff;box-shadow:0 2px 10px rgba(217,48,37,.28);cursor:pointer}
      .call-tools-range::-moz-range-thumb{width:18px;height:18px;border-radius:50%;background:#d93025;border:2px solid #fff;box-shadow:0 2px 10px rgba(217,48,37,.28);cursor:pointer}
      .call-tools-range.neutral::-webkit-slider-thumb{background:#374151;box-shadow:0 2px 10px rgba(55,65,81,.25)}
      .call-tools-range.neutral::-moz-range-thumb{background:#374151;box-shadow:0 2px 10px rgba(55,65,81,.25)}
      .call-tools-range-labels{display:flex;justify-content:space-between;gap:8px;font-size:10px;font-weight:800;color:#8b95a8;text-transform:uppercase}
      .call-tools-linked-group{display:grid;gap:14px}
      .call-tools-linked-sliders{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
      .call-tools-linked-title{font-size:13px;font-weight:900;color:#223040}
      .call-tools-linked-copy{margin:-6px 0 0;font-size:12px;line-height:1.5;color:#6b7280}
      .call-tools-provider-group{display:grid;gap:10px}
      .call-tools-provider-label{font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.06em;color:#6b7280}
      .call-tools-provider-chips{display:flex;gap:8px;flex-wrap:wrap}
      .call-tools-provider-chip{border:1px solid #d7dee9;background:#fff;border-radius:999px;padding:9px 12px;font:inherit;font-size:12px;font-weight:800;color:#445366;cursor:pointer}
      .call-tools-provider-chip.active{background:#d93025;border-color:#d93025;color:#fff;box-shadow:0 10px 24px rgba(217,48,37,.18)}
      .call-tools-other-section{display:grid;gap:12px}
      .call-tools-other-copy{margin:0;font-size:12px;line-height:1.5;color:#6b7280}
      .call-tools-other-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
      .call-tools-money-input{display:grid;grid-template-columns:auto 1fr;align-items:center;gap:10px;padding:12px;border:1px solid #d7dee9;border-radius:14px;background:#fbfcfe}
      .call-tools-money-input .prefix{font-size:18px;font-weight:900;color:#223040}
      .call-tools-money-input .type{grid-column:1 / -1;font-size:11px;font-weight:800;color:#6b7280}
      .call-tools-input{width:100%;box-sizing:border-box;padding:0;border:none;background:transparent;font:inherit;font-size:16px;font-weight:800;color:#1f2937;outline:none}
      .call-tools-run{border:none;border-radius:14px;background:#d93025;color:#fff;padding:13px 16px;font:inherit;font-size:13px;font-weight:900;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:8px;box-shadow:0 12px 24px rgba(217,48,37,.2)}
      .call-tools-result{display:grid;gap:6px;padding:18px;border-radius:18px;background:#111827;color:#fff}
      .call-tools-result .sub{font-size:12px;font-weight:700;color:#f3f4f6}
      .call-tools-result .big{font-size:34px;font-weight:900;line-height:1;letter-spacing:-.04em}
      .call-tools-result .big span{font-size:18px;font-weight:800;color:#fca5a5}
      .call-tools-breakdown{display:grid;gap:12px}
      .call-tools-breakdown-section{display:grid;gap:12px}
      .call-tools-breakdown-section.fm{border-color:#b8e0c9;background:#f6fdf8}
      .call-tools-breakdown-header{font-size:13px;font-weight:900;color:#223040}
      .call-tools-breakdown-rows{display:grid;gap:10px}
      .call-tools-breakdown-row{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
      .call-tools-breakdown-label{font-size:12px;font-weight:800;color:#223040}
      .call-tools-breakdown-calc{margin-top:4px;font-size:11px;line-height:1.45;color:#6b7280}
      .call-tools-breakdown-amount{font-size:13px;font-weight:900;color:#111827;white-space:nowrap}
      .call-tools-breakdown-total{display:flex;justify-content:space-between;gap:12px;align-items:center;padding-top:12px;border-top:1px solid #e5e7eb}
      .call-tools-breakdown-total.negative .call-tools-breakdown-amount{color:#b42318}
      .call-tools-breakdown-total.positive .call-tools-breakdown-amount{color:#1a8a4a}
      .call-tools-breakdown-total-label{font-size:12px;font-weight:900;color:#223040}
      .call-tools-breakdown-badge{display:inline-flex;align-items:center;margin-left:6px;padding:4px 8px;border-radius:999px;background:#dcfce7;color:#166534;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.04em}
      .call-tools-empty{font-size:13px;line-height:1.6;color:#5f6c7d}
      .call-tools-comparison-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
      .call-tools-comparison-head h3{margin:0;font-size:22px;font-weight:900;letter-spacing:-.03em;color:#223040}
      .call-tools-comparison-head p{margin:6px 0 0;font-size:13px;line-height:1.55;color:#667487}
      .call-tools-comparison-wrap{overflow:auto;border:1px solid #e5e7eb;border-radius:18px;background:#fff}
      .call-tools-table{width:100%;min-width:760px;border-collapse:collapse;font-size:13px}
      .call-tools-table th,.call-tools-table td{padding:14px 12px;border:1px solid #d1d5db}
      .call-tools-table th{font-size:11px;font-weight:900;letter-spacing:.04em;text-transform:uppercase}
      .call-tools-table th.is-dark{background:#44403c;color:#fff}
      .call-tools-table th.is-brand{background:#ef1d14;color:#fff}
      .call-tools-table th .stack{display:inline-grid;gap:2px;justify-items:center;line-height:1.05}
      .call-tools-table td{color:#4b5563;background:#fff}
      .call-tools-table td.is-feature{font-weight:800;color:#4b5563}
      .call-tools-table td.is-firstmate{color:#374151;font-weight:800}
      .call-tools-table td.is-status-cell{padding:10px 8px}
      .call-tools-status{display:inline-flex;align-items:center;justify-content:center;gap:8px}
      .call-tools-status-icon{width:24px;height:24px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:900}
      .call-tools-status-icon.yes{background:#dcfce7;color:#166534;border:1px solid #bbf7d0}
      .call-tools-status-icon.no{background:#fee2e2;color:#b42318;border:1px solid #fecaca}
      .call-tools-status-pill{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:999px;background:#fff7ed;color:#9a3412;border:1px solid #fdba74;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.04em}
      .call-tools-status-tip{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:#fff;color:#9a3412;border:1px solid rgba(154,52,18,.25);font-size:11px;font-weight:900;cursor:help}
      .call-scripts-empty{padding:28px 16px;color:#7d8897;text-align:center}
      .call-scripts-manager{padding:22px}
      .call-scripts-manager-list{display:grid;gap:10px;margin-top:16px}
      .call-scripts-manager-item{border:1px solid #e4e8ef;border-radius:12px;padding:12px;background:#fff}
      .call-scripts-manager-meta{font-size:11px;color:#6d7787;margin-top:6px}
      .call-scripts-manager-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
      .call-scripts-overlay{position:fixed;inset:0;background:rgba(12,18,28,.32);z-index:3040;display:none}
      body.call-scripts-open .call-scripts-overlay{display:block}
      .call-script-editor-grid{display:grid;gap:12px}
      .call-script-editor-grid input,.call-script-editor-grid textarea{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #ced5df;border-radius:10px;font:inherit}
      .call-script-editor-shell{display:flex;flex-direction:column;height:100%}
      .call-script-editor-top{display:grid;gap:12px;padding:18px 18px 0}
      .call-script-editor-toolbar{display:flex;gap:8px;flex-wrap:wrap;padding:10px 18px;border-top:1px solid #edf1f6;border-bottom:1px solid #edf1f6;background:#fafbfc}
      .call-script-editor-toolbar button{border:1px solid #d7dee9;background:#fff;border-radius:8px;padding:8px 10px;font:inherit;font-size:12px;font-weight:800;color:#324155;cursor:pointer}
      .call-script-editor-work{flex:1;overflow:auto;padding:18px}
      .call-script-editor-rich{min-height:100%;padding:16px;border:1px solid #d8dde7;border-radius:12px;background:#fff;font-size:15px;line-height:1.6;color:#243041;outline:none}
      .call-script-editor-rich:empty:before{content:attr(data-placeholder);color:#97a1af}
      .call-script-editor-status{font-size:12px;font-weight:800;color:#687487}
      @media (max-width: 1320px){:root{--call-script-width:760px}}
      @media (max-width: 1180px){
        :root{--call-script-width:680px}
        .call-tools-linked-sliders,.call-tools-other-grid{grid-template-columns:minmax(0,1fr)}
      }
      @media (max-width: 860px){
        :root{--call-script-width:min(100vw,560px)}
        body.call-scripts-open .main-content,body.call-scripts-open .lead-callback-shell{margin-right:0}
        .call-scripts-topgrid{grid-template-columns:repeat(2,minmax(0,1fr))}
        .call-tools-calc-hero h3{font-size:24px}
      }
      @media (max-width: 460px){
        .call-scripts-topgrid{grid-template-columns:minmax(0,1fr)}
        .call-tools-provider-chips{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}
      }
    `;
    document.head.appendChild(style);
  }

  function ensureShell(){
    if (document.getElementById('callScriptsFab')) return;
    const fab = document.createElement('button');
    fab.id = 'callScriptsFab';
    fab.className = 'call-scripts-fab';
    fab.setAttribute('aria-label', 'Tools');
    fab.setAttribute('title', 'Tools');
    fab.innerHTML = '<i class="fas fa-screwdriver-wrench"></i>';
    document.body.appendChild(fab);

    const overlay = document.createElement('div');
    overlay.id = 'callScriptsOverlay';
    overlay.className = 'call-scripts-overlay';
    document.body.appendChild(overlay);

    const drawer = document.createElement('aside');
    drawer.id = 'callScriptsDrawer';
    drawer.className = 'call-scripts-drawer';
    drawer.innerHTML = `
      <div class="call-scripts-resize" id="callScriptsResizeHandle" title="Resize tools panel"></div>
      <div class="call-scripts-head">
        <div class="call-scripts-headtop">
          <div class="call-scripts-title">Tools</div>
          <button class="btn-secondary" type="button" id="callScriptsCloseBtn"><i class="fas fa-times"></i></button>
        </div>
        <div id="callScriptsTop"></div>
      </div>
      <div class="call-scripts-body" id="callScriptsBody"></div>
    `;
    document.body.appendChild(drawer);
    applyWidth();
  }

  function applyWidth(){
    document.documentElement.style.setProperty('--call-script-width', `${clampWidth(state.width)}px`);
  }

  function setActiveTab(tab){
    state.activeTab = ['scripts', 'calculator', 'comparison'].includes(tab) ? tab : 'scripts';
    renderDrawer();
  }

  function updateCalculatorField(key, value){
    state.calc = {
      ...state.calc,
      [key]: value,
      calculated: false,
    };
    renderDrawer();
  }

  function updateCalculatorShare(key, value){
    const next = Math.max(0, Math.min(100, Number(value || 0) || 0));
    state.calc = {
      ...state.calc,
      [key]: next,
      [key === 'residentialPct' ? 'commercialPct' : 'residentialPct']: 100 - next,
      calculated: false,
    };
    renderDrawer();
  }

  function updateReportsSlider(value){
    const sliderValue = Math.max(0, Math.min(100, Number(value || 0) || 0));
    state.calc = {
      ...state.calc,
      reportsSliderValue: sliderValue,
      reportsPerWeek: reportsPerWeekFromSlider(sliderValue),
      calculated: false,
    };
    renderDrawer();
  }

  function runCalculator(){
    state.calc = {
      ...state.calc,
      calculated: true,
    };
    renderDrawer();
  }

  function toggleDrawer(open){
    state.open = typeof open === 'boolean' ? open : !state.open;
    document.body.classList.toggle('call-scripts-open', !!state.open);
  }

  function drawerTabsHtml(){
    const tabs = [
      ['scripts', 'Scripts'],
      ['calculator', 'Calculator'],
      ['comparison', 'Comparison'],
    ];
    return `
      <div class="call-scripts-tabrow">
        <div class="call-scripts-tabs">
          ${tabs.map(([value, label]) => `
            <button type="button" class="call-scripts-tab ${state.activeTab === value ? 'active' : ''}" data-tools-tab="${esc(value)}">${esc(label)}</button>
          `).join('')}
        </div>
      </div>
    `;
  }

  function scriptsPanelHtml(){
    const ranked = rankedScripts();
    if (!ranked.length) return '<div class="call-scripts-empty">No tools yet.</div>';
    const shown = state.expanded ? ranked : ranked.slice(0, 9);
    const buttons = shown.map(script => `
      <button type="button" class="call-scripts-shortcut ${String(script.id) === String(state.selectedId) ? 'active' : ''}" data-script-open="${esc(script.id)}" title="${esc(script.title)}">${esc(script.title)}</button>
    `);
    if (ranked.length > 9) {
      buttons.push(`<button type="button" class="call-scripts-shortcut" data-script-more>${state.expanded ? 'Less' : 'More'}</button>`);
    }
    const active = selectedScript();
    return `
      <div class="call-scripts-topgrid">${buttons.join('')}</div>
      ${active ? `<div class="call-scripts-current"><h3>${esc(active.title)}</h3>${active.description ? `<p>${esc(active.description)}</p>` : ''}</div><div class="call-scripts-content">${active.body || ''}</div>` : '<div class="call-scripts-empty">No tool selected.</div>'}
    `;
  }

  function calculatorPanelHtml(){
    const calc = state.calc || {};
    const providers = calculatorProviders();
    const provider = currentProvider();
    const result = calc.calculated ? calculatorResult(calc) : null;
    const breakdown = calculatorBreakdown(result);
    return `
      <div class="call-tools-panel call-tools-calc">
        <div class="call-tools-calc-hero">
          <div class="call-tools-calc-eyebrow">Savings Calculator</div>
          <h3>See How Much You'll <span>Save</span></h3>
          <p>Adjust the same provider and report-mix inputs from the public calculator, then run the savings breakdown.</p>
        </div>
        <div class="call-tools-calc-field">
          <div class="call-tools-calc-field-label">
            <span>Reports per week</span>
            <div class="call-tools-calc-field-value">${esc(String(Math.max(1, Number(calc.reportsPerWeek || 10))))}</div>
          </div>
          <input class="call-tools-range" type="range" min="0" max="100" value="${esc(String(Math.max(0, Math.min(100, Number(calc.reportsSliderValue ?? 12) || 12))))}" data-tools-calc-reports-slider data-slider-tone="red">
          <div class="call-tools-range-labels"><span>1</span><span>25</span><span>75</span><span>150</span></div>
        </div>
        <div class="call-tools-linked-group">
          <div class="call-tools-linked-sliders">
            <div class="call-tools-calc-field">
              <div class="call-tools-calc-field-label">
                <span>Residential</span>
                <div class="call-tools-calc-field-value neutral">${esc(String(Math.max(0, Math.min(100, Number(calc.residentialPct ?? 80) || 0))))}%</div>
              </div>
              <input class="call-tools-range neutral" type="range" min="0" max="100" value="${esc(String(Math.max(0, Math.min(100, Number(calc.residentialPct ?? 80) || 0))))}" data-tools-calc-residential data-slider-tone="neutral">
            </div>
            <div class="call-tools-calc-field">
              <div class="call-tools-calc-field-label">
                <span>Commercial & Multi-Family</span>
                <div class="call-tools-calc-field-value neutral">${esc(String(Math.max(0, Math.min(100, Number(calc.commercialPct ?? 20) || 0))))}%</div>
              </div>
              <input class="call-tools-range neutral" type="range" min="0" max="100" value="${esc(String(Math.max(0, Math.min(100, Number(calc.commercialPct ?? 20) || 0))))}" data-tools-calc-commercial data-slider-tone="neutral">
            </div>
          </div>
        </div>
        <div class="call-tools-provider-group">
          <div class="call-tools-provider-label">Current Provider</div>
          <div class="call-tools-provider-chips">
            ${providers.map((item) => `
              <button class="call-tools-provider-chip ${item.id === provider?.id ? 'active' : ''}" type="button" data-tools-calc-provider-chip="${esc(item.id)}">${esc(item.name)}</button>
            `).join('')}
          </div>
        </div>
        ${provider?.id === 'eagleview' ? `
          <div class="call-tools-linked-group">
            <div class="call-tools-linked-title">What type of reports do you order?</div>
            <p class="call-tools-linked-copy">Use BidPerfect and Premium percentages the same way the public calculator does. Commercial stays on its own EagleView pricing.</p>
            <div class="call-tools-linked-sliders">
              <div class="call-tools-calc-field">
                <div class="call-tools-calc-field-label">
                  <span>BidPerfect</span>
                  <div class="call-tools-calc-field-value neutral">${esc(String(Math.max(0, Math.min(100, Number(calc.bidPct ?? 100) || 0))))}%</div>
                </div>
                <input class="call-tools-range neutral" type="range" min="0" max="100" value="${esc(String(Math.max(0, Math.min(100, Number(calc.bidPct ?? 100) || 0))))}" data-tools-calc-bid data-slider-tone="neutral">
              </div>
              <div class="call-tools-calc-field">
                <div class="call-tools-calc-field-label">
                  <span>Premium</span>
                  <div class="call-tools-calc-field-value neutral">${esc(String(Math.max(0, Math.min(100, Number(calc.premiumPct ?? 20) || 0))))}%</div>
                </div>
                <input class="call-tools-range neutral" type="range" min="0" max="100" value="${esc(String(Math.max(0, Math.min(100, Number(calc.premiumPct ?? 20) || 0))))}" data-tools-calc-premium data-slider-tone="neutral">
              </div>
            </div>
          </div>
        ` : ''}
        ${provider?.id === 'other' ? `
          <div class="call-tools-other-section">
            <div class="call-tools-provider-label">How much do you currently pay per report?</div>
            <p class="call-tools-other-copy">Enter the residential and commercial prices for the provider you want to compare against.</p>
            <div class="call-tools-other-grid">
              <label class="call-tools-money-input">
                <span class="prefix">$</span>
                <input class="call-tools-input" type="number" min="0" max="999" step="0.01" value="${esc(String(Math.max(0, Number(calc.otherResPrice ?? 20) || 0)))}" data-tools-calc-other-res>
                <span class="type">Residential</span>
              </label>
              <label class="call-tools-money-input">
                <span class="prefix">$</span>
                <input class="call-tools-input" type="number" min="0" max="999" step="0.01" value="${esc(String(Math.max(0, Number(calc.otherComPrice ?? 40) || 0)))}" data-tools-calc-other-com>
                <span class="type">Commercial & Multi-Family</span>
              </label>
            </div>
          </div>
        ` : ''}
        <button class="call-tools-run" type="button" data-tools-calc-run>
          <i class="fas fa-arrow-right"></i> Calculate My Savings
        </button>
        ${result ? `
          <div class="call-tools-result">
            <div class="sub">Based on this mix, you could save:</div>
            <div class="big">${esc(fmtUsd(result.annualSavings))} <span>per year</span></div>
            <div class="sub">That's ${esc(String(result.pctSaved))}% less than ${esc(result.providerLabel)}.</div>
          </div>
          <div class="call-tools-breakdown">
            ${breakdown.map((section) => `
              <div class="call-tools-breakdown-section ${section.tone === 'positive' ? 'fm' : ''}">
                <div class="call-tools-breakdown-header">${esc(section.heading || 'Cost')}</div>
                <div class="call-tools-breakdown-rows">
                  ${(section.rows || []).map((row) => `
                    <div class="call-tools-breakdown-row">
                      <div>
                        <div class="call-tools-breakdown-label">${esc(row.label || '-')}</div>
                        <div class="call-tools-breakdown-calc">${esc(row.calc || '')}</div>
                      </div>
                      <div class="call-tools-breakdown-amount">${esc(row.amount || fmtUsd(0))}</div>
                    </div>
                  `).join('')}
                </div>
                <div class="call-tools-breakdown-total ${section.tone === 'positive' ? 'positive' : 'negative'}">
                  <div class="call-tools-breakdown-total-label">Annual Total${section.totalMeta ? ` <span class="call-tools-breakdown-badge">${esc(section.totalMeta)}</span>` : ''}</div>
                  <div class="call-tools-breakdown-amount">${esc(section.totalAmount || fmtUsd(0))}</div>
                </div>
              </div>
            `).join('')}
          </div>
        ` : `
          <div class="call-tools-empty">
            Choose the provider details and click <strong>Calculate My Savings</strong> to see the full hard-coded savings breakdown.
          </div>
        `}
      </div>
    `;
  }

  function comparisonPanelHtml(){
    const matrix = toolsComparisonMatrix();
    return `
      <div class="call-tools-panel">
        <div class="call-tools-comparison-head">
          <div>
            <h3>${esc(matrix.title)}</h3>
            <p>Static feature comparison for FirstMate and the main roof measurement report providers.</p>
          </div>
        </div>
        <div class="call-tools-comparison-wrap">
          <table class="call-tools-table">
            <thead>
              <tr>
                ${matrix.columns.map((column) => `
                  <th class="${column.tone === 'dark' ? 'is-dark' : 'is-brand'}" style="text-align:${column.key === 'feature' ? 'left' : 'center'}">${Array.isArray(column.headerLines) ? `<span class="stack">${column.headerLines.map((line) => `<span>${esc(line)}</span>`).join('')}</span>` : esc(column.label)}</th>
                `).join('')}
              </tr>
            </thead>
            <tbody>
              ${matrix.rows.map((row) => `
                <tr>
                  ${matrix.columns.map((column) => `
                    <td class="${column.key === 'feature' ? 'is-feature' : column.key === 'firstmate' ? 'is-firstmate is-status-cell' : column.key !== 'feature' ? 'is-status-cell' : ''}" style="text-align:${column.key === 'feature' ? 'left' : 'center'}">${column.key === 'feature' ? esc(row[column.key] || '-') : comparisonCellHtml(row[column.key] || '-')}</td>
                  `).join('')}
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  function renderDrawer(){
    const top = document.getElementById('callScriptsTop');
    const body = document.getElementById('callScriptsBody');
    if (!top || !body) return;
    top.innerHTML = drawerTabsHtml();
    if (state.activeTab === 'calculator') {
      body.innerHTML = calculatorPanelHtml();
      syncCalculatorVisuals(body);
      return;
    }
    if (state.activeTab === 'comparison') {
      body.innerHTML = comparisonPanelHtml();
      syncCalculatorVisuals(body);
      return;
    }
    body.innerHTML = scriptsPanelHtml();
    syncCalculatorVisuals(body);
  }

  function ensureManagerView(){
    if (!window.Portal) return;
    if (!document.getElementById('view-call-scripts')) {
      const host = document.getElementById('portalPluginViews');
      if (!host) return;
      const view = document.createElement('div');
      view.id = 'view-call-scripts';
      view.style.display = 'none';
      host.appendChild(view);
    }
    if (!window.Portal.__callScriptsPluginRegistered) {
      window.Portal.registerPlugin({ id: 'call-scripts', title: 'Tools', iconClass: 'fas fa-screwdriver-wrench' });
      const prevSwitchView = window.Portal.switchView.bind(window.Portal);
      window.Portal.switchView = async function(id, btn){
        const result = await prevSwitchView(id, btn);
        if (id === 'call-scripts') renderManagerView();
        return result;
      };
      window.Portal.__callScriptsPluginRegistered = true;
    }
  }

  function renderManagerView(){
    const host = document.getElementById('view-call-scripts');
    if (!host) return;
    const canEdit = canManage();
    host.innerHTML = `
      <div class="header-bar">
        <h1>Tools</h1>
        <div style="display:flex;gap:10px;">
          <button class="btn-secondary" type="button" id="callScriptsRefreshBtn"><i class="fas fa-sync"></i> Refresh</button>
          ${canEdit ? '<button class="btn-primary" type="button" id="callScriptsNewBtn"><i class="fas fa-plus"></i> New Script</button>' : ''}
        </div>
      </div>
      <div class="call-scripts-manager">
        <div class="panel-card" style="max-width:none;margin:0;">
          <div style="font-size:13px;color:#5f6c7d;line-height:1.5;">Managers can create and maintain the call script library here. Salespeople can read every script from the floating drawer at any time.</div>
        </div>
        <div class="call-scripts-manager-list">
          ${state.scripts.length ? state.scripts.map(script => `
            <div class="call-scripts-manager-item">
              <div style="font-size:16px;font-weight:900;color:#223040;">${esc(script.title)}</div>
              ${script.description ? `<div style="margin-top:6px;font-size:13px;color:#5d6979;">${esc(script.description)}</div>` : ''}
              <div class="call-scripts-manager-meta">Created ${esc(fmtTs(script.created_at))} by ${esc(script.created_by_email || '-')} • Updated ${esc(fmtTs(script.updated_at))} by ${esc(script.updated_by_email || '-')}</div>
              <div class="call-scripts-manager-actions">
                <button class="btn-secondary" type="button" data-script-open-page="${esc(script.id)}">Open In Drawer</button>
                ${canEdit ? `<button class="btn-primary" type="button" data-script-edit="${esc(script.id)}">Edit</button><button class="btn-danger" type="button" data-script-delete="${esc(script.id)}">Delete</button>` : ''}
              </div>
            </div>
          `).join('') : '<div class="call-scripts-empty">No tools yet.</div>'}
        </div>
      </div>
    `;
  }

  function ensureEditorModal(){
    if (document.getElementById('callScriptEditorModal')) return;
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'callScriptEditorModal';
    modal.innerHTML = `
      <div class="modal-card" style="width:min(1480px,98vw);height:94vh;max-height:94vh;">
        <div class="modal-header">
          <h2 id="callScriptEditorTitle">Call Script</h2>
          <div style="display:flex;align-items:center;gap:10px;">
            <div class="call-script-editor-status" id="callScriptEditorDirty">Saved</div>
            <button type="button" id="callScriptEditorCloseBtn" style="border:none;background:none;cursor:pointer;"><i class="fas fa-times"></i></button>
          </div>
        </div>
        <div class="modal-body" style="padding:0;overflow:hidden;">
          <div class="call-script-editor-shell">
            <div class="call-script-editor-top">
              <input type="hidden" id="callScriptEditorId">
              <div class="call-script-editor-grid">
                <div>
                  <label style="display:block;font-size:11px;font-weight:900;text-transform:uppercase;color:#6c7685;margin-bottom:6px;">Title</label>
                  <input id="callScriptEditorName" type="text" placeholder="Script title">
                </div>
                <div>
                  <label style="display:block;font-size:11px;font-weight:900;text-transform:uppercase;color:#6c7685;margin-bottom:6px;">Description</label>
                  <input id="callScriptEditorDescription" type="text" placeholder="What this script is for">
                </div>
              </div>
            </div>
            <div class="call-script-editor-toolbar">
              <button type="button" data-script-cmd="bold"><i class="fas fa-bold"></i></button>
              <button type="button" data-script-cmd="italic"><i class="fas fa-italic"></i></button>
              <button type="button" data-script-cmd="underline"><i class="fas fa-underline"></i></button>
              <button type="button" data-script-cmd="insertUnorderedList"><i class="fas fa-list-ul"></i></button>
              <button type="button" data-script-cmd="insertOrderedList"><i class="fas fa-list-ol"></i></button>
              <button type="button" data-script-cmd="formatBlock" data-script-value="h3">Heading</button>
              <button type="button" data-script-cmd="formatBlock" data-script-value="p">Paragraph</button>
              <button type="button" data-script-cmd="removeFormat">Clear</button>
            </div>
            <div class="call-script-editor-work">
              <div id="callScriptEditorRich" class="call-script-editor-rich" contenteditable="true" data-placeholder="Write the full call script here..."></div>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" type="button" id="callScriptEditorCancelBtn">Cancel</button>
          <button class="btn-secondary" type="button" id="callScriptEditorSaveOnlyBtn">Save</button>
          <button class="btn-primary" type="button" id="callScriptEditorSaveBtn">Save & Exit</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  function openEditor(script){
    ensureEditorModal();
    const title = script?.title || '';
    const description = script?.description || '';
    const body = normalizeScriptBodyForEditor(script?.body || '');
    document.getElementById('callScriptEditorId').value = script?.id || '';
    document.getElementById('callScriptEditorName').value = title;
    document.getElementById('callScriptEditorName').dataset.initialValue = title;
    document.getElementById('callScriptEditorDescription').value = description;
    document.getElementById('callScriptEditorDescription').dataset.initialValue = description;
    document.getElementById('callScriptEditorRich').innerHTML = body;
    state.editorSnapshot = body;
    state.editorDirty = false;
    updateEditorDirty();
    (window.Portal?.openModal || ((id) => { const el = document.getElementById(id); if (el) el.style.display = 'flex'; }))('callScriptEditorModal');
  }

  function closeEditor(force){
    if (!force) return maybeCancelEditor();
    (window.Portal?.closeModal || ((id) => { const el = document.getElementById(id); if (el) el.style.display = 'none'; }))('callScriptEditorModal');
  }

  async function saveEditor(closeAfter){
    const payload = {
      action: 'call_script_save',
      id: document.getElementById('callScriptEditorId').value || '',
      title: document.getElementById('callScriptEditorName').value || '',
      description: document.getElementById('callScriptEditorDescription').value || '',
      body: currentEditorHtml(),
    };
    const data = await api(payload).catch(() => ({}));
    if (!data.success) return alert(data.error || 'Could not save script.');
    state.editorSnapshot = currentEditorHtml();
    document.getElementById('callScriptEditorName').dataset.initialValue = payload.title;
    document.getElementById('callScriptEditorDescription').dataset.initialValue = payload.description;
    updateEditorDirty();
    if (closeAfter) closeEditor(true);
    await loadScripts(true);
    renderManagerView();
  }

  async function deleteScript(id){
    if (!confirm('Delete this call script?')) return;
    const data = await api({ action: 'call_script_delete', id }).catch(() => ({}));
    if (!data.success) return alert(data.error || 'Could not delete script.');
    if (String(state.selectedId) === String(id)) state.selectedId = '';
    await loadScripts(false);
    renderManagerView();
  }

  function render(){
    renderDrawer();
    renderManagerView();
  }

  function bindEvents(){
    let resizeActive = false;
    document.addEventListener('click', (e) => {
      if (e.target.closest('#callScriptsFab')) {
        toggleDrawer();
        if (state.open && state.scripts.length && !state.selectedId) selectScript(rankedScripts()[0]?.id || '');
        return;
      }
      if (e.target.closest('#callScriptsCloseBtn') || e.target.closest('#callScriptsOverlay')) {
        toggleDrawer(false);
        return;
      }
      const tabBtn = e.target.closest('[data-tools-tab]');
      if (tabBtn) {
        setActiveTab(tabBtn.getAttribute('data-tools-tab') || 'scripts');
        return;
      }
      const openBtn = e.target.closest('[data-script-open]');
      if (openBtn) {
        setActiveTab('scripts');
        selectScript(openBtn.getAttribute('data-script-open'));
        return;
      }
      if (e.target.closest('[data-script-more]')) {
        state.expanded = !state.expanded;
        persistLocalState();
        renderDrawer();
        return;
      }
      const pageOpen = e.target.closest('[data-script-open-page]');
      if (pageOpen) {
        selectScript(pageOpen.getAttribute('data-script-open-page'));
        toggleDrawer(true);
        return;
      }
      const editBtn = e.target.closest('[data-script-edit]');
      if (editBtn) {
        const script = state.scripts.find(item => String(item.id) === String(editBtn.getAttribute('data-script-edit')));
        openEditor(script || null);
        return;
      }
      const deleteBtn = e.target.closest('[data-script-delete]');
      if (deleteBtn) {
        deleteScript(deleteBtn.getAttribute('data-script-delete'));
        return;
      }
      if (e.target.closest('#callScriptsNewBtn')) {
        openEditor(null);
        return;
      }
      if (e.target.closest('#callScriptsRefreshBtn')) {
        loadScripts(true);
        return;
      }
      const providerChip = e.target.closest('[data-tools-calc-provider-chip]');
      if (providerChip) {
        syncCalculatorToProvider(providerChip.getAttribute('data-tools-calc-provider-chip') || 'eagleview', false);
        renderDrawer();
        return;
      }
      if (e.target.closest('[data-tools-calc-run]')) {
        runCalculator();
        return;
      }
      if (e.target.closest('#callScriptEditorCloseBtn') || e.target.closest('#callScriptEditorCancelBtn')) {
        closeEditor();
        return;
      }
      const cmdBtn = e.target.closest('[data-script-cmd]');
      if (cmdBtn) {
        execEditor(cmdBtn.getAttribute('data-script-cmd'), cmdBtn.getAttribute('data-script-value') || null);
        return;
      }
      if (e.target.closest('#callScriptEditorSaveOnlyBtn')) {
        saveEditor(false);
        return;
      }
      if (e.target.closest('#callScriptEditorSaveBtn')) {
        saveEditor(true);
        return;
      }
    });

    document.addEventListener('input', (e) => {
      if (e.target.closest('#callScriptEditorName') || e.target.closest('#callScriptEditorDescription') || e.target.closest('#callScriptEditorRich')) {
        updateEditorDirty();
        return;
      }
      if (e.target.matches('[data-tools-calc-reports-slider]')) {
        updateReportsSlider(e.target.value || 12);
        return;
      }
      if (e.target.matches('[data-tools-calc-residential]')) {
        updateCalculatorShare('residentialPct', e.target.value || 0);
        return;
      }
      if (e.target.matches('[data-tools-calc-commercial]')) {
        updateCalculatorShare('commercialPct', e.target.value || 0);
        return;
      }
      if (e.target.matches('[data-tools-calc-bid]')) {
        updateCalculatorField('bidPct', Math.max(0, Math.min(100, Number(e.target.value || 0) || 0)));
        return;
      }
      if (e.target.matches('[data-tools-calc-premium]')) {
        updateCalculatorField('premiumPct', Math.max(0, Math.min(100, Number(e.target.value || 0) || 0)));
        return;
      }
      if (e.target.matches('[data-tools-calc-other-res]')) {
        updateCalculatorField('otherResPrice', Math.max(0, Number(e.target.value || 0) || 0));
        return;
      }
      if (e.target.matches('[data-tools-calc-other-com]')) {
        updateCalculatorField('otherComPrice', Math.max(0, Number(e.target.value || 0) || 0));
      }
    });

    document.addEventListener('mousedown', (e) => {
      if (!e.target.closest('#callScriptsResizeHandle')) return;
      resizeActive = true;
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!resizeActive) return;
      state.width = clampWidth(window.innerWidth - e.clientX);
      applyWidth();
    });

    document.addEventListener('mouseup', () => {
      if (!resizeActive) return;
      resizeActive = false;
      document.body.style.userSelect = '';
      persistLocalState();
    });
  }

  function init(){
    loadLocalState();
    ensureStyles();
    ensureShell();
    ensureManagerView();
    ensureEditorModal();
    syncCalculatorToProvider(state.calc.provider || 'eagleview', true);
    bindEvents();
    loadScripts(true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  window.CallScripts = {
    init,
    open(options){
      const next = options || {};
      if (next.tab) state.activeTab = ['scripts', 'calculator', 'comparison'].includes(next.tab) ? next.tab : state.activeTab;
      if (next.scriptId) state.selectedId = String(next.scriptId);
      toggleDrawer(true);
      renderDrawer();
    },
    close(){ toggleDrawer(false); },
    reload(){ return loadScripts(true); },
    setTab(tab){ setActiveTab(tab); },
    selectScript(id){ if (id) { setActiveTab('scripts'); selectScript(id); } },
  };
})();
