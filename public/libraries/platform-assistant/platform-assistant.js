/* public/libraries/platform-assistant/platform-assistant.js
 * The global FirstMate AI assistant window: one chat in the shared workspace
 * opened from the top bar (closed by default). Talks to /v1/assistant via
 * window.AssistantAPI; renders markdown replies, "What changed" summaries,
 * and navigation chips that open projects or portal tabs.
 *
 * Navigation: one main thread (where scheduled agents report), collapsible
 * Agents and Side chats sections, search at the bottom. Opening an agent
 * shows its configuration with a small chat for changing it. In the full
 * workspace, panels (charts, metrics, tables) sit on a dashboard to the
 * left of the conversation; the composer stays centered underneath both.
 */
(function(){
  'use strict';
  if (!window.Portal || window.PlatformAssistant) return;

  const bookingScriptUrl = new URL('../appointment-booking/booking.js', document.currentScript?.src || new URL('/libraries/platform-assistant/platform-assistant.js', location.href)).href;
  let bookingScriptLoading;
  async function ensureBookingWidget(){
    if (window.FirstMateBooking) return;
    await (bookingScriptLoading ||= new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = bookingScriptUrl;
      script.onload = resolve;
      script.onerror = () => { bookingScriptLoading = null; script.remove(); reject(new Error('Could not load appointment booking.')); };
      document.head.append(script);
    }));
  }

  let stopActiveVoice = null;
  // Every surface owns its state, but uses this same renderer and controller.
  function createAssistant(surface = {}) {
  let embedded = Boolean(surface.container);
  let projectId = String(surface.projectId || '').trim();
  let document = surface.container?.ownerDocument || window.document;
  let promoted = false, transferring = false;
  let transferBarrier=Promise.resolve(), releaseTransfer=null;
  let disposed = false;
  const lifetime = new AbortController();
  const observers = [];
  const listen = (target, event, handler) => target.addEventListener(event, handler, {signal:lifetime.signal});
  const observeSize = (target, callback) => { const observer = new ResizeObserver(callback); observer.observe(target); observers.push(observer); };
  const AGENT_TIMEOUT_MS = 160000;
  const REFRESH_MS = 45000;
  const BOARD_MIN_WIDTH = 860;
  const clean = (value) => String(value ?? '').trim();
  const esc = (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const array = (value) => Array.isArray(value) ? value : [];
  const stored = (key, fallback) => { try { const value = localStorage.getItem(`fma:${key}`); return value === null ? fallback : JSON.parse(value); } catch (_) { return fallback; } };
  const store = (key, value) => { try { localStorage.setItem(`fma:${key}`, JSON.stringify(value)); } catch (_) {} };

  const state = {
    built:false,
    open:false,
    booted:false,
    booting:false,
    assistantName:'Assistant',
    mainThread:null,
    threads:[],
    agents:[],
    dashboard:[],
    paymentWidget:null,
    threadId:'',
    agentId:'',
    agentDetail:null,
    messages:[],
    attachments:[],
    pending:false,
    view:'chat', // chat | agent | settings
    settingsTab:'personalization',
    sidebarOpen:false,
    historyQuery:'',
    historyMatches:[],
    collapsed:stored('collapsed', {}),
    boardHidden:stored('boardHidden', false),
    boardWidth:stored('boardWidth', 50),
    boardSide:stored('boardSide', 'left'),
    mode:'docked',
    returnTab:''
  };

  let els = null;
  let bootPromise = null;
  let openingChannel = false;
  const conversationDrafts = new Map();
  const voiceChats = new Map();
  const voiceArchives = new Map();
  let assistantWindow = null;
  let voiceCall = null;
  let recorder = null;
  let recordingStream = null;
  let recordingStarted = 0;
  let recordingTimer = null;
  let waveformFrame = null;
  let audioContext = null;
  let historySearchTimer = null;
  let historySearchGeneration = 0;
  let refreshTimer = null;
  let boardRenderFrame = 0;

  function orgId(){ return clean(surface.orgId || (window.__APP || {}).userOrgId); }
  function branchId(){
    try { return clean(window.Portal.util?.currentBranchId?.() || (window.__APP || {}).userBranchId) || 'default'; }
    catch (_) { return 'default'; }
  }

  function available(){
    try {
      if (window.Portal.can && window.Portal.capabilities?.can) return window.Portal.can('apps.assistant') !== false;
    } catch (_) {}
    return true;
  }

  // ── Markdown (same minimal renderer as the stats agent chat) ─────────────

  function renderMarkdown(raw){
    const inline = (value) => esc(value)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    const out = [];
    let list = null;
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    String(raw ?? '').split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      const bullet = trimmed.match(/^[-*•]\s+(.*)$/);
      const numbered = trimmed.match(/^\d+[.)]\s+(.*)$/);
      const heading = trimmed.match(/^#{1,4}\s+(.*)$/);
      if (bullet) {
        if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
        out.push(`<li>${inline(bullet[1])}</li>`);
      } else if (numbered) {
        if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
        out.push(`<li>${inline(numbered[1])}</li>`);
      } else if (heading) {
        closeList();
        out.push(`<div class="fma-md-h">${inline(heading[1])}</div>`);
      } else if (!trimmed) {
        closeList();
        out.push('<div class="fma-md-gap"></div>');
      } else {
        closeList();
        out.push(`<div>${inline(line)}</div>`);
      }
    });
    closeList();
    return out.join('');
  }

  // ── Formatting ───────────────────────────────────────────────────────────

  function relativeTime(iso){
    const time = Date.parse(clean(iso));
    if (!Number.isFinite(time)) return '';
    const minutes = Math.round((Date.now() - time) / 60000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    if (hours < 48) return 'Yesterday';
    return new Date(time).toLocaleDateString(undefined, { month:'short', day:'numeric' });
  }

  function formatValue(value, unit, options = {}){
    const number = Number(value);
    if (!Number.isFinite(number)) return '';
    const compact = options.compact === true && Math.abs(number) >= 10000;
    if (unit === 'currency') {
      const digits = compact ? 1 : (Number.isInteger(number) || Math.abs(number) >= 100 ? 0 : 2);
      return new Intl.NumberFormat(undefined, { style:'currency', currency:options.currency || 'USD', notation:compact ? 'compact' : 'standard', minimumFractionDigits:0, maximumFractionDigits:digits }).format(number);
    }
    if (unit === 'percent') return `${new Intl.NumberFormat(undefined, { maximumFractionDigits:1 }).format(number)}%`;
    return new Intl.NumberFormat(undefined, { notation:compact ? 'compact' : 'standard', maximumFractionDigits:compact ? 1 : 2 }).format(number);
  }

  // ── Panels (declarative specs rendered locally, never model HTML) ─────

  // Validated categorical order (fixed, never cycled); single series use the brand color.
  const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
  const BRAND = 'var(--primary-readable,var(--primary,#175cd3))';

  function niceTicks(max, count = 4){
    if (!(max > 0)) return [0, 1];
    const raw = max / count;
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= raw) || raw;
    const ticks = [];
    for (let value = 0; value <= max + step * 0.001; value += step) ticks.push(Number(value.toFixed(10)));
    if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
    return ticks;
  }

  function legendHtml(series){
    if (series.length < 2) return '';
    return `<div class="fma-legend">${series.map((entry, index) => `<span><i style="background:${SERIES_COLORS[index % SERIES_COLORS.length]}"></i>${esc(entry.name || `Series ${index + 1}`)}</span>`).join('')}</div>`;
  }

  function tip(text){ return ` data-tip="${esc(text)}"`; }

  function cartesianSvg(widget, width){
    const labels = array(widget.labels);
    const series = array(widget.series).map(object);
    const unit = clean(widget.unit);
    const currency = clean(widget.currency) || 'USD';
    const values = series.flatMap((entry) => array(entry.values).map(Number));
    const minValue = Math.min(0, ...values);
    const maxValue = Math.max(0, ...values);
    const ticks = niceTicks(maxValue - minValue > 0 ? maxValue : 1);
    const top = ticks[ticks.length - 1] || 1;
    const bottom = minValue < 0 ? -niceTicks(-minValue).slice(-1)[0] : 0;
    const height = 220;
    const axisWidth = Math.min(72, 14 + Math.max(...ticks.map((tick) => formatValue(tick, unit, { compact:true, currency }).length)) * 6.6);
    const plot = { left:axisWidth, right:width - 10, top:12, bottom:height - 28 };
    const y = (value) => plot.bottom - ((value - bottom) / (top - bottom || 1)) * (plot.bottom - plot.top);
    const band = (plot.right - plot.left) / Math.max(1, labels.length);
    const labelSpace = Math.min(12, Math.max(...labels.map((label) => String(label).length), 1)) * 6.4 + 10;
    const labelEvery = Math.max(1, Math.ceil(labels.length / Math.max(1, Math.floor((plot.right - plot.left) / labelSpace))));
    const parts = [`<svg class="fma-chart" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(widget.title)}">`];
    ticks.concat(bottom < 0 ? [bottom] : []).forEach((tick) => {
      parts.push(`<line class="grid" x1="${plot.left}" x2="${plot.right}" y1="${y(tick)}" y2="${y(tick)}"/><text class="axis" x="${plot.left - 8}" y="${y(tick) + 4}" text-anchor="end">${esc(formatValue(tick, unit, { compact:true, currency }))}</text>`);
    });
    labels.forEach((label, index) => {
      if (index % labelEvery) return;
      const text = label.length > 12 ? `${label.slice(0, 11)}…` : label;
      parts.push(`<text class="axis" x="${plot.left + band * index + band / 2}" y="${height - 8}" text-anchor="middle">${esc(text)}</text>`);
    });
    const color = (index) => series.length > 1 ? SERIES_COLORS[index % SERIES_COLORS.length] : BRAND;
    if (clean(widget.kind) === 'line') {
      series.forEach((entry, seriesIndex) => {
        const points = array(entry.values).map((value, index) => [plot.left + band * index + band / 2, y(Number(value))]);
        if (!points.length) return;
        const path = points.map(([px, py], index) => `${index ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
        if (series.length === 1) parts.push(`<path d="${path} L${points[points.length - 1][0].toFixed(1)},${y(Math.max(0, bottom))} L${points[0][0].toFixed(1)},${y(Math.max(0, bottom))} Z" fill="${color(seriesIndex)}" opacity=".1"/>`);
        parts.push(`<path d="${path}" fill="none" stroke="${color(seriesIndex)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
        const [lastX, lastY] = points[points.length - 1];
        parts.push(`<circle cx="${lastX}" cy="${lastY}" r="4" fill="${color(seriesIndex)}" stroke="#fff" stroke-width="2"/>`);
        array(entry.values).forEach((value, index) => {
          parts.push(`<rect class="hit" x="${plot.left + band * index}" y="${plot.top}" width="${band}" height="${plot.bottom - plot.top}"${tip(`${labels[index] || ''}${entry.name ? ` · ${entry.name}` : ''}: ${formatValue(value, unit, { currency })}`)}/>`);
        });
      });
    } else {
      const groupWidth = Math.min(band * 0.72, 24 * series.length + 2 * (series.length - 1));
      const barWidth = Math.max(2, (groupWidth - 2 * (series.length - 1)) / Math.max(1, series.length));
      const zero = y(0);
      labels.forEach((label, index) => {
        series.forEach((entry, seriesIndex) => {
          const value = Number(array(entry.values)[index]) || 0;
          const x = plot.left + band * index + (band - groupWidth) / 2 + seriesIndex * (barWidth + 2);
          const barTop = Math.min(y(value), zero);
          const barHeight = Math.max(1, Math.abs(zero - y(value)));
          const radius = Math.min(4, barWidth / 2, barHeight);
          const d = value >= 0
            ? `M${x},${zero} V${barTop + radius} Q${x},${barTop} ${x + radius},${barTop} H${x + barWidth - radius} Q${x + barWidth},${barTop} ${x + barWidth},${barTop + radius} V${zero} Z`
            : `M${x},${zero} V${zero + barHeight - radius} Q${x},${zero + barHeight} ${x + radius},${zero + barHeight} H${x + barWidth - radius} Q${x + barWidth},${zero + barHeight} ${x + barWidth},${zero + barHeight - radius} V${zero} Z`;
          parts.push(`<path class="mark" d="${d}" fill="${color(seriesIndex)}"${tip(`${label}${entry.name ? ` · ${entry.name}` : ''}: ${formatValue(value, unit, { currency })}`)}/>`);
        });
      });
      parts.push(`<line class="baseline" x1="${plot.left}" x2="${plot.right}" y1="${zero}" y2="${zero}"/>`);
    }
    parts.push('</svg>');
    return parts.join('') + legendHtml(series);
  }

  function pieHtml(widget, width){
    const labels = array(widget.labels);
    const values = array(object(array(widget.series)[0]).values).map((value) => Math.max(0, Number(value) || 0));
    const unit = clean(widget.unit);
    const currency = clean(widget.currency) || 'USD';
    const total = values.reduce((sum, value) => sum + value, 0);
    const size = Math.max(120, Math.min(180, width * 0.42));
    const radius = size / 2 - 2;
    const inner = clean(widget.kind) === 'donut' ? radius * 0.62 : 0;
    const center = size / 2;
    let angle = -Math.PI / 2;
    const slices = values.map((value, index) => {
      const sweep = total ? (value / total) * Math.PI * 2 : 0;
      const start = angle;
      angle += sweep;
      if (!sweep) return '';
      const large = sweep > Math.PI ? 1 : 0;
      const point = (r, a) => `${(center + r * Math.cos(a)).toFixed(2)},${(center + r * Math.sin(a)).toFixed(2)}`;
      const end = sweep >= Math.PI * 2 - 1e-6 ? start + Math.PI * 2 - 1e-4 : angle;
      const d = inner
        ? `M${point(radius, start)} A${radius},${radius} 0 ${large} 1 ${point(radius, end)} L${point(inner, end)} A${inner},${inner} 0 ${large} 0 ${point(inner, start)} Z`
        : `M${center},${center} L${point(radius, start)} A${radius},${radius} 0 ${large} 1 ${point(radius, end)} Z`;
      const share = total ? Math.round((value / total) * 1000) / 10 : 0;
      return `<path class="mark" d="${d}" fill="${SERIES_COLORS[index % SERIES_COLORS.length]}" stroke="#fff" stroke-width="2"${tip(`${labels[index] || ''}: ${formatValue(value, unit, { currency })} (${share}%)`)}/>`;
    }).join('');
    const hole = inner ? `<text class="fma-pie-total" x="${center}" y="${center - 2}" text-anchor="middle">${esc(formatValue(total, unit, { compact:true, currency }))}</text><text class="axis" x="${center}" y="${center + 15}" text-anchor="middle">Total</text>` : '';
    const legend = labels.map((label, index) => {
      const value = values[index] || 0;
      const share = total ? Math.round((value / total) * 100) : 0;
      return `<li><i style="background:${SERIES_COLORS[index % SERIES_COLORS.length]}"></i><span class="name">${esc(label)}</span><span class="value">${esc(formatValue(value, unit, { currency }))}</span><span class="share">${share}%</span></li>`;
    }).join('');
    return `<div class="fma-pie"><svg class="fma-chart" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(widget.title)}">${slices}${hole}</svg><ul class="fma-pie-legend">${legend}</ul></div>`;
  }

  function metricsHtml(widget){
    const currency = clean(widget.currency) || 'USD';
    return `<div class="fma-metrics">${array(widget.metrics).map(object).map((metric) => {
      const trend = clean(metric.trend);
      const good = trend && trend !== 'flat' ? (trend === (clean(metric.good) || 'up') ? 'good' : 'bad') : '';
      const icon = trend === 'up' ? 'fa-arrow-up' : trend === 'down' ? 'fa-arrow-down' : '';
      return `<div class="fma-metric"><span class="label">${esc(metric.label)}</span><span class="value">${esc(formatValue(metric.value, clean(metric.unit), { compact:true, currency }))}</span>${metric.delta ? `<span class="delta ${good}">${icon ? `<i class="fas ${icon}" aria-hidden="true"></i>` : ''}${esc(metric.delta)}</span>` : ''}</div>`;
    }).join('')}</div>`;
  }

  function tableHtml(widget){
    const columns = array(widget.columns);
    const rows = array(widget.rows);
    return `<div class="fma-table-wrap"><table class="fma-table"><thead><tr>${columns.map((column) => `<th>${esc(column)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${array(row).map((cell) => typeof cell === 'number' ? `<td class="num">${esc(formatValue(cell, clean(widget.unit), { currency:clean(widget.currency) || 'USD' }))}</td>` : `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  // Legacy artifact payloads remain readable; new chat UI uses panels with child widgets.
  function chatPanel(value){
    const entry = object(value);
    return entry.type === 'artifact' ? {...entry,type:'panel',widgets:[{...entry,type:'visualization'}]} : entry;
  }

  function visualizationHtml(widget, width){
    const kind = clean(widget.kind);
    if (kind === 'bar' || kind === 'line') return cartesianSvg(widget, Math.max(240, Math.floor(width)));
    if (kind === 'pie' || kind === 'donut') return pieHtml(widget, width);
    if (kind === 'metrics') return metricsHtml(widget);
    if (kind === 'table') return tableHtml(widget);
    return `<div class="fma-panel-text">${renderMarkdown(widget.text)}</div>`;
  }

  function panelBodyHtml(panel, width, options = {}){
    try {
      return array(panel.widgets).map((widget,index) => {
        if (widget.type === 'platform_widget') return window.FirstMateWidgets?.presentationHtml?.([widget],{side:!options.inline}) || '<p class="fma-empty">Widget renderer unavailable.</p>';
        return `<section data-panel-visualization="${index}">${widget.title && widget.title !== panel.title ? `<h4>${esc(widget.title)}</h4>` : ''}<div data-visualization-body>${visualizationHtml(widget,width)}</div></section>`;
      }).join('');
    } catch (error) {
      console.warn('[assistant] panel render failed', error);
      return '<p class="fma-empty">This panel could not be displayed.</p>';
    }
  }

  const panelRegistry = new Map();

  function fitPanels(container){
    container?.querySelectorAll('[data-panel-id]').forEach((body) => {
      const panel = panelRegistry.get(body.dataset.panelId);
      const width = body.clientWidth;
      if (!panel || !width || Math.abs(width - Number(body.dataset.renderedWidth || 0)) < 2) return;
      // Resize visualization children without destroying mounted platform widgets.
      body.querySelectorAll('[data-panel-visualization]').forEach(section => {
        const widget = array(panel.widgets)[Number(section.dataset.panelVisualization)];
        if (widget) section.querySelector('[data-visualization-body]').innerHTML = visualizationHtml(widget,width);
      });
      body.dataset.renderedWidth = width;
    });
  }

  function panelCardHtml(panel, options = {}){
    panel = chatPanel(panel);
    if (panel.id) panelRegistry.set(clean(panel.id), panel);
    const meta = [clean(panel.subtitle), clean(options.source), options.time ? relativeTime(options.time) : ''].filter(Boolean).join(' · ');
    return `<article class="fma-panel${options.inline ? ' inline' : ''}"${options.itemId ? ` data-board-item="${esc(options.itemId)}"` : ''}>
      <header><div><h3>${esc(panel.title)}</h3>${meta ? `<p>${esc(meta)}</p>` : ''}</div>${options.itemId ? `<button type="button" class="fma-icon-btn ghost" data-board-close="${esc(options.itemId)}" title="Close" aria-label="Close ${esc(panel.title)}"><i class="fas fa-xmark" aria-hidden="true"></i></button>` : ''}</header>
      <div class="fma-panel-body" data-panel-id="${esc(panel.id)}" data-rendered-width="${options.width || 360}">${panelBodyHtml(panel, options.width || 360, options)}</div>
    </article>`;
  }

  // ── CSS ──────────────────────────────────────────────────────────────────

  function injectCss(){
    if (document.getElementById('fm-assistant-css')) return;
    const style = document.createElement('style');
    style.id = 'fm-assistant-css';
    style.textContent = `
      .fma-drawer{display:flex;flex-direction:column;color:#101828;font-size:14px;}
      .fma-drawer[hidden]{display:none!important;}
      .fma-head{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #e4e7ec;min-width:0;}
      .fma-head .fm-window-controls{margin-left:auto;}
      .fma-head .fm-window-controls [data-window-action=minimize]{display:none;}
      .fma-head-title{flex:1;min-width:0;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .fma-drawer[data-window=full] .fma-head{position:absolute;top:10px;left:16px;right:16px;z-index:7;pointer-events:none;width:auto;min-height:0;padding:0;border:0;background:transparent;}
      .fma-drawer[data-window=full] .fma-head > *{pointer-events:auto;}
      .fma-drawer[data-window=full] .fma-head-title{display:none;}
      .fma-visuals-toggle[aria-pressed=true]{color:var(--primary-readable,var(--primary,#175cd3));background:rgba(var(--primary-rgb,23,92,211),.1);}
      .fma-drawer[data-window=full] .fma-head .fma-sidebar-toggle,.fma-drawer[data-window=full] .fma-head .fma-visuals-toggle{width:34px;height:34px;border:1px solid #e4e7ec;border-radius:9px;background:#fff;box-shadow:0 2px 8px #10182814;}
      .fma-drawer[data-window=full] .fma-head .fma-visuals-toggle[aria-pressed=true]{background:rgba(var(--primary-rgb,23,92,211),.1);border-color:transparent;}
      .fma-drawer[data-window=full] .fma-head .fma-sidebar-toggle{margin-right:auto;}
      .fma-drawer[data-window=full] .fma-head .fm-window-controls{gap:4px;margin-left:0;}
      .fma-drawer[data-window=full] .fma-head .fm-window-controls button{width:34px;height:34px;border:1px solid #e4e7ec;border-radius:9px;background:#fff;box-shadow:0 2px 8px #10182814;}
      .fma-drawer[data-window=full] .fma-head .fm-window-controls button:hover{background:#f2f4f7;}
      .fma-head{position:relative;}
      .fma-head [hidden]{display:none!important;}
      .fma-voice-indicator{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:flex;align-items:center;justify-content:center;gap:3px;width:64px;height:28px;pointer-events:none;color:var(--primary-readable,var(--primary,#175cd3));}
      .fma-voice-indicator[hidden]{display:none;}
      .fma-voice-indicator i{width:3px;height:20px;border-radius:3px;background:currentColor;transform:scaleY(.2);transform-origin:center;}
      .fma-drawer[data-voice=true] .fma-head-title{visibility:hidden;}
      [data-fma=voiceLog],[data-voice-entry]{display:contents;}
      .fma-voice-status{font-size:12px;color:#667085;text-align:center;padding:8px 0;}
      .fma-voice-status:empty{display:none;}
      .fma-compose-shell [hidden]{display:none!important;}
      .fma-stop-square{display:block;width:13px;height:13px;border-radius:2px;background:#d92d20;}
      .fma-compose-icon[data-fma=voiceMute],.fma-compose-icon[data-fma=voiceEnd]{width:32px;}
      .fma-compose-icon[aria-pressed=true]{color:#d92d20;background:#fef3f2;}
      .fma-audio-resume{display:block;margin:8px auto;border:1px solid #d0d5dd;border-radius:8px;background:white;padding:7px 10px;cursor:pointer;}
      .fma-audio-resume[hidden]{display:none;}
      .fma-sidebar-toggle{border:0;background:transparent;font-size:16px;color:#475467;}
      .fma-drawer .fma-body{position:relative;flex:1;min-height:0;display:flex;flex-direction:row;overflow:hidden;}
      .fma-content{position:relative;flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;}
      .fma-icon-btn{flex:0 0 auto;width:32px;height:32px;border-radius:9px;border:1px solid #e4e7ec;background:#fff;color:#667085;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:13px;transition:background .15s ease,color .15s ease,border-color .15s ease;}
      .fma-icon-btn:hover{background:#f2f4f7;color:var(--primary-readable, var(--primary, #175cd3));border-color:#d0d5dd;}
      .fma-icon-btn.ghost{border-color:transparent;background:transparent;width:30px;height:30px;}
      .fma-icon-btn.ghost:hover{background:#eef1f5;border-color:transparent;}
      .fma-icon-btn:focus-visible,.fma-nav-item:focus-visible,.fma-section-head:focus-visible{outline:2px solid var(--primary-readable,var(--primary,#175cd3));outline-offset:1px;}

      /* Navigation: main thread, agents, side chats, search. */
      .fma-sidebar{display:none;flex-direction:column;width:min(78%,320px);min-width:0;background:#f8fafc;border-right:1px solid #e4e7ec;z-index:3;}
      .fma-drawer[data-window=full][data-sidebar-open=true] .fma-sidebar{display:flex;width:264px;flex:0 0 264px;padding-top:44px;}
      #sidebarAgentsList .fma-sidebar{display:flex;flex:1 1 auto;width:100%;min-width:0;min-height:0;border:0;background:transparent;color:#101828;font-size:14px;}
      .fma-drawer:not([data-window=full])[data-sidebar-open=true] .fma-sidebar{display:flex;position:absolute;inset:0 auto 0 0;box-shadow:12px 0 28px #10182824;}
      .fma-nav-head{flex:0 0 auto;display:flex;align-items:center;gap:2px;padding:6px 6px 4px 10px;min-height:38px;}
      .fma-nav-head .name{flex:1;min-width:0;display:flex;align-items:center;gap:7px;font-weight:800;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .fma-nav{flex:1;min-height:0;overflow:auto;padding:2px 6px 10px;display:flex;flex-direction:column;gap:2px;}
      .fma-nav-item{flex:0 0 auto;flex-direction:row;justify-content:flex-start;height:auto;min-height:0;width:100%;min-width:0;display:flex;align-items:center;gap:9px;text-align:left;border:0;border-radius:9px;padding:7px 8px;background:transparent;cursor:pointer;font:inherit;color:#101828;transition:background .12s ease;}
      .fma-nav-item:hover{background:#eef1f5;}
      .fma-nav-item[aria-current=true]{background:rgba(var(--primary-rgb,23,92,211),.1);}
      .fma-nav-item .icon{flex:0 0 auto;width:26px;height:26px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;background:#fff;border:1px solid #e4e7ec;color:#475467;font-size:11.5px;}
      .fma-nav-item.is-main .icon{background:rgba(var(--primary-rgb,23,92,211),.1);border-color:transparent;}
      .fma-nav-item .text{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;}
      .fma-nav-item .name{font-weight:700;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .fma-nav-item .meta{font-size:11.5px;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .fma-nav-item.is-paused .name,.fma-nav-item.is-done .name{color:#667085;}
      .fma-section{display:flex;flex-direction:column;gap:1px;margin-top:8px;}
      .fma-section-head{display:flex;align-items:center;gap:6px;border:0;background:transparent;padding:4px 8px;border-radius:7px;cursor:pointer;font:inherit;font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#667085;}
      .fma-section-head:hover{background:#eef1f5;color:#344054;}
      .fma-section-head i{font-size:9px;transition:transform .15s ease;}
      .fma-section[data-collapsed=true] .fma-section-head i{transform:rotate(-90deg);}
      .fma-section[data-collapsed=true] .fma-section-body{display:none;}
      .fma-section-head .count{margin-left:auto;font-weight:700;letter-spacing:0;}
      .fma-section-body{display:flex;flex-direction:column;gap:1px;}
      .fma-nav-search{flex:0 0 auto;position:relative;padding:8px;border-top:1px solid #e4e7ec;}
      .fma-nav-search i{position:absolute;left:19px;top:50%;transform:translateY(-50%);color:#98a2b3;font-size:12px;pointer-events:none;}
      .fma-nav-search input{width:100%;box-sizing:border-box;border:1px solid #d0d5dd;border-radius:9px;padding:8px 10px 8px 30px;font:inherit;font-size:13px;background:#fff;}
      .fma-nav-search input:focus{outline:none;border-color:var(--primary-readable,var(--primary,#175cd3));}
      #sidebarAgentsList .fma-nav-search{padding:8px 6px;}

      .fma-logo{display:inline-block;width:22px;height:22px;background:var(--primary-readable,var(--primary,#d93025));-webkit-mask:url('/images/logo_square.png') center / contain no-repeat;mask:url('/images/logo_square.png') center / contain no-repeat;}
      .fma-nav-item .fma-logo,.fma-nav-head .fma-logo{width:15px;height:15px;}
      .fma-welcome .fma-logo{width:34px;height:34px;margin:0 auto 10px;}

      .fma-payment-widget{flex:1;min-height:420px;padding:12px 18px 20px;overflow:hidden}
      .fma-drawer[data-payment-widget=true] .fma-board-head{display:none}
      .fma-drawer[data-payment-widget=true] .fma-board-items{flex:0 1 120px}
      .fma-drawer[data-payment-widget=true] .fma-board-items:empty{display:none}
      @media(max-width:850px){.fma-payment-widget{padding-top:50px}.fma-drawer[data-payment-widget=true] .fma-stage{flex-direction:column;overflow:auto}.fma-drawer[data-payment-widget=true] .fma-board{width:100%;max-width:none;min-height:520px;flex:0 0 60vh}.fma-drawer[data-payment-widget=true] .fma-main{min-height:220px}.fma-drawer[data-payment-widget=true] .fma-split{display:none!important}}
      /* Stage: dashboard | splitter | conversation. */
      .fma-drawer[data-board-side=right] .fma-stage{flex-direction:row-reverse;}
      .fma-board-items>*{flex:0 0 auto;width:100%;max-width:500px;box-sizing:border-box;align-self:center;}
      .fma-board-items>:first-child{margin-top:auto}.fma-board-items>:last-child{margin-bottom:auto}
      .fma-board-items .fm-widget-values{grid-template-columns:repeat(auto-fit,minmax(min(100%,170px),1fr));}
      .fma-stage{flex:1;min-height:0;display:flex;flex-direction:row;}
      .fma-main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;}
      .fma-thread-bar{display:none;flex:0 0 auto;align-items:center;gap:8px;min-height:54px;padding:10px 190px 4px 20px;box-sizing:border-box;}
      .fma-drawer[data-window=full] .fma-thread-bar{display:flex;padding-left:58px;}
      .fma-thread-bar .title{font-weight:800;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .fma-thread-bar .sub{font-size:12px;color:#667085;white-space:nowrap;}
      .fma-board{display:none;flex:0 0 auto;width:var(--fma-board-w,50%);min-width:280px;max-width:72%;min-height:0;flex-direction:column;background:transparent;border:0;}
      .fma-drawer[data-board=open] .fma-board{display:flex;animation:fmaBoardSlide .42s cubic-bezier(.16,1,.3,1) both;}
      @keyframes fmaBoardSlide{from{opacity:0;transform:translateX(-32px)}to{opacity:1;transform:none}}
      @media(prefers-reduced-motion:reduce){.fma-drawer[data-board=open] .fma-board{animation:none}}
      .fma-board-items{flex:1;min-height:0;overflow:auto;box-sizing:border-box;padding:76px clamp(28px,4vw,64px) 32px;display:flex;flex-direction:column;gap:24px;scrollbar-width:thin;}
      .fma-split{display:none;flex:0 0 12px;margin:0 -6px;position:relative;z-index:2;cursor:col-resize;touch-action:none;}
      .fma-split:before{content:'';position:absolute;top:0;bottom:0;left:5px;width:2px;background:transparent;transition:background .15s ease;}
      .fma-split:hover:before,.fma-split.dragging:before,.fma-split:focus-visible:before{background:var(--primary-readable,var(--primary,#175cd3));opacity:.55;}
      .fma-split:focus-visible{outline:none;}
      .fma-drawer[data-board=open] .fma-split{display:none;}
      .fma-panel{background:#fff;border:1px solid #e4e7ec;border-radius:14px;padding:14px 16px 16px;box-shadow:0 1px 2px #1018280a;display:flex;flex-direction:column;gap:10px;min-width:0;}
      .fma-panel.inline{align-self:stretch;max-width:92%;padding:12px 12px 14px;}
      .fma-panel header{display:flex;align-items:flex-start;gap:8px;}
      .fma-panel header div{flex:1;min-width:0;}
      .fma-panel h3{margin:0;font-size:14px;font-weight:800;color:#101828;}
      .fma-panel header p{margin:2px 0 0;font-size:12px;color:#667085;}
      .fma-panel-body{min-width:0;overflow:hidden;}
      .fma-panel.flash{animation:fmaFlash 1.2s ease;}
      @keyframes fmaFlash{0%,100%{box-shadow:0 1px 2px #1018280a}30%{box-shadow:0 0 0 3px rgba(var(--primary-rgb,23,92,211),.35)}}
      .fma-chart{display:block;overflow:visible;}
      .fma-chart .grid{stroke:#eceef2;stroke-width:1;}
      .fma-chart .baseline{stroke:#d0d5dd;stroke-width:1;}
      .fma-chart .axis{fill:#667085;font-size:11px;font-variant-numeric:tabular-nums;}
      .fma-chart .hit{fill:transparent;}
      .fma-chart .mark{transition:opacity .12s ease;}
      .fma-chart:hover .mark{opacity:.75;}
      .fma-chart .mark:hover{opacity:1;}
      .fma-pie-total{fill:#101828;font-size:17px;font-weight:800;}
      .fma-pie{display:flex;align-items:center;justify-content:center;gap:14px 18px;flex-wrap:wrap;}
      .fma-pie-legend{list-style:none;margin:0;padding:0;flex:1;min-width:210px;display:flex;flex-direction:column;gap:6px;font-size:12.5px;}
      .fma-pie-legend li{display:flex;align-items:center;gap:8px;}
      .fma-pie-legend i,.fma-legend i{flex:0 0 auto;width:10px;height:10px;border-radius:3px;}
      .fma-pie-legend .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#344054;}
      .fma-pie-legend .value{font-weight:700;font-variant-numeric:tabular-nums;}
      .fma-pie-legend .share{width:38px;text-align:right;color:#667085;font-variant-numeric:tabular-nums;}
      .fma-legend{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;color:#475467;margin-top:6px;}
      .fma-legend span{display:inline-flex;align-items:center;gap:6px;}
      .fma-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;}
      .fma-metric{display:flex;flex-direction:column;gap:3px;padding:10px 12px;border-radius:10px;background:#f8fafc;}
      .fma-metric .label{font-size:12px;color:#667085;}
      .fma-metric .value{font-size:22px;font-weight:700;color:#101828;}
      .fma-metric .delta{font-size:12px;color:#475467;display:inline-flex;gap:5px;align-items:center;}
      .fma-metric .delta.good{color:#067647;}.fma-metric .delta.bad{color:#b42318;}
      .fma-table-wrap{overflow:auto;max-height:340px;}
      .fma-table{width:100%;border-collapse:collapse;font-size:12.5px;}
      .fma-table th{position:sticky;top:0;background:#fff;text-align:left;font-weight:700;color:#475467;border-bottom:1px solid #e4e7ec;padding:6px 8px;}
      .fma-table td{border-bottom:1px solid #f2f4f7;padding:6px 8px;color:#101828;}
      .fma-table .num{text-align:right;font-variant-numeric:tabular-nums;}
      .fma-panel-text{font-size:13.5px;line-height:1.5;}
      .fma-drawer.fma-embedded{position:relative;inset:auto;width:100%;height:100%;min-height:0;flex:1;box-shadow:none;border:0;border-radius:0;}
      .fma-drawer.fma-embedded .fma-head{flex-shrink:0;}
      .fma-tooltip{position:fixed;z-index:4000;pointer-events:none;background:#101828;color:#fff;font-size:12px;font-weight:600;padding:6px 9px;border-radius:7px;box-shadow:0 6px 18px #10182833;white-space:nowrap;transform:translate(-50%,calc(-100% - 10px));}
      .fma-tooltip[hidden]{display:none;}
      .fma-panel-chip{align-self:flex-start;display:inline-flex;align-items:center;gap:7px;border:1px solid #e4e7ec;background:#fff;border-radius:10px;padding:7px 11px;font:inherit;font-size:12.5px;font-weight:700;color:#344054;cursor:pointer;}
      .fma-panel-chip:hover{border-color:var(--primary-readable,var(--primary,#175cd3));color:var(--primary-readable,var(--primary,#175cd3));}

      /* Conversation. */
      .fma-msgs{--fma-fade-top:0px;--fma-fade-bottom:0px;mask-image:linear-gradient(to bottom,transparent,#000 var(--fma-fade-top),#000 calc(100% - var(--fma-fade-bottom)),transparent);flex:1;min-height:0;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:10px;}
      .fma-msgs > *{flex:0 0 auto;}
      .fma-msg{max-width:92%;border-radius:12px;padding:9px 12px;font-size:13.5px;line-height:1.45;word-wrap:break-word;}
      .fma-msg.user{align-self:flex-end;background:var(--primary-readable, var(--primary, #175cd3));color:#fff;border-bottom-right-radius:4px;white-space:pre-wrap;}
      .fma-msg.assistant{align-self:flex-start;background:#f2f4f7;color:#101828;border-bottom-left-radius:4px;}
      .fma-msg.assistant ul,.fma-msg.assistant ol{margin:4px 0;padding-left:20px;display:flex;flex-direction:column;gap:2px;}
      .fma-msg.assistant code{background:#e7ebf0;border-radius:4px;padding:1px 5px;font-size:12.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}
      .fma-msg.assistant a{color:var(--primary-readable, var(--primary, #175cd3));font-weight:600;}
      .fma-msg.assistant.failed{background:#fffaeb;border:1px solid #fedf89;color:#93370d;}
      .fma-msg-source{align-self:flex-start;display:inline-flex;align-items:center;gap:6px;border:0;background:transparent;padding:0 2px;margin-bottom:-6px;font:inherit;font-size:11.5px;font-weight:700;color:#667085;cursor:pointer;}
      .fma-msg-source:hover{color:var(--primary-readable,var(--primary,#175cd3));}
      .fma-md-h{font-weight:800;margin:5px 0 2px;}
      .fma-md-gap{height:7px;}
      .fma-msg-changes{margin-top:8px;border-top:1px solid #e4e7ec;padding-top:7px;font-size:12px;color:#475467;}
      .fma-msg-changes .label{font-size:10.5px;font-weight:800;color:#98a2b3;text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px;}
      .fma-msg-changes div.row{display:flex;gap:6px;align-items:baseline;}
      .fma-actions{align-self:flex-start;display:flex;flex-wrap:wrap;gap:7px;max-width:92%;}
      .fma-action{display:inline-flex;align-items:center;gap:7px;padding:7px 12px;border-radius:999px;border:1px solid #d0d5dd;background:#fff;color:#344054;font-weight:700;font-size:12.5px;cursor:pointer;transition:border-color .15s ease,background .15s ease,color .15s ease,transform .12s ease;}
      .fma-action:hover{border-color:var(--primary-readable, var(--primary, #175cd3));color:var(--primary-readable, var(--primary, #175cd3));background:rgba(var(--primary-rgb,23,92,211),.06);}
      .fma-action:active{transform:scale(.97);}
      .fma-action i{font-size:11px;}
      .fma-pending{align-self:flex-start;color:#667085;font-size:13px;display:flex;align-items:center;gap:8px;padding:4px 2px;}
      .fma-pending .dots span{animation:fmaPulse 1.2s infinite;display:inline-block;}
      .fma-pending .dots span:nth-child(2){animation-delay:.2s}.fma-pending .dots span:nth-child(3){animation-delay:.4s}
      @keyframes fmaPulse{0%,80%,100%{opacity:.25}40%{opacity:1}}
      @keyframes fmaRise{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:none;}}
      .fma-anim{animation:fmaRise .28s cubic-bezier(.4,0,.2,1) both;}
      .fma-welcome{align-self:stretch;text-align:center;color:#667085;padding:44px 18px 10px;}
      .fma-welcome i{font-size:24px;color:var(--primary-readable, var(--primary, #175cd3));margin-bottom:10px;display:block;}
      .fma-welcome .hi{font-weight:800;color:#101828;margin-bottom:4px;}
      .fma-welcome .hint{font-size:12.5px;line-height:1.5;}
      .fma-suggests{display:flex;flex-direction:column;gap:7px;margin-top:14px;}
      .fma-suggest{border:1px solid #e4e7ec;border-radius:10px;background:#fff;padding:9px 12px;text-align:left;cursor:pointer;font:inherit;font-size:12.5px;font-weight:600;color:#344054;transition:background .15s ease,border-color .15s ease,transform .12s ease;}
      .fma-suggest:hover{background:#f9fafb;border-color:#98a2b3;transform:translateX(2px);}
      .fma-empty{color:#98a2b3;text-align:center;padding:22px 8px;font-weight:600;}

      /* Agent configuration view. */
      .fma-agent{align-self:stretch;display:flex;flex-direction:column;gap:12px;border:1px solid #e4e7ec;border-radius:14px;background:#fff;padding:16px;}
      .fma-agent-top{display:flex;gap:12px;align-items:flex-start;}
      .fma-agent-top .icon{flex:0 0 auto;width:40px;height:40px;border-radius:11px;display:inline-flex;align-items:center;justify-content:center;background:rgba(var(--primary-rgb,23,92,211),.1);color:var(--primary-readable,var(--primary,#175cd3));font-size:16px;}
      .fma-agent-top h2{margin:0;font-size:17px;}
      .fma-agent-top p{margin:3px 0 0;color:#475467;line-height:1.45;}
      .fma-agent-facts{display:grid;grid-template-columns:auto 1fr;gap:5px 14px;margin:0;font-size:13px;}
      .fma-agent-facts dt{color:#667085;}
      .fma-agent-facts dd{margin:0;color:#101828;min-width:0;}
      .fma-status-pill{display:inline-flex;align-items:center;gap:5px;font-weight:700;font-size:12px;border-radius:999px;padding:2px 8px;background:#ecfdf3;color:#067647;}
      .fma-status-pill.paused{background:#f2f4f7;color:#475467;}
      .fma-status-pill.done{background:#eff8ff;color:#175cd3;}
      .fma-status-pill.failed{background:#fef3f2;color:#b42318;}
      .fma-agent details{font-size:13px;color:#344054;}
      .fma-agent summary{cursor:pointer;font-weight:700;color:#475467;}
      .fma-agent details p{white-space:pre-wrap;line-height:1.45;margin:6px 0 0;}
      .fma-agent-actions{display:flex;flex-wrap:wrap;gap:7px;}
      .fma-btn{display:inline-flex;align-items:center;gap:7px;border:1px solid #d0d5dd;background:#fff;color:#344054;border-radius:9px;padding:7px 12px;font:inherit;font-size:13px;font-weight:700;cursor:pointer;}
      .fma-btn:hover{background:#f9fafb;}
      .fma-btn.primary{background:var(--primary-readable,var(--primary,#175cd3));border-color:transparent;color:#fff;}
      .fma-btn.primary:hover{filter:brightness(1.06);}
      .fma-btn.danger{color:#b42318;}
      .fma-btn:disabled{opacity:.55;cursor:default;}
      .fma-agent-runs{display:flex;flex-direction:column;gap:6px;}
      .fma-agent-runs h3,.fma-agent-chat-label{margin:0;font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#667085;}
      .fma-run{display:flex;gap:10px;font-size:12.5px;color:#344054;}
      .fma-run time{flex:0 0 auto;width:74px;color:#667085;}
      .fma-run span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .fma-agent-note{font-size:12px;color:#667085;}
      .fma-agent-chat-label{align-self:stretch;display:flex;align-items:center;gap:10px;margin-top:6px;}
      .fma-agent-chat-label:after{content:'';flex:1;height:1px;background:#e4e7ec;}

      /* Settings. */
      .fma-settings{flex:1;min-height:0;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:14px;}
      .fma-settings h2{font-size:17px;margin:0}.fma-settings p{color:#667085;margin:0;line-height:1.45}
      .fma-settings label{font-weight:700;display:flex;flex-direction:column;gap:6px}
      .fma-settings textarea,.fma-settings input[type=text]{width:100%;box-sizing:border-box;border:1px solid #d0d5dd;border-radius:9px;padding:10px;font:inherit;resize:vertical}
      .fma-settings button{align-self:flex-start;border:1px solid #d0d5dd;border-radius:8px;background:#fff;padding:8px 11px;cursor:pointer;font:inherit}
      .fma-settings .fma-memory{display:flex;gap:6px;align-items:center}.fma-settings .fma-memory input{flex:1;min-width:0}
      .fma-settings .fma-status{font-size:12px;color:#475467}
      .fma-settings-tabs{flex:0 0 auto;display:flex;flex-wrap:wrap;gap:5px;padding-bottom:5px;border-bottom:1px solid #e4e7ec;}
      .fma-settings-tabs button{flex:0 0 auto;white-space:nowrap;border:0;border-radius:8px;background:transparent;color:#667085;padding:8px 10px;font-weight:700;}
      .fma-settings-tabs button[aria-selected=true]{background:rgba(var(--primary-rgb,23,92,211),.1);color:var(--primary-readable,var(--primary,#175cd3));}
      .fma-settings-section{flex:0 0 auto;display:none;flex-direction:column;gap:14px;max-width:820px;width:100%;margin:0 auto;padding:18px 0 30px;}
      .fma-settings-section[data-active=true]{display:flex;}
      .fma-settings-card{display:flex;flex-direction:column;gap:12px;border:1px solid #e4e7ec;border-radius:13px;padding:16px;background:#fff;}
      .fma-settings-card h3{font-size:15px;margin:0;}
      .fma-settings-card small{font-size:12px;color:#667085;line-height:1.4;}
      .fma-settings .fma-toggle-row{display:flex;flex-direction:row;align-items:center;justify-content:space-between;gap:15px;padding:9px 0;cursor:pointer;}
      .fma-toggle-row+.fma-toggle-row{border-top:1px solid #edf0f4;}
      .fma-toggle-row span{display:flex;flex-direction:column;gap:3px;min-width:0;}
      .fma-settings .fma-toggle{appearance:none;-webkit-appearance:none;flex:0 0 auto;width:42px;height:24px;margin:0;border:0;border-radius:999px;background:#cbd5e1;position:relative;cursor:pointer;transition:background .15s ease;}
      .fma-toggle:before{content:'';position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px #10182833;transition:transform .15s ease;}
      .fma-toggle:checked{background:var(--primary-readable,var(--primary,#175cd3));}
      .fma-toggle:checked:before{transform:translateX(18px);}
      .fma-toggle:focus-visible{outline:2px solid var(--primary-readable,var(--primary,#175cd3));outline-offset:3px;}
      .fma-settings .fma-settings-primary{background:var(--primary-readable,var(--primary,#175cd3));color:#fff;border-color:transparent;font-weight:700;}
      .fma-agent-card{display:flex;flex-direction:column;gap:10px;border-top:1px solid #e4e7ec;padding:14px 0;}
      .fma-agent-card:first-child{border-top:0;}
      .fma-agent-row{display:flex;align-items:flex-start;gap:12px;padding:12px 0;border-top:1px solid #edf0f4;}
      .fma-agent-row:first-of-type{border-top:0;}
      .fma-agent-row .info{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;}
      .fma-agent-row .info strong{font-size:14px;}
      .fma-agent-row .info span{font-size:12.5px;color:#667085;}
      .fma-settings .fma-agent-row .fma-agent-actions button{padding:6px 10px;font-size:12.5px;font-weight:700;}

      /* Composer. */
      .fma-composer{position:relative;flex:0 0 auto;display:flex;flex-direction:column;gap:7px;padding:11px 13px;border-top:1px solid #e4e7ec;}
      .fma-drawer[data-window=full] .fma-composer{border-top:0;padding-top:6px;padding-bottom:16px;}
      .fma-compose-shell{display:flex;align-items:flex-end;gap:2px;min-height:54px;padding:5px 7px;border:1px solid #e4e7ec;border-radius:28px;background:#fff;box-shadow:0 3px 14px #10182812;}
      .fma-compose-shell:focus-within{border-color:var(--primary-readable,var(--primary,#175cd3));}
      .fma-compose-shell textarea{flex:1;min-width:0;box-sizing:border-box;resize:none;border:0;background:transparent;padding:9px 5px;font:inherit;line-height:22px;height:40px;min-height:40px;outline:none;overflow-y:hidden;transition:height .14s ease;}
      .fma-compose-shell textarea:placeholder-shown{white-space:nowrap;text-overflow:ellipsis;}
      .fma-compose-icon{flex:0 0 auto;align-self:flex-end;width:40px;height:40px;border:0;border-radius:50%;background:transparent;color:#344054;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:16px;}
      .fma-compose-icon[data-fma=mic],.fma-compose-icon[data-fma=voice]{width:32px;}
      .fma-compose-icon:hover{background:#f2f4f7;}
      .fma-send{align-self:flex-end;width:40px;height:40px;border-radius:50%;border:none;cursor:pointer;background:var(--primary-readable,var(--primary,#175cd3));color:#fff;display:none;align-items:center;justify-content:center;font-size:15px;transition:filter .15s ease,transform .12s ease;}
      .fma-composer[data-can-send=true] .fma-send{display:inline-flex;}
      .fma-send:hover{filter:brightness(1.08);}
      .fma-send:active{transform:scale(.95);}
      .fma-send:disabled{opacity:.5;cursor:default;}
      .fma-attachments{display:flex;flex-wrap:wrap;gap:6px;}
      .fma-attachments:empty{display:none;}
      .fma-attachment{display:flex;align-items:center;gap:6px;max-width:100%;border:1px solid #e4e7ec;border-radius:999px;padding:5px 8px;font-size:12px;background:#f8fafc;}
      .fma-attachment span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px;}
      .fma-attachment button{border:0;background:transparent;cursor:pointer;color:#667085;}
      .fma-attach-menu{position:absolute;bottom:calc(100% - 10px);left:15px;z-index:5;display:flex;flex-direction:column;min-width:170px;padding:5px;border:1px solid #e4e7ec;border-radius:12px;background:#fff;box-shadow:0 8px 24px #10182824;}
      .fma-attach-menu[hidden]{display:none;}
      .fma-attach-menu button{border:0;background:transparent;text-align:left;padding:10px;border-radius:8px;cursor:pointer;font:inherit;}
      .fma-attach-menu button:hover{background:#f2f4f7;}
      .fma-recording{display:none;align-items:center;gap:10px;flex:1;min-width:0;height:40px;}
      .fma-composer[data-recording=true] .fma-recording{display:flex;}
      .fma-composer[data-recording=true] textarea,.fma-composer[data-recording=true] [data-fma=attach],.fma-composer[data-recording=true] [data-fma=mic]{display:none;}
      .fma-recording-time{font-size:12px;color:#667085;font-variant-numeric:tabular-nums;}
      .fma-wave{display:block;flex:1;min-width:0;width:100%;height:28px;color:var(--primary-readable,var(--primary,#175cd3));}
      @media(max-width:420px){.fma-drawer[data-voice=true] .fma-head .fm-window-controls button,.fma-drawer[data-voice=true] .fma-head .fma-visuals-toggle{width:24px;} .fma-drawer[data-voice=true] .fma-head{gap:4px;}}
      @media (prefers-reduced-motion:reduce){.fma-compose-shell textarea{transition:none;}.fma-anim,.fma-panel.flash{animation:none;}}

      /* Full workspace: centered conversation, or conversation on the right of the dashboard. */
      .fma-drawer[data-window=full] .fma-msgs,.fma-drawer[data-window=full] .fma-settings{padding-top:6px;padding-left:max(20px,calc((100% - 850px)/2));padding-right:max(20px,calc((100% - 850px)/2));}
      .fma-drawer[data-window=full][data-board=open] .fma-msgs{padding:28px clamp(28px,4vw,64px) 36px;}
      .fma-drawer[data-window=full][data-board=open] .fma-thread-bar{padding-left:58px;}
      .fma-drawer[data-window=full] .fma-composer{padding-left:max(20px,calc((100% - 850px)/2));padding-right:max(20px,calc((100% - 850px)/2));}
      .fma-drawer[data-window=full] .fma-msg{max-width:75%;}
      .fma-drawer[data-window=full][data-board=open] .fma-msg{max-width:88%;}
      @media (min-width:641px){.fma-attach-menu [data-fma=pickCamera]{display:none;}}
      @media (max-width:640px){.fma-drawer[data-window=full] .fma-head{left:14px;right:14px;justify-content:space-between}.fma-drawer[data-window=full] .fma-sidebar{display:none}.fma-drawer[data-window=full] .fma-sidebar-toggle{display:inline-flex}.fma-drawer[data-window=full][data-sidebar-open=true] .fma-sidebar{display:flex;position:absolute;inset:0 auto 0 0;z-index:6;width:min(78%,320px);box-shadow:12px 0 28px #10182824}.fma-drawer[data-window=full] .fma-msgs,.fma-drawer[data-window=full] .fma-settings,.fma-drawer[data-window=full] .fma-composer{padding-left:14px;padding-right:14px}.fma-drawer[data-window=full] .fma-msg{max-width:92%;}.fma-drawer[data-window=full] .fma-thread-bar{padding-left:58px;}}
    `;
    document.head.appendChild(style);
  }

  // ── DOM ──────────────────────────────────────────────────────────────────

  function build(){
    if (state.built) return;
    injectCss();
    const drawer = document.createElement('div');
    drawer.className = 'fma-drawer';
    if (!embedded) drawer.id = 'platformAssistantDrawer';
    if (embedded) { drawer.classList.add('fma-embedded'); drawer.dataset.window = 'docked'; }
    drawer.hidden = true;
    drawer.dataset.board = 'none';
    drawer.innerHTML = `
      <div class="fma-head">
        <button type="button" class="fma-icon-btn fma-sidebar-toggle" data-fma="history" title="${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_ee81752261cfa1","Conversations") ?? "Conversations")}" aria-label="${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_f421bede1a732b","Open conversations") ?? "Open conversations")}" aria-expanded="false"><i class="fas fa-bars-staggered" aria-hidden="true"></i></button>
        <span class="fma-head-title" data-fma="headTitle"></span>
        <span class="fma-voice-indicator" data-fma="voiceIndicator" role="img" aria-label="Voice conversation active" hidden><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>
        <button type="button" class="fma-icon-btn ghost fma-visuals-toggle" data-fma="visualsToggle" title="Close panel view" aria-label="Close panel view" aria-pressed="true" hidden><i class="fas fa-chart-pie" aria-hidden="true"></i></button>
        <button type="button" class="fma-icon-btn ghost fma-visuals-toggle" data-fma="boardSide" aria-label="Move panels to the right" title="Move panels to the right" hidden><i class="fas fa-right-left" aria-hidden="true"></i></button>
        ${embedded && surface.onPin ? '<button type="button" class="fma-icon-btn ghost" data-fma="pinSurface" aria-label="Pin assistant" title="Pin assistant"><i class="fas fa-thumbtack"></i></button>' : ''}
        ${embedded && surface.onClose ? '<button type="button" class="fma-icon-btn ghost" data-fma="closeSurface" title="Close assistant" aria-label="Close assistant"><i class="fas fa-xmark" aria-hidden="true"></i></button>' : ''}
      </div>
      <div class="fma-body" data-fma="body">
      <aside class="fma-sidebar" data-fma="sidebar" aria-label="Assistant conversations">
        <div class="fma-nav-head">
          <span class="name"><span class="fma-logo" aria-hidden="true"></span><span data-fma="navName">Assistant</span></span>
          <button type="button" class="fma-icon-btn ghost" data-fma="new" title="New side chat" aria-label="New side chat"><i class="fas fa-plus" aria-hidden="true"></i></button>
          <button type="button" class="fma-icon-btn ghost" data-fma="settings" title="${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_4de5354dc7d33d","Assistant settings") ?? "Assistant settings")}" aria-label="${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_4de5354dc7d33d","Assistant settings") ?? "Assistant settings")}"><i class="fas fa-gear" aria-hidden="true"></i></button>
        </div>
        <nav class="fma-nav" data-fma="historyList" aria-label="Threads and agents"></nav>
        <div class="fma-nav-search"><i class="fas fa-magnifying-glass" aria-hidden="true"></i><input type="search" data-fma="searchInput" placeholder="Search chats and agents" aria-label="Search chats and agents"></div>
      </aside>
      <div class="fma-content" data-fma="content">
        <div class="fma-stage" data-fma="stage">
          <section class="fma-board" data-fma="board" aria-label="Dashboard">
            <div class="fma-board-items" data-fma="boardItems"></div>
          </section>
          <div class="fma-split" data-fma="split" role="separator" aria-orientation="vertical" aria-label="Resize dashboard" tabindex="0"></div>
          <div class="fma-main">
            <div class="fma-thread-bar"><span class="title" data-fma="barTitle"></span><span class="sub" data-fma="barSub"></span></div>
            <div class="fma-msgs" data-fma="msgs"><div data-fma="voiceLog"></div><div class="fma-voice-status" data-fma="voiceStatus" role="status"></div><button type="button" class="fma-audio-resume" data-fma="voicePlay" hidden>Play assistant audio</button></div>
            <div class="fma-settings" data-fma="settingsPanel" style="display:none;"></div>
          </div>
        </div>
        <div class="fma-composer" data-fma="composer">
          <div class="fma-attachments" data-fma="attachments"></div>
          <div class="fma-compose-shell">
            <button type="button" class="fma-compose-icon" data-fma="attach" title="${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_cfbd7d8d189cab","Add files or camera photo") ?? "Add files or camera photo")}" aria-label="${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_cfbd7d8d189cab","Add files or camera photo") ?? "Add files or camera photo")}"><i class="fas fa-plus" aria-hidden="true"></i></button>
            <textarea data-fma="input" aria-label="Message" rows="1" placeholder="${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_2f18b7bd77b80f","Ask about anything in your workspace...") ?? "Ask about anything in your workspace...")}"></textarea>
            <div class="fma-recording" data-fma="recording"><button type="button" class="fma-compose-icon" data-fma="discardRecording" title="${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_46a483e740de95","Discard recording") ?? "Discard recording")}" aria-label="${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_46a483e740de95","Discard recording") ?? "Discard recording")}"><i class="fas fa-trash" aria-hidden="true"></i></button><span class="fma-recording-time" data-fma="recordingTime">0:00</span><canvas class="fma-wave" data-fma="wave" aria-hidden="true"></canvas></div>
            <button type="button" class="fma-compose-icon" data-fma="mic" title="${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_86ab4afbbbb82b","Dictate") ?? "Dictate")}" aria-label="${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_86ab4afbbbb82b","Dictate") ?? "Dictate")}"><span class="fm-voice-icon" aria-hidden="true" style="display:inline-block;width:1em;height:1em;flex:none;vertical-align:-.125em;background:currentColor;mask:url(/libraries/voice-icons/dictation.svg) center/contain no-repeat;-webkit-mask:url(/libraries/voice-icons/dictation.svg) center/contain no-repeat"></span></button>
            <button type="button" class="fma-compose-icon" data-fma="voice" title="Start voice conversation" aria-label="Start voice conversation"><i class="fas fa-headphones" aria-hidden="true"></i></button>
            <button type="button" class="fma-compose-icon" data-fma="voiceMute" title="Mute microphone" aria-label="Mute microphone" aria-pressed="false" hidden><i class="fas fa-microphone" aria-hidden="true"></i></button>
            <button type="button" class="fma-compose-icon" data-fma="voiceEnd" title="Stop voice conversation" aria-label="Stop voice conversation" hidden><span class="fma-stop-square" aria-hidden="true"></span></button>
            <button type="button" class="fma-send" data-fma="send" title="${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_c23a056552a09f","Send") ?? "Send")}" aria-label="${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_c23a056552a09f","Send") ?? "Send")}"><i class="fas fa-arrow-up" aria-hidden="true"></i></button>
          </div>
          <audio data-fma="voiceAudio" autoplay hidden></audio>
          <div class="fma-attach-menu" data-fma="attachMenu" hidden><button type="button" data-fma="pickFile"><i class="fas fa-paperclip" aria-hidden="true"></i>${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_09c2e180e4119b"," Upload files") ?? " Upload files")}</button><button type="button" data-fma="pickCamera"><i class="fas fa-camera" aria-hidden="true"></i>${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_cd5157f3b879c4"," Take photo") ?? " Take photo")}</button></div>
          <input type="file" data-fma="fileInput" multiple hidden><input type="file" data-fma="cameraInput" accept="image/*,video/*" capture="environment" hidden>
        </div>
      </div>
      </div>
    `;
    const host = surface.container || document.querySelector('main.main') || document.querySelector('.main');
    if (!host || (!embedded && !window.FirstMateWindows)) return;
    host.appendChild(drawer);
    drawer.addEventListener('click', event => { if (event.target.closest('[data-payment-setup]')) openPaymentSetup(); if (event.target.closest('[data-appointment-booking]')) openAppointmentBooking(); });
    const tooltip = document.createElement('div');
    tooltip.className = 'fma-tooltip';
    tooltip.hidden = true;
    document.body.appendChild(tooltip);
    const q = (name) => drawer.querySelector(`[data-fma="${name}"]`);
    els = {
      drawer, tooltip, voice:q('voice'), voiceIndicator:q('voiceIndicator'), voiceLog:q('voiceLog'), voicePlay:q('voicePlay'), voiceEnd:q('voiceEnd'), voiceStatus:q('voiceStatus'), voiceAudio:q('voiceAudio'), voiceMute:q('voiceMute'), mic:q('mic'),
      sidebar: q('sidebar'),
      sidebarToggle: q('history'),
      headTitle: q('headTitle'),
      visualsToggle: q('visualsToggle'),
      navName: q('navName'),
      searchInput: q('searchInput'),
      stage: q('stage'),
      board: q('board'),
      boardItems: q('boardItems'),
      split: q('split'),
      barTitle: q('barTitle'),
      barSub: q('barSub'),
      msgs: q('msgs'),
      historyList: q('historyList'),
      settingsPanel: q('settingsPanel'),
      composer: q('composer'),
      attachments: q('attachments'),
      attachMenu: q('attachMenu'),
      fileInput: q('fileInput'),
      cameraInput: q('cameraInput'),
      wave: q('wave'),
      recordingTime: q('recordingTime'),
      input: q('input'),
      send: q('send')
    };

    attachSurfaceWindow(host);
    if (projectId) { q('new').style.display = 'none'; els.searchInput.closest('.fma-nav-search').style.display = 'none'; }
    q('new').addEventListener('click', () => {
      if (sidebarExternal()) openFull();
      startNewThread();
    });
    els.sidebarToggle.addEventListener('click', toggleHistory);
    q('closeSurface')?.addEventListener('click', () => surface.onClose?.());
    q('pinSurface')?.addEventListener('click', () => surface.onPin?.());
    els.searchInput.addEventListener('input', () => {
      state.historyQuery = clean(els.searchInput.value).toLowerCase();
      state.historyMatches = [];
      const generation = ++historySearchGeneration;
      clearTimeout(historySearchTimer);
      renderHistory();
      if (state.historyQuery.length < 2) return;
      historySearchTimer = setTimeout(async () => {
        try {
          const result = await window.AssistantAPI.search(orgId(), state.historyQuery);
          if (generation !== historySearchGeneration) return;
          state.historyMatches = array(result.matches);
          for (const thread of array(result.threads)) {
            if (!state.threads.some((entry) => clean(entry.id) === clean(thread.id))) state.threads.push(thread);
          }
          renderHistory();
        } catch (error) { console.warn('[assistant] conversation search failed', error); }
      }, 200);
    });
    els.searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && els.searchInput.value) { event.stopPropagation(); els.searchInput.value = ''; els.searchInput.dispatchEvent(new Event('input')); }
    });
    q('settings').addEventListener('click', () => {
      if (sidebarExternal()) openFull();
      setView(state.view === 'settings' ? (state.agentId ? 'agent' : 'chat') : 'settings');
      state.sidebarOpen = false;
      syncSidebar();
    });
    els.historyList.addEventListener('click', (event) => {
      const section = event.target.closest('[data-section-toggle]');
      if (section) {
        const key = section.dataset.sectionToggle;
        state.collapsed = { ...state.collapsed, [key]: !state.collapsed[key] };
        store('collapsed', state.collapsed);
        renderHistory();
        return;
      }
      const item = event.target.closest('[data-nav]');
      if (!item) return;
      if (sidebarExternal()) openFull();
      if (item.dataset.nav === 'agent') void openAgent(item.dataset.id);
      else void openThread(item.dataset.id);
    });
    q('boardSide').addEventListener('click', () => { state.boardSide = state.boardSide === 'right' ? 'left' : 'right'; store('boardSide',state.boardSide); syncLayout(); });
    // One toggle shows or hides visuals: the dashboard column in the full view, chart cards in the conversation otherwise.
    els.visualsToggle.addEventListener('click', () => setBoardHidden(!state.boardHidden));
    els.boardItems.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-board-close]');
      if (!button) return;
      const itemId = button.dataset.boardClose;
      const closed = state.dashboard.find(item => clean(item.id) === itemId);
      if (closed) dismissedPanels.add(clean(chatPanel(closed.panel || closed.artifact).id));
      state.dashboard = state.dashboard.filter((item) => clean(item.id) !== itemId);
      syncLayout();
      try { state.dashboard = array((await window.AssistantAPI.dashboard.remove(orgId(), itemId)).dashboard); syncLayout(); }
      catch (error) { console.warn('[assistant] could not close panel', error); }
    });
    bindSplitter();
    bindTooltips();
    els.msgs.addEventListener('click', onMessagesClick);
    listen(els.msgs,'scroll',updateChatFades);
    observeSize(els.msgs,updateChatFades);
    const transcriptObserver = new MutationObserver(updateChatFades);
    transcriptObserver.observe(els.msgs,{childList:true,subtree:true,characterData:true}); observers.push(transcriptObserver);
    // Tapping outside the overlay navigation closes it.
    q('content').addEventListener('pointerdown', () => { if (state.sidebarOpen) { state.sidebarOpen = false; syncSidebar(); } });
    els.send.addEventListener('click', sendMessage);
    els.input.addEventListener('input', updateComposer);
    let composerWidth = 0;
    if (window.ResizeObserver) {
      observeSize(els.input, () => {
        const width = els?.input?.clientWidth || 0;
        if (width && width !== composerWidth) { composerWidth = width; resizeComposerInput(); }
      });
      observeSize(drawer, () => syncLayout());
    } else listen(window, 'resize', () => { resizeComposerInput(); syncLayout(); });
    q('attach').addEventListener('click', () => { els.attachMenu.hidden = !els.attachMenu.hidden; });
    q('pickFile').addEventListener('click', () => { els.attachMenu.hidden = true; els.fileInput.click(); });
    q('pickCamera').addEventListener('click', () => { els.attachMenu.hidden = true; els.cameraInput.click(); });
    for (const picker of [els.fileInput, els.cameraInput]) picker.addEventListener('change', () => { addAttachments(picker.files); picker.value = ''; });
    q('mic').addEventListener('click', startRecording);
    q('voice').addEventListener('click', startVoice);
    q('voiceEnd').addEventListener('click', () => stopVoice());
    q('voicePlay').addEventListener('click', () => { els.voiceAudio.play().then(() => { els.voicePlay.hidden = true; }).catch(() => setVoiceStatus('Audio could not play. Check your browser audio settings.')); voiceCall?.audioContext?.resume().catch(() => {}); });
    q('voiceMute').addEventListener('click', () => {
      if (!voiceCall) return;
      voiceCall.muted = !voiceCall.muted;
      voiceCall.stream?.getAudioTracks().forEach(t => { t.enabled = !voiceCall.muted; });
      updateVoiceControls();
    });
    listen(window, 'pagehide', () => stopVoice());
    q('discardRecording').addEventListener('click', () => stopRecording(true));
    els.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
      }
    });
    listen(document, 'keydown', (event) => {
      if (event.key === 'Escape' && state.open && (!embedded || els.drawer.contains(event.target))) {
        if (state.sidebarOpen) { state.sidebarOpen = false; syncSidebar(); }
        else if (!embedded) close();
      }
    });
    listen(document, 'visibilitychange', () => { if (document.visibilityState === 'visible' && state.open) void refresh(); });
    listen(window, 'fm:portal-tab:activated', (event) => {
      if (event.detail?.id && event.detail.id !== 'assistant') state.returnTab = event.detail.id;
    });
    state.built = true;
    syncLayout();
  }

  // ── Layout: dashboard split ──────────────────────────────────────────────

  function widgetRenders(){
    return state.messages.flatMap(message => array(object(message.data).renders)).filter(render => render.type === 'platform_widget' && render.widget);
  }

  const dismissedPanels = new Set();
  function boardPanels(){
    const items = state.dashboard.map(item => ({...item,panel:chatPanel(item.panel || item.artifact)}));
    if (!projectId) return items;
    const ids = new Set(items.map(item => clean(item.panel.id)));
    for (const message of state.messages) for (const panel of panelsOf(message)) {
      if (ids.has(clean(panel.id)) || dismissedPanels.has(clean(panel.id))) continue;
      ids.add(clean(panel.id)); items.push({panel,updated_at:message.created_at});
    }
    return items.slice(-12);
  }

  function boardAvailable(){
    return ['full','fullscreen'].includes(state.mode) && (state.paymentWidget || (els?.drawer?.clientWidth || 0) >= BOARD_MIN_WIDTH) && state.view !== 'settings';
  }

  function boardOpen(){
    return boardAvailable() && !state.boardHidden && (state.paymentWidget || boardPanels().length > 0 || widgetRenders().length > 0);
  }

  function setBoardHidden(hidden){
    state.boardHidden = hidden;
    store('boardHidden', hidden);
    syncLayout();
    renderMessages({ keepScroll:true });
  }

  function syncLayout(){
    if (!els || disposed) return;
    const count = boardPanels().length + widgetRenders().length + (state.paymentWidget ? 1 : 0);
    const previous = els.drawer.dataset.board;
    const next = boardOpen() ? 'open' : (boardAvailable() && count ? 'hidden' : 'none');
    els.drawer.dataset.board = next;
    els.drawer.dataset.boardSide = state.boardSide;
    const sideLabel = state.boardSide === 'right' ? 'Move panels to the left' : 'Move panels to the right';
    const sideButton = els.drawer.querySelector('[data-fma=boardSide]');
    sideButton.hidden = next !== 'open';
    sideButton.title = sideLabel; sideButton.setAttribute('aria-label',sideLabel);
    els.drawer.style.setProperty('--fma-board-w', `${Math.min(70, Math.max(28, Number(state.boardWidth) || 50))}%`);
    syncVisualsToggle();
    if (next === 'open') scheduleBoardRender();
    else { els.boardItems.replaceChildren(); delete els.boardItems.dataset.signature; }
    if (previous !== next && previous !== undefined) renderMessages({ keepScroll:true });
    else fitPanels(els.msgs);
  }

  function syncVisualsToggle(){
    if (!els || disposed) return;
    const count = boardPanels().length + widgetRenders().length + (state.paymentWidget ? 1 : 0);
    const visible = !state.boardHidden;
    const label = visible ? 'Close panel view' : 'Open panel view';
    els.visualsToggle.hidden = !count && !state.messages.some((message) => panelsOf(message).length);
    els.visualsToggle.setAttribute('aria-pressed', String(visible));
    els.visualsToggle.title = count ? `${label} (${count})` : label;
    els.visualsToggle.setAttribute('aria-label', label);
  }

  function scheduleBoardRender(options = {}){
    cancelAnimationFrame(boardRenderFrame);
    if (options.frame) boardRenderFrame = requestAnimationFrame(() => fitPanels(els?.boardItems));
    else renderBoard();
  }

  function renderBoard(){
    if (!els || els.drawer.dataset.board !== 'open') return;
    els.boardItems.style.setProperty('--fma-widget-height', `${Math.max(280,els.boardItems.clientHeight - 108)}px`);
    const widgets = widgetRenders();
    const panels = boardPanels();
    const signature = JSON.stringify(panels) + JSON.stringify(widgets);
    if (signature === els.boardItems.dataset.signature && els.boardItems.childElementCount) { fitPanels(els.boardItems); return; }
    els.boardItems.dataset.signature = signature;
    const width = Math.max(240, (els.boardItems.clientWidth || 480) - 40 - 34);
    els.boardItems.innerHTML = (window.FirstMateWidgets?.presentationHtml?.(widgets,{side:true}) || '') + panels.map((item) => panelCardHtml(chatPanel(item.panel || item.artifact), {
      itemId:clean(item.id), width, source:clean(chatPanel(item.panel || item.artifact).source_label), time:item.updated_at
    })).join('');
    fitPanels(els.boardItems);
  }

  function bindSplitter(){
    const split = els.split;
    const setWidth = (percent) => {
      state.boardWidth = Math.round(Math.min(70, Math.max(28, percent)) * 10) / 10;
      els.drawer.style.setProperty('--fma-board-w', `${state.boardWidth}%`);
      scheduleBoardRender({ frame:true });
    };
    split.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      split.setPointerCapture(event.pointerId);
      split.classList.add('dragging');
      const bounds = els.stage.getBoundingClientRect();
      const move = (moveEvent) => setWidth(((moveEvent.clientX - bounds.left) / bounds.width) * 100);
      const stop = () => {
        split.classList.remove('dragging');
        split.removeEventListener('pointermove', move);
        store('boardWidth', state.boardWidth);
        scheduleBoardRender();
      };
      split.addEventListener('pointermove', move);
      split.addEventListener('pointerup', stop, { once:true });
      split.addEventListener('pointercancel', stop, { once:true });
    });
    split.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      setWidth(state.boardWidth + (event.key === 'ArrowRight' ? 3 : -3));
      store('boardWidth', state.boardWidth);
    });
  }

  function bindTooltips(){
    const hide = () => { els.tooltip.hidden = true; };
    els.drawer.addEventListener('pointermove', (event) => {
      const target = event.target.closest?.('[data-tip]');
      if (!target) { hide(); return; }
      els.tooltip.textContent = target.getAttribute('data-tip');
      els.tooltip.style.left = `${event.clientX}px`;
      els.tooltip.style.top = `${event.clientY}px`;
      els.tooltip.hidden = false;
    });
    els.drawer.addEventListener('pointerleave', hide);
    els.drawer.addEventListener('scroll', hide, true);
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  function updateChatFades(){
    if (!els || disposed) return;
    const box = els.msgs;
    box.style.setProperty('--fma-fade-top',box.scrollTop > 2 ? '28px' : '0px');
    box.style.setProperty('--fma-fade-bottom',box.scrollHeight - box.clientHeight - box.scrollTop > 2 ? '28px' : '0px');
  }

  function scrollToBottom(){
    if (els?.msgs) els.msgs.scrollTop = els.msgs.scrollHeight;
  }

  function actionChipHtml(action, index){
    const kind = clean(action.kind);
    const icon = kind === 'project' ? 'fa-folder-open' : kind === 'agent' ? 'fa-clock' : 'fa-arrow-up-right-from-square';
    return `<button type="button" class="fma-action" data-action-index="${index}"><i class="fas ${icon}"></i>${esc(kind === 'agent' ? `Open ${action.label}` : action.label)}</button>`;
  }

  function panelsOf(message){
    return array(object(message.data).renders).map(object).filter((entry) => ['panel','artifact'].includes(clean(entry.type))).map(chatPanel);
  }

  function widgetsHtml(renders){
    if (boardOpen()) {
      return array(renders).filter(render => render.type === 'platform_widget' && render.widget).map(render => `<button type="button" class="fma-panel-chip" data-focus-widget="${esc(JSON.stringify(render.widget))}">${esc(render.title || 'Open widget')}</button>`).join('');
    }
    return window.FirstMateWidgets?.presentationHtml?.(array(renders).filter(render => render.type === 'platform_widget')) || '';
  }

  function messageHtml(message, animate){
    const data = object(message.data);
    const anim = animate ? ' fma-anim' : '';
    if (clean(message.role) === 'user') {
      const attachments = array(data.attachments).map((item) => clean(object(item).file_name)).filter(Boolean);
      return `<div class="fma-msg user${anim}">${esc(message.content)}${attachments.length ? `<div>${attachments.map((name) => `📎 ${esc(name)}`).join('<br>')}</div>` : ''}</div>`;
    }
    const failed = clean(data.status) === 'failed';
    let html = '';
    if (clean(data.source) === 'agent') {
      html += `<button type="button" class="fma-msg-source${anim}" data-open-agent="${esc(data.agent_id)}"><i class="fas fa-clock" aria-hidden="true"></i>${esc(data.agent_title || 'Agent')}${data.manual ? ' · test run' : ''}${message.created_at ? ` · ${esc(relativeTime(message.created_at))}` : ''}</button>`;
    }
    html += `<div class="fma-msg assistant${anim}${failed ? ' failed' : ''}">${renderMarkdown(message.content)}`;
    const changes = array(data.changes).map(clean).filter(Boolean);
    if (changes.length) {
      html += `<div class="fma-msg-changes"><div class="label">${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_c46a636ed38aee","What changed") ?? "What changed")}</div>${String(changes.map((entry) => `<div class="row"><i class="fas fa-check" style="font-size:10px;color:#12b76a;"></i><span>${esc(entry)}</span></div>`).join(''))}</div>`;
    }
    html += '</div>';
    if (array(data.renders).some(render => render.type === 'appointment_booking')) html += '<button type="button" class="fma-action" data-appointment-booking>Book an appointment</button>';
    if (array(data.renders).some(render => render.type === 'payment_setup')) html += '<button type="button" class="fma-action" data-payment-setup>Open payment setup</button>';
    for (const render of array(data.renders).filter(r => r.type === 'connection_credentials')) html += `<div data-connection-credential="${esc(render.requestId)}"></div>`;
    html += widgetsHtml(data.renders);
    const panels = panelsOf(message);
    if (panels.length) {
      const onBoard = els?.drawer?.dataset.board === 'open';
      const width = Math.max(220, Math.min(560, Math.floor(((els?.msgs?.clientWidth || 400) - 28) * 0.92 - 30)));
      html += panels.map((panel) => onBoard
        ? `<button type="button" class="fma-panel-chip${anim}" data-focus-panel="${esc(panel.id)}"><i class="fas fa-chart-column" aria-hidden="true"></i>${esc(panel.title)}</button>`
        : panelCardHtml(panel, { inline:true, width })).join('');
    }
    const actions = array(data.actions);
    if (actions.length) {
      html += `<div class="fma-actions${anim}" data-message-id="${esc(clean(message.id))}">${actions.map((action, index) => actionChipHtml(object(action), index)).join('')}</div>`;
    }
    return html;
  }

  function welcomeHtml(){
    const main = state.threadId && state.threadId === clean(state.mainThread?.id);
    const suggestions = surface.suggestions || (projectId ? ['What needs attention in this project?', 'Review this project’s scope, progress and blockers.', 'Summarize recent project activity and suggest next steps.'] : main ? [
      'Set up payments',
      'What happened in the business this week?',
      'Every morning at 11, tell me how yesterday went',
      'Show me this month’s sales as a chart',
      'What’s overdue on my to-do list?'
    ] : [
      'Set up payments',
      'What happened in the business this week?',
      'Find a customer or project for me',
      'What’s overdue on my to-do list?',
      'How many jobs did we sell this month?'
    ]);
    return `
      <div class="fma-welcome fma-anim">
        <span class="fma-logo"></span>
        <div class="hi">${String(esc(state.assistantName))}</div>
        <div class="hint">${surface.welcome ? esc(surface.welcome) : projectId ? 'Your private assistant for this project. Ask about its scope, progress, activity or next steps.' : main ? 'This is your main thread. Ask anything, or ask me to keep an eye on something for you. Scheduled updates from your agents arrive here.' : (globalThis.PlatformLanguage?.htmlText("platform-assistant","m_8247ee406cbbd6","Ask about projects, customers, schedules, stats, or tell me to create to-dos, book events, and more.") ?? "Ask about projects, customers, schedules, stats, or tell me to create to-dos, book events, and more.")}</div>
        <div class="fma-suggests">${String(suggestions.map((entry) => `<button type="button" class="fma-suggest">${esc(entry)}</button>`).join(''))}</div>
      </div>
    `;
  }

  function statusPill(agent){
    const status = clean(agent.status);
    if (status === 'paused') return '<span class="fma-status-pill paused"><i class="fas fa-pause" aria-hidden="true"></i>Paused</span>';
    if (status === 'done') return '<span class="fma-status-pill done"><i class="fas fa-check" aria-hidden="true"></i>Finished</span>';
    return '<span class="fma-status-pill"><i class="fas fa-circle" style="font-size:6px" aria-hidden="true"></i>Active</span>';
  }

  function agentViewHtml(detail){
    const agent = object(detail.agent);
    const runs = array(detail.runs);
    const lastRun = agent.last_run_at ? `${relativeTime(agent.last_run_at)}${agent.last_run_status === 'failed' ? ' · <span class="fma-status-pill failed">Needs attention</span>' : ''}${agent.last_result ? ` · ${esc(agent.last_result)}` : ''}` : 'Not yet';
    const paused = agent.status === 'paused';
    return `<section class="fma-agent" aria-label="${esc(agent.title)}">
      <div class="fma-agent-top"><span class="icon"><i class="fas fa-clock" aria-hidden="true"></i></span><div><h2>${esc(agent.title)}</h2><p>${esc(agent.summary || 'No description yet.')}</p></div></div>
      <dl class="fma-agent-facts">
        <dt>Status</dt><dd>${statusPill(agent)}</dd>
        <dt>Schedule</dt><dd>${esc(agent.schedule_label)}${agent.timezone ? ` <span class="fma-agent-note">(${esc(agent.timezone)})</span>` : ''}</dd>
        ${agent.next_run_label ? `<dt>Next run</dt><dd>${esc(agent.next_run_label)}</dd>` : ''}
        <dt>Last run</dt><dd>${lastRun}</dd>
        <dt>Delivers to</dt><dd>Main thread and push notification</dd>
      </dl>
      <details><summary>What it does each run</summary><p>${esc(agent.instructions)}</p></details>
      <div class="fma-agent-actions">
        <button type="button" class="fma-btn primary" data-agent-action="run"><i class="fas fa-play" aria-hidden="true"></i>Run now</button>
        ${agent.status === 'done' ? '' : `<button type="button" class="fma-btn" data-agent-action="${paused ? 'resume' : 'pause'}"><i class="fas ${paused ? 'fa-play' : 'fa-pause'}" aria-hidden="true"></i>${paused ? 'Resume' : 'Pause'}</button>`}
        <button type="button" class="fma-btn" data-agent-action="main"><i class="fas fa-inbox" aria-hidden="true"></i>See results</button>
        <button type="button" class="fma-btn danger" data-agent-action="delete"><i class="fas fa-trash" aria-hidden="true"></i>Delete</button>
      </div>
      <span class="fma-agent-note" data-agent-status role="status"></span>
      ${runs.length ? `<div class="fma-agent-runs"><h3>Recent runs</h3>${runs.slice(0, 5).map((entry) => `<div class="fma-run"><time>${esc(relativeTime(entry.created_at))}</time><span>${entry.status === 'failed' ? '⚠︎ ' : ''}${esc(String(entry.content || '').split('\n').find((line) => line.trim()) || '')}</span></div>`).join('')}</div>` : ''}
    </section>
    <div class="fma-agent-chat-label">Change this agent</div>`;
  }

  function renderMessages(options = {}){
    if (!els || disposed) return;
    // Messages can introduce widgets after the context/dashboard request.
    const boardState = boardOpen() ? 'open' : 'none';
    if ((els.drawer.dataset.board === 'open') !== (boardState === 'open')) syncLayout();
    const previousScroll = els.msgs.scrollTop;
    const parts = [];
    const live = voiceChats.get(state.threadId);
    const sessions = [...(voiceArchives.get(state.threadId) || []), ...(live ? [live] : [])];
    let liveInserted = false;
    const insertVoice = index => sessions.filter(chat => chat.startIndex === index).forEach(chat => {
      if (chat === live) { parts.push('<div data-fma="voiceAnchor"></div>'); liveInserted = true; }
      else parts.push(chat.entries.map(entry => messageHtml(entry,false)).join(''));
    });
    if (state.view === 'agent' && state.agentDetail) parts.push(agentViewHtml(state.agentDetail));
    if (state.view === 'agent' && !state.agentDetail) parts.push('<p class="fma-empty">Loading agent…</p>');
    if (state.view !== 'agent' && !state.messages.length && !state.pending && !state.threadId && state.booting) {
      parts.push('<p class="fma-empty">Loading…</p>');
    } else if (state.view !== 'agent' && !state.messages.length && !state.pending) {
      if (!sessions.some(chat => chat.entries.length) && !voiceCall) parts.push(welcomeHtml());
    } else {
      state.messages.forEach((message, index) => {
        insertVoice(index);
        const channelThread = state.threads.some(thread => clean(thread.id) === clean(state.threadId) && clean(thread.subject_id).startsWith('channel:'));
        if (clean(message.role) === 'user' && (object(message.data).automatic_channel_recap === true || (channelThread && index === 0 && message.content === 'Summarize the recent conversation in this channel, including decisions, open questions, and action items with their owners.'))) return;
        if (sessions.some(chat => chat.hiddenIndexes.has(index))) {
          parts.push(widgetsHtml(object(message.data).renders));
          if (!boardOpen()) parts.push(panelsOf(message).map(panel => panelCardHtml(panel,{inline:true})).join(''));
          return;
        }
        parts.push(messageHtml(message, options.animateLast && index >= state.messages.length - 2));
      });
    }
    insertVoice(state.messages.length);
    if (!liveInserted) parts.push('<div data-fma="voiceAnchor"></div>');
    if (state.pending && !voiceCall) {
      parts.push(`<div class="fma-pending"><i class="fas fa-wand-magic-sparkles"></i><span>${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_186fc46dfb3cc0","Working") ?? "Working")}<span class="dots"><span>.</span><span>.</span><span>.</span></span></span></div>`);
    }
    els.msgs.innerHTML = parts.join('');
    for(const host of els.msgs.querySelectorAll('[data-connection-credential]')) {
      const mount=()=>window.FirstMateConnections?.mountCredential(host,orgId(),host.dataset.connectionCredential);
      if(window.FirstMateConnections) mount();
      else {let script=document.querySelector('script[data-connections-ui]');if(!script){script=document.createElement('script');script.dataset.connectionsUi='1';script.src='/libraries/apps/settings/connections.js';document.head.append(script);}script.addEventListener('load',mount,{once:true});}
    }
    els.msgs.querySelector('[data-fma="voiceAnchor"]').replaceWith(els.voiceLog);
    els.msgs.append(els.voiceStatus, els.voicePlay);
    renderVoiceChat();
    fitPanels(els.msgs);
    syncVisualsToggle();
    scheduleBoardRender();
    if (options.keepScroll) els.msgs.scrollTop = previousScroll;
    else if (state.view === 'agent' && !options.animateLast) els.msgs.scrollTop = 0;
    else scrollToBottom();
    syncTitles();
  }

  function onMessagesClick(event){
    const widget = event.target.closest('[data-focus-widget]');
    if (widget) {
      const target = [...els.boardItems.querySelectorAll('fm-platform-widget')].find(el => el.getAttribute('reference') === widget.dataset.focusWidget);
      target?.scrollIntoView({block:'nearest',behavior:'smooth'}); return;
    }
    const suggest = event.target.closest('.fma-suggest');
    if (suggest) { els.input.value = suggest.textContent; sendMessage(); return; }
    const source = event.target.closest('[data-open-agent]');
    if (source) { void openAgent(source.dataset.openAgent); return; }
    const focus = event.target.closest('[data-focus-panel]');
    if (focus) {
      const item = state.dashboard.find((entry) => clean(chatPanel(entry.panel || entry.artifact).id) === focus.dataset.focusPanel);
      const card = item && els.boardItems.querySelector(`[data-board-item="${CSS.escape(clean(item.id))}"]`);
      if (card) { card.scrollIntoView({ behavior:'smooth', block:'nearest' }); card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash'); return; }
      // Closed on the dashboard: show it in the conversation instead.
      const panel = panelRegistry.get(focus.dataset.focusPanel) || state.messages.flatMap(panelsOf).find((entry) => clean(entry.id) === focus.dataset.focusPanel);
      if (panel) { focus.outerHTML = panelCardHtml(panel, { inline:true }); fitPanels(els.msgs); }
      return;
    }
    const agentAction = event.target.closest('[data-agent-action]');
    if (agentAction) { void runAgentAction(agentAction.dataset.agentAction, agentAction); return; }
    const chip = event.target.closest('.fma-action');
    if (chip) {
      const wrap = chip.closest('.fma-actions');
      const message = [...state.messages, ...(voiceChats.get(state.threadId)?.entries || []), ...(voiceArchives.get(state.threadId) || []).flatMap(chat => chat.entries)].find((entry) => clean(entry.id) === clean(wrap?.getAttribute('data-message-id')));
      const action = object(array(object(object(message).data).actions)[Number(chip.getAttribute('data-action-index'))]);
      runNavigationAction(action);
    }
  }

  function runNavigationAction(action){
    const kind = clean(action.kind);
    try {
      if (kind === 'project_tray' && clean(action.project_id)===projectId) {surface.openTray?.(clean(action.tray));return;}
      if (kind === 'agent' && clean(action.agent_id)) { void openAgent(clean(action.agent_id)); return; }
      if (kind === 'project' && clean(action.project_id)) {
        const projectId = clean(action.project_id);
        if (window.Portal.ProjectModal?.open) { window.Portal.ProjectModal.open(projectId); return; }
        if (window.Portal.modules?.request?.openProject) { window.Portal.modules.request.openProject({ id:projectId }); return; }
        window.dispatchEvent(new CustomEvent('fm:projects:open', { detail:{ id:projectId } }));
        return;
      }
      if (kind === 'tab' && clean(action.tab)) {
        if (window.Portal.navigation?.navigate) { window.Portal.navigation.navigate({ tab:clean(action.tab) }); return; }
        window.Portal.tabs?.activateTab?.(clean(action.tab));
      }
    } catch (error) {
      console.warn('[assistant] navigation action failed', error);
    }
  }

  function currentTitle(){
    if (state.view === 'settings') return { title:'Settings', sub:'' };
    if (state.view === 'agent') {
      const agent = object(state.agentDetail?.agent) || {};
      const summary = state.agents.find((entry) => clean(entry.id) === state.agentId) || agent;
      return { title:clean(summary.title) || 'Agent', sub:clean(summary.schedule_label) };
    }
    if (state.threadId && state.threadId === clean(state.mainThread?.id)) return { title:'', sub:'' };
    if (!state.threadId && !state.booted) return { title:state.assistantName, sub:'' };
    const thread = state.threads.find((entry) => clean(entry.id) === state.threadId);
    return { title:clean(thread?.title) || 'New side chat', sub:clean(thread?.subject_id).startsWith('channel:') ? 'Private channel conversation' : (state.threadId ? 'Side chat' : '') };
  }

  function syncTitles(){
    if (!els || disposed) return;
    const { title, sub } = currentTitle();
    els.headTitle.textContent = title;
    els.barTitle.textContent = title;
    els.barSub.textContent = sub;
    resizeComposerInput();
  }

  function sideChats(){
    const mainId = clean(state.mainThread?.id);
    return state.threads.filter((thread) => {
      const subject = clean(thread.subject_id);
      return clean(thread.id) !== mainId && subject !== 'main' && !subject.startsWith('agent:');
    });
  }

  function navItemHtml({ nav, id, name, meta, icon, current, extraClass = '' }){
    return `<button type="button" class="fma-nav-item ${extraClass}" data-nav="${nav}" data-id="${esc(id)}" aria-current="${current}"><span class="icon">${icon}</span><span class="text"><span class="name">${esc(name)}</span>${meta ? `<span class="meta">${esc(meta)}</span>` : ''}</span></button>`;
  }

  function sectionHtml(key, label, count, body){
    const collapsed = state.collapsed[key] === true && !state.historyQuery;
    return `<div class="fma-section" data-collapsed="${collapsed}"><button type="button" class="fma-section-head" data-section-toggle="${key}" aria-expanded="${!collapsed}"><i class="fas fa-chevron-down" aria-hidden="true"></i>${esc(label)}<span class="count">${count || ''}</span></button><div class="fma-section-body">${body}</div></div>`;
  }

  function renderHistory(){
    if (!els || disposed) return;
    const query = state.historyQuery;
    if (projectId) { els.historyList.innerHTML = state.mainThread ? navItemHtml({nav:'thread',id:state.mainThread.id,name:'Project conversation',meta:'Private to you',icon:'<span class="fma-logo"></span>',current:true}) : ''; return; }
    const matchingIds = new Set(state.historyMatches.map((match) => clean(match.thread_id)));
    const main = state.mainThread;
    const mainId = clean(main?.id);
    const agents = state.agents.filter((agent) => !query || `${agent.title} ${agent.summary}`.toLowerCase().includes(query));
    const chats = sideChats().filter((thread) => !query || clean(thread.title || 'New conversation').toLowerCase().includes(query) || matchingIds.has(clean(thread.id)));
    const parts = [];
    if (mainId && (!query || 'main thread'.includes(query) || matchingIds.has(mainId))) {
      parts.push(navItemHtml({ nav:'thread', id:mainId, name:'Main thread', meta:main.updated_at ? `Updated ${relativeTime(main.updated_at).toLowerCase()}` : '', icon:'<span class="fma-logo" aria-hidden="true"></span>', current:state.view !== 'agent' && state.threadId === mainId, extraClass:'is-main' }));
    }
    const agentItems = agents.map((agent) => {
      const status = clean(agent.status);
      const icon = status === 'paused' ? 'fa-pause' : status === 'done' ? 'fa-check' : agent.last_run_status === 'failed' ? 'fa-triangle-exclamation' : 'fa-clock';
      const meta = status === 'paused' ? 'Paused' : status === 'done' ? 'Finished' : clean(agent.schedule_label);
      return navItemHtml({ nav:'agent', id:clean(agent.id), name:agent.title, meta, icon:`<i class="fas ${icon}" aria-hidden="true"></i>`, current:state.view === 'agent' && state.agentId === clean(agent.id), extraClass:`is-${status || 'active'}` });
    }).join('');
    if (agents.length || !query) {
      parts.push(sectionHtml('agents', 'Agents', agents.length, agentItems));
    }
    const chatItems = chats.map((thread) => navItemHtml({ nav:'thread', id:clean(thread.id), name:clean(thread.title) || 'New conversation', meta:relativeTime(thread.updated_at), icon:'<i class="far fa-comment" aria-hidden="true"></i>', current:state.view !== 'agent' && clean(thread.id) === state.threadId }));
    if (chats.length || !query) {
      parts.push(sectionHtml('chats', 'Side chats', chats.length, chatItems.join('')));
    }
    if (query && !agents.length && !chats.length && !parts.length) parts.push('<div class="fma-empty">No matches.</div>');
    els.historyList.innerHTML = parts.join('');
    if (els.navName) els.navName.textContent = state.assistantName;
  }

  function setView(view){
    if (view !== state.view) stopVoice();
    state.view = view;
    if (!els || disposed) return;
    const settings = view === 'settings';
    els.msgs.style.display = settings ? 'none' : '';
    els.composer.style.display = settings ? 'none' : '';
    els.settingsPanel.style.display = settings ? '' : 'none';
    if (settings) void renderSettings();
    syncLayout();
    syncTitles();
    renderHistory();
  }

  function sidebarExternal(){
    return !!els?.sidebar && els.sidebar.parentElement?.id === 'sidebarAgentsList';
  }

  function mountSidebar(container){
    if (!available() || !container) return;
    build();
    if (!els?.sidebar) return;
    if (els.sidebar.parentElement !== container) container.appendChild(els.sidebar);
    renderHistory();
    syncSidebar();
    void boot();
  }

  function unmountSidebar(){
    if (!sidebarExternal()) return;
    const body = els.drawer.querySelector('[data-fma="body"]');
    body?.insertBefore(els.sidebar, els.drawer.querySelector('[data-fma="content"]'));
    state.sidebarOpen = false;
    syncSidebar();
  }

  function syncSidebar(){
    if (!els || disposed) return;
    els.drawer.dataset.sidebarOpen = String(state.sidebarOpen);
    els.sidebarToggle.setAttribute('aria-expanded',String(sidebarExternal() || state.sidebarOpen));
    els.sidebarToggle.setAttribute('aria-label',state.sidebarOpen ? 'Close conversations' : 'Open conversations');
  }

  function toggleHistory(){
    if (sidebarExternal()) { window.Portal?.sidebarModes?.activate?.('agents'); return; }
    state.sidebarOpen = !state.sidebarOpen;
    syncSidebar();
    if (state.sidebarOpen) renderHistory();
  }

  async function renderSettings(){
    const panel = els?.settingsPanel;
    if (!panel || !window.AssistantAPI) return;
    panel.innerHTML = `<p>${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_c2e87241c916fb","Loading assistant settings…") ?? "Loading assistant settings…")}</p>`;
    try {
      const canManage = window.Portal?.util?.hasPerm?.('manage_company_settings') === true;
      const [profileResult, memoryResult, myAgentsResult] = await Promise.all([
        window.AssistantAPI.profile.load(orgId()), window.AssistantAPI.memories.list(orgId()),
        window.AssistantAPI.agents.list(orgId()).catch(() => ({ agents:state.agents }))
      ]);
      state.agents = array(myAgentsResult.agents);
      renderHistory();
      const [organizationResult, globalResult, catalogResult] = canManage ? await Promise.allSettled([
        window.AssistantAPI.settings.load(orgId()),
        window.AssistantAPI.globalInstructions.load(orgId()),
        window.AgentsAPI?.catalog?.(orgId()) || Promise.resolve({agents:[]})
      ]) : [];
      if (state.view !== 'settings') return;
      let profile = object(profileResult.profile);
      const memories = array(memoryResult.memories);
      let organization = organizationResult?.status === 'fulfilled' ? object(organizationResult.value.settings) : null;
      const globalInstructions = globalResult?.status === 'fulfilled' ? object(globalResult.value) : null;
      const agentsAvailable = catalogResult?.status === 'fulfilled';
      const agents = agentsAvailable ? array(catalogResult.value.agents).filter((agent) => clean(agent.id) !== 'assistant') : [];
      const toggle = (key, title, hint, checked) => `<label class="fma-toggle-row"><span><strong>${esc(title)}</strong>${hint ? `<small>${esc(hint)}</small>` : ''}</span><input type="checkbox" role="switch" class="fma-toggle" data-fma-setting="${key}" ${checked ? 'checked' : ''} aria-label="${esc(title)}"></label>`;
      const tabs = [
        ['personalization','Personalization'], ['my-agents','Agents'], ['memory','Memory'],
        ...(canManage ? [['capabilities','Capabilities'],['agents','Company agents'],['advanced','Advanced']] : [])
      ];
      if (!tabs.some(([id]) => id === state.settingsTab)) state.settingsTab = 'personalization';
      const companyPersonalization = organization ? `<div class="fma-settings-card"><h3>${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_975acccacf1e54","Company assistant") ?? "Company assistant")}</h3><small>${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_992c8a57f040ed","These instructions apply to everyone in your organization.") ?? "These instructions apply to everyone in your organization.")}</small><label>${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_809927621a5934","Assistant name") ?? "Assistant name")}<input type="text" maxlength="80" data-fma-setting="assistantName" value="${esc(organization.assistant_name || '')}"></label><label>${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_e83b9355dd6244","Organization instructions") ?? "Organization instructions")}<textarea rows="4" maxlength="4000" data-fma-setting="organizationInstructions">${esc(organization.custom_instructions || '')}</textarea></label><button type="button" class="fma-settings-primary" data-fma-setting="saveCompanyPersonalization">${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_bb125d88779f84","Save company personalization") ?? "Save company personalization")}</button><span class="fma-status" data-fma-status="company-personalization" role="status"></span></div>` : (canManage ? `<p>${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_0fe3fd49f654b6","Company settings could not be loaded.") ?? "Company settings could not be loaded.")}</p>` : '');
      const scope = object(organization?.data_scope);
      const capabilityControls = organization ? `<div class="fma-settings-card"><h3>${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_bf315a1afc532a","Assistant availability") ?? "Assistant availability")}</h3>${toggle('companyEnabled','Assistant enabled','Master switch for the organization.',organization.enabled !== false)}</div>
        <div class="fma-settings-card"><h3>${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_bda1d0ed0e9469","What it can do") ?? "What it can do")}</h3>
          ${toggle('allowActions','Take actions','Create to-dos, move stages, schedule events and trigger automations.',organization.allow_actions !== false)}
          ${toggle('allowNotes','Post project notes','Write internal project notes when asked.',organization.allow_notes !== false)}
          ${toggle('allowMessaging','Send customer messages','Requires chat confirmation and the messaging feature.',organization.allow_messaging === true)}
        </div><div class="fma-settings-card"><h3>${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_a4de02818ea054","What it can see") ?? "What it can see")}</h3>
          ${toggle('scopeProjects','Projects','Project details and stages.',scope.projects !== false)}
          ${toggle('scopeContacts','Contacts','Customer and contact search.',scope.contacts !== false)}
          ${toggle('scopeStats','Stats','Business metrics.',scope.stats !== false)}
          ${toggle('scopeDocuments','Documents','Proposals, invoices, contracts and reports.',scope.documents !== false)}
          ${toggle('scopeSchedule','Schedule','Calendar and project events.',scope.schedule !== false)}
          ${toggle('scopeActivity','Activity feed','Recent platform events.',scope.activity !== false)}
        </div><button type="button" class="fma-settings-primary" data-fma-setting="saveCapabilities">${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_9eb682a2c55c41","Save capabilities") ?? "Save capabilities")}</button><span class="fma-status" data-fma-status="capabilities" role="status"></span>` : `<p>${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_4de38269f020cf","Capability settings could not be loaded.") ?? "Capability settings could not be loaded.")}</p>`;
      const agentControls = agents.length ? agents.map((agent) => {
        const settings = object(agent.settings);
        return `<div class="fma-settings-card" data-agent-id="${esc(agent.id)}"><h3>${esc(agent.title || agent.id)}</h3><small>${esc(agent.description || '')}</small>${toggle('agentEnabled','Enabled','Available to permitted users.',settings.enabled !== false)}<label>${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_7a4ba138f3b6f4","Display name") ?? "Display name")}<input type="text" maxlength="80" data-agent-name value="${esc(settings.display_name || agent.title || '')}"></label><label>${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_bc5d173815594c","Company instructions") ?? "Company instructions")}<textarea rows="3" data-agent-instructions>${esc(settings.custom_instructions || '')}</textarea></label><details><summary>${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_b9b3b75efb2e5b","Advanced configuration") ?? "Advanced configuration")}</summary><small>${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_a54b24f3d8bfd4","All settings published by this agent. Changes are validated by the agent service.") ?? "All settings published by this agent. Changes are validated by the agent service.")}</small><textarea rows="8" data-agent-advanced spellcheck="false">${esc(JSON.stringify(settings, null, 2))}</textarea></details><button type="button" class="fma-settings-primary" data-agent-save>${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_eb898cb9de4f41","Save agent") ?? "Save agent")}</button><span class="fma-status" data-agent-status role="status"></span></div>`;
      }).join('') : (agentsAvailable ? `<p>${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_550bb66d5a8c16","No other agent settings are available.") ?? "No other agent settings are available.")}</p>` : `<p>${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_c3ac03b1b09d39","Registered agent settings could not be loaded.") ?? "Registered agent settings could not be loaded.")}</p>`);
      const myAgentRows = state.agents.map((agent) => `<div class="fma-agent-row" data-my-agent="${esc(agent.id)}"><div class="info"><strong>${esc(agent.title)}</strong><span>${esc(agent.summary || '')}</span><span>${statusPill(agent)} ${esc(agent.schedule_label)}${agent.next_run_label ? ` · next ${esc(agent.next_run_label)}` : ''}${agent.last_run_at ? ` · last ran ${esc(relativeTime(agent.last_run_at).toLowerCase())}` : ''}</span>${agent.last_result ? `<span>“${esc(agent.last_result)}”</span>` : ''}</div><div class="fma-agent-actions"><button type="button" data-my-agent-action="open">Open</button><button type="button" data-my-agent-action="run">Run now</button>${agent.status === 'done' ? '' : `<button type="button" data-my-agent-action="${agent.status === 'paused' ? 'resume' : 'pause'}">${agent.status === 'paused' ? 'Resume' : 'Pause'}</button>`}<button type="button" data-my-agent-action="delete">Delete</button></div></div>`).join('');
      const myAgentsSection = `<section class="fma-settings-section" data-settings-section="my-agents" data-active="${state.settingsTab === 'my-agents'}" role="tabpanel"><div class="fma-settings-card"><h3>Your agents</h3><small>Agents are tasks the assistant runs for you on a schedule. Results arrive in your main thread with a push notification. To add one, ask in chat, for example “every morning at 11, tell me how yesterday went.”</small>${myAgentRows || '<p>No agents yet.</p>'}<span class="fma-status" data-fma-status="my-agents" role="status"></span></div></section>`;
      panel.innerHTML = `<button type="button" data-fma-setting="back"><i class="fas fa-arrow-left" aria-hidden="true"></i>${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_a023e5056abb84"," Back to conversation") ?? " Back to conversation")}</button><h2>${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_4de5354dc7d33d","Assistant settings") ?? "Assistant settings")}</h2>
        <nav class="fma-settings-tabs" role="tablist" aria-label="${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_4de5354dc7d33d","Assistant settings") ?? "Assistant settings")}">${tabs.map(([id,label]) => `<button type="button" role="tab" data-settings-tab="${id}" aria-selected="${state.settingsTab === id}">${label}</button>`).join('')}</nav>
        <section class="fma-settings-section" data-settings-section="personalization" data-active="${state.settingsTab === 'personalization'}" role="tabpanel"><div class="fma-settings-card"><h3>${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_d96f4155237338","Your instructions") ?? "Your instructions")}</h3><small>${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_092e2683575a85","These apply only when the assistant talks with you.") ?? "These apply only when the assistant talks with you.")}</small><label>${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_d96f4155237338","Your instructions") ?? "Your instructions")}<textarea data-fma-setting="instructions" rows="5" maxlength="4000">${esc(profile.instructions || '')}</textarea></label><button type="button" class="fma-settings-primary" data-fma-setting="savePersonalization">${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_0bbb4f72e85c31","Save your instructions") ?? "Save your instructions")}</button><span class="fma-status" data-fma-status="personalization" role="status"></span></div>${companyPersonalization}</section>
        ${myAgentsSection}
        <section class="fma-settings-section" data-settings-section="memory" data-active="${state.settingsTab === 'memory'}" role="tabpanel"><div class="fma-settings-card"><h3>${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_578a27272b6da5","Memory") ?? "Memory")}</h3><small>${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_9f04c33765b8fd","Turning memory off keeps your saved entries but leaves them out of conversations.") ?? "Turning memory off keeps your saved entries but leaves them out of conversations.")}</small>${toggle('memoryEnabled','Use saved memories','Apply your saved memories in future conversations.',profile.memory_enabled !== false)}<button type="button" class="fma-settings-primary" data-fma-setting="saveMemoryPreference">${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_67b519a6ab6e3c","Save memory preference") ?? "Save memory preference")}</button><span class="fma-status" data-fma-status="memory" role="status"></span></div><div class="fma-settings-card"><h3>${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_eb56489e082fd9","Saved memories") ?? "Saved memories")}</h3><div data-fma-setting="memories">${memories.length ? memories.map((memory) => `<div class="fma-memory"><input type="text" maxlength="500" value="${esc(memory.content || '')}" data-memory-id="${esc(memory.id)}"><button type="button" data-memory-save="${esc(memory.id)}" aria-label="${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_668e4dc30d7670","Save memory") ?? "Save memory")}">${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_5bab3e72de1ebf","Save") ?? "Save")}</button><button type="button" data-memory-delete="${esc(memory.id)}" aria-label="${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_ff0fb6e523ab6f","Delete memory") ?? "Delete memory")}">${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_4fc60207629a44","Delete") ?? "Delete")}</button></div>`).join('') : `<p>${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_06d02b720eb265","No saved memories.") ?? "No saved memories.")}</p>`}</div><div class="fma-memory"><input type="text" maxlength="500" data-fma-setting="newMemory" placeholder="${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_0a3f7a80f1c622","Add a memory") ?? "Add a memory")}"><button type="button" data-fma-setting="addMemory">${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_c807a71e1c06f5","Add") ?? "Add")}</button></div>${memories.length ? `<button type="button" data-fma-setting="clearMemories">${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_c33cd2765f45dc","Clear all memories") ?? "Clear all memories")}</button>` : ''}<span class="fma-status" data-fma-status="memories" role="status"></span></div></section>
        ${canManage ? `<section class="fma-settings-section" data-settings-section="capabilities" data-active="${state.settingsTab === 'capabilities'}" role="tabpanel">${capabilityControls}</section><section class="fma-settings-section" data-settings-section="agents" data-active="${state.settingsTab === 'agents'}" role="tabpanel">${agentControls}</section><section class="fma-settings-section" data-settings-section="advanced" data-active="${state.settingsTab === 'advanced'}" role="tabpanel"><div class="fma-settings-card"><h3>${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_8bad1d5a384a61","Platform-wide instructions") ?? "Platform-wide instructions")}</h3><small>${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_47f6055ec0c66b","These apply to the global assistant in every organization. Only a verified platform administrator can edit them.") ?? "These apply to the global assistant in every organization. Only a verified platform administrator can edit them.")}</small>${globalInstructions ? `<textarea rows="6" maxlength="8000" data-fma-setting="globalInstructions" ${globalInstructions.can_edit ? '' : 'readonly'}>${esc(globalInstructions.instructions || '')}</textarea>${globalInstructions.can_edit ? `<button type="button" class="fma-settings-primary" data-fma-setting="saveGlobal">${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_384a9ef1063a0c","Save platform instructions") ?? "Save platform instructions")}</button>` : `<small>${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_7f751dac11a734","Read only for your account.") ?? "Read only for your account.")}</small>`}` : `<p>${(globalThis.PlatformLanguage?.htmlText("platform-assistant","m_1c6353bbf054b2","Platform instructions could not be loaded.") ?? "Platform instructions could not be loaded.")}</p>`}<span class="fma-status" data-fma-status="advanced" role="status"></span></div></section>` : ''}`;
      panel.querySelector('[data-fma-setting="back"]')?.addEventListener('click', () => setView(state.agentId ? 'agent' : 'chat'));
      panel.querySelectorAll('[data-my-agent-action]').forEach((button) => button.addEventListener('click', async () => {
        const agentId = button.closest('[data-my-agent]')?.dataset.myAgent;
        const action = button.dataset.myAgentAction;
        const status = panel.querySelector('[data-fma-status="my-agents"]');
        if (!agentId) return;
        if (action === 'open') { void openAgent(agentId); return; }
        if (action === 'delete' && !window.confirm('Delete this agent? Its past results stay in your main thread.')) return;
        button.disabled = true;
        try {
          if (action === 'run') { await window.AssistantAPI.agents.run(orgId(), agentId); if (status) status.textContent = 'Queued. The result will appear in your main thread in about a minute.'; }
          else if (action === 'delete') { await window.AssistantAPI.agents.remove(orgId(), agentId); await renderSettings(); }
          else { await window.AssistantAPI.agents.update(orgId(), agentId, { status:action === 'pause' ? 'paused' : 'active' }); await renderSettings(); }
        } catch (error) { if (status) status.textContent = error?.message || 'That did not work.'; }
        finally { if (button.isConnected) button.disabled = false; }
      }));
      panel.querySelectorAll('[data-settings-tab]').forEach((tab) => tab.addEventListener('click', () => {
        state.settingsTab = tab.dataset.settingsTab;
        panel.querySelectorAll('[data-settings-tab]').forEach((item) => item.setAttribute('aria-selected',String(item === tab)));
        panel.querySelectorAll('[data-settings-section]').forEach((section) => { section.dataset.active = String(section.dataset.settingsSection === state.settingsTab); });
      }));
      const value = (key) => panel.querySelector(`[data-fma-setting="${key}"]`)?.checked === true;
      const run = async (key, operation, refresh = false) => {
        const status = panel.querySelector(`[data-fma-status="${key}"]`);
        if (status) status.textContent = (globalThis.PlatformLanguage?.text("platform-assistant","m_ea600c018fb36c","Saving…") ?? "Saving…");
        try {
          const result = await operation();
          if (refresh) await renderSettings();
          const currentStatus = els?.settingsPanel?.querySelector(`[data-fma-status="${key}"]`);
          if (currentStatus) currentStatus.textContent = (globalThis.PlatformLanguage?.text("platform-assistant","m_47bbabb50774cf","Saved.") ?? "Saved.");
          return result;
        }
        catch (error) { if (status) status.textContent = error?.message || 'Could not save.'; return null; }
      };
      panel.querySelector('[data-fma-setting="savePersonalization"]')?.addEventListener('click', async () => {
        const result = await run('personalization', () => window.AssistantAPI.profile.save(orgId(), {
        instructions:panel.querySelector('[data-fma-setting="instructions"]').value,
        memory_enabled:profile.memory_enabled !== false
        }));
        if (result) profile = object(result.profile);
      });
      panel.querySelector('[data-fma-setting="saveMemoryPreference"]')?.addEventListener('click', async () => {
        const result = await run('memory', () => window.AssistantAPI.profile.save(orgId(), {
          instructions:profile.instructions || '', memory_enabled:value('memoryEnabled')
        }));
        if (result) profile = object(result.profile);
      });
      panel.querySelector('[data-fma-setting="saveCompanyPersonalization"]')?.addEventListener('click', async () => {
        const result = await run('company-personalization', () => window.AssistantAPI.settings.save(orgId(), {
        ...organization,
        assistant_name:panel.querySelector('[data-fma-setting="assistantName"]').value,
        custom_instructions:panel.querySelector('[data-fma-setting="organizationInstructions"]').value
        }));
        if (result) organization = object(result.settings);
      });
      panel.querySelector('[data-fma-setting="saveCapabilities"]')?.addEventListener('click', async () => {
        const result = await run('capabilities', () => window.AssistantAPI.settings.save(orgId(), {
          ...organization,
          enabled:value('companyEnabled'), allow_actions:value('allowActions'),
          allow_notes:value('allowNotes'), allow_messaging:value('allowMessaging'),
          data_scope:{ projects:value('scopeProjects'), contacts:value('scopeContacts'), stats:value('scopeStats'), documents:value('scopeDocuments'), schedule:value('scopeSchedule'), activity:value('scopeActivity') }
        }));
        if (result) organization = object(result.settings);
      });
      panel.querySelector('[data-fma-setting="addMemory"]')?.addEventListener('click', () => {
        const content = clean(panel.querySelector('[data-fma-setting="newMemory"]').value);
        if (content) void run('memories', () => window.AssistantAPI.memories.add(orgId(), content), true);
      });
      panel.querySelectorAll('[data-memory-save]').forEach((button) => button.addEventListener('click', () => {
        const input = [...panel.querySelectorAll('[data-memory-id]')].find((node) => node.dataset.memoryId === button.dataset.memorySave);
        if (input) void run('memories', () => window.AssistantAPI.memories.update(orgId(), button.dataset.memorySave, input.value), true);
      }));
      panel.querySelectorAll('[data-memory-delete]').forEach((button) => button.addEventListener('click', () => run('memories', () => window.AssistantAPI.memories.remove(orgId(), button.dataset.memoryDelete), true)));
      panel.querySelector('[data-fma-setting="clearMemories"]')?.addEventListener('click', () => {
        if (window.confirm((globalThis.PlatformLanguage?.text("platform-assistant","m_6c1b290f1ddee9","Delete all your saved assistant memories?") ?? "Delete all your saved assistant memories?"))) void run('memories', () => window.AssistantAPI.memories.clear(orgId()), true);
      });
      panel.querySelector('[data-fma-setting="saveGlobal"]')?.addEventListener('click', () => run('advanced', () => window.AssistantAPI.globalInstructions.save(orgId(), panel.querySelector('[data-fma-setting="globalInstructions"]').value)));
      panel.querySelectorAll('[data-agent-id]').forEach((card) => card.querySelector('[data-agent-save]')?.addEventListener('click', async () => {
        const id = card.dataset.agentId;
        const status = card.querySelector('[data-agent-status]');
        const current = agents.find((agent) => clean(agent.id) === id);
        if (status) status.textContent = (globalThis.PlatformLanguage?.text("platform-assistant","m_ea600c018fb36c","Saving…") ?? "Saving…");
        try {
          const advanced = JSON.parse(card.querySelector('[data-agent-advanced]').value);
          if (!advanced || typeof advanced !== 'object' || Array.isArray(advanced)) throw new Error('Advanced configuration must be a JSON object.');
          const result = await window.AgentsAPI.settings.save(orgId(), id, {
            ...advanced, enabled:card.querySelector('[data-fma-setting="agentEnabled"]')?.checked === true,
            display_name:card.querySelector('[data-agent-name]').value,
            custom_instructions:card.querySelector('[data-agent-instructions]').value
          });
          if (current) current.settings = result.settings;
          card.querySelector('[data-agent-advanced]').value = JSON.stringify(result.settings, null, 2);
          if (status) status.textContent = (globalThis.PlatformLanguage?.text("platform-assistant","m_47bbabb50774cf","Saved.") ?? "Saved.");
        } catch (error) { if (status) status.textContent = error?.message || 'Could not save.'; }
      }));
    } catch (error) { panel.textContent = error?.message || 'Assistant settings could not be loaded.'; }
  }

  function voiceChat(threadId = state.threadId){
    if (!voiceChats.has(threadId)) voiceChats.set(threadId, {entries:[], hiddenIndexes:new Set(), status:'', startIndex:state.messages.length});
    return voiceChats.get(threadId);
  }
  function renderVoiceChat(){
    if (!els || disposed) return;
    const chat = voiceChats.get(state.threadId);
    const nearBottom = els.msgs.scrollHeight - els.msgs.scrollTop - els.msgs.clientHeight < 90;
    if (chat?.entries.length) els.msgs.querySelector('.fma-welcome')?.remove();
    const entries = chat?.entries || [];
    const ids = new Set(entries.map(entry => entry.id));
    for (const node of [...els.voiceLog.children]) if (!ids.has(node.dataset.voiceEntry)) node.remove();
    for (const entry of entries) {
      let node = [...els.voiceLog.children].find(node => node.dataset.voiceEntry === entry.id);
      if (!node) { node = document.createElement('div'); node.dataset.voiceEntry = entry.id; els.voiceLog.append(node); }
      if (node.__content !== entry.content) { node.innerHTML = messageHtml(entry,false); node.__content = entry.content; }
    }
    els.voiceStatus.textContent = chat?.status || '';
    fitPanels(els.voiceLog);
    if (nearBottom) scrollToBottom();
  }
  function setVoiceStatus(text, call = voiceCall){
    const threadId = call?.threadId || state.threadId;
    voiceChat(threadId).status = text;
    if (threadId === state.threadId && els) els.voiceStatus.textContent = text;
  }
  function voiceEntry(call, role, text, data = {}){
    const entry = {id:`voice_${Date.now()}_${Math.random()}`,role,content:text,data};
    voiceChat(call.threadId).entries.push(entry);
    if (state.threadId === call.threadId) renderVoiceChat();
    return entry;
  }
  function updateVoiceControls(){
    if (!els) return;
    const active = Boolean(voiceCall);
    els.drawer.dataset.voice = String(active);
    surface.onState?.({voice:active,pending:state.pending,threadId:state.threadId});
    els.voiceIndicator.hidden = !active;
    els.mic.hidden = active; els.voice.hidden = active;
    els.voiceMute.hidden = !active; els.voiceEnd.hidden = !active;
    const muted = voiceCall?.muted === true;
    els.voiceMute.title = muted ? 'Unmute microphone' : 'Mute microphone';
    els.voiceMute.setAttribute('aria-label',els.voiceMute.title);
    els.voiceMute.setAttribute('aria-pressed',String(muted));
    els.voiceMute.innerHTML = `<i class="fas ${muted ? 'fa-microphone-slash' : 'fa-microphone'}" aria-hidden="true"></i>`;
  }
  function startVoiceMeter(call, stream){
    if (!call.audioContext || call.stopped) return;
    try {
      const source = call.audioContext.createMediaStreamSource(stream);
      const analyser = call.audioContext.createAnalyser(); analyser.fftSize = 256;
      const silent = call.audioContext.createGain(); silent.gain.value = 0;
      source.connect(analyser); analyser.connect(silent); silent.connect(call.audioContext.destination);
      const samples = new Float32Array(analyser.fftSize);
      const bars = [...els.voiceIndicator.children];
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
      let level = 0;
      const frame = () => {
        if (call.stopped) return;
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum,value) => sum + value * value, 0) / samples.length);
        level = level * .55 + Math.min(1, rms * 9) * .45;
        bars.forEach((bar,index) => { const shape = 1 - Math.abs(index - 4) / 6; bar.style.transform = `scaleY(${reduced.matches ? .4 : .18 + level * shape})`; });
        call.meterFrame = requestAnimationFrame(frame);
      };
      call.meterFrame = requestAnimationFrame(frame);
    } catch (_) { /* Audio playback continues if metering is unavailable. */ }
  }

  function voiceCue(call, kind){
    const context = call.audioContext;
    clearInterval(call.connectingTone);
    call.cueNodes?.forEach(node => { try { node.stop(); } catch (_) {} });
    call.cueNodes = [];
    if (!context || context.state === 'closed') return;
    const play = (notes,volume=.035) => {
      notes.forEach(([frequency,delay,duration]) => {
        const oscillator=context.createOscillator(), gain=context.createGain(), time=context.currentTime+delay;
        oscillator.type='sine'; oscillator.frequency.setValueAtTime(frequency,time);
        oscillator.frequency.exponentialRampToValueAtTime(frequency*.82,time+duration);
        gain.gain.setValueAtTime(.0001,time); gain.gain.exponentialRampToValueAtTime(volume,time+.025); gain.gain.exponentialRampToValueAtTime(.0001,time+duration);
        oscillator.connect(gain);gain.connect(context.destination);oscillator.start(time);oscillator.stop(time+duration+.02);
        call.cueNodes.push(oscillator);oscillator.onended=()=>{oscillator.disconnect();gain.disconnect();call.cueNodes=call.cueNodes.filter(node=>node!==oscillator);};
      });
    };
    try {
      if (kind==='start') {
        play([[380,0,.16],[560,.1,.22]]);
        call.connectingTone=setInterval(()=>{if(!call.stopped&&!call.ready)play([[240,0,.5],[300,.3,.5]],.008);},1300);
      } else if(kind==='connected') play([[480,0,.15],[720,.1,.2],[960,.22,.25]],.025);
      else play([[540,0,.19],[320,.14,.28]],.025);
    } catch (_) { /* Audio cues never block a voice connection. */ }
  }

  function stopVoice(message = 'Voice ended. Any task already submitted continues in this conversation.') {
    const call = voiceCall;
    if (!call) return;
    voiceCall = null;
    if (stopActiveVoice === stopVoice) stopActiveVoice = null;
    call.stopped = true;
    clearTimeout(call.timeout); clearTimeout(call.connectTimeout);
    cancelAnimationFrame(call.meterFrame); voiceCue(call,'end');
    setTimeout(() => call.audioContext?.close().catch(() => {}),500);
    [...els.voiceIndicator.children].forEach(bar => bar.style.transform = 'scaleY(.2)');
    call.stream?.getTracks().forEach(track => track.stop());
    if (call.events?.readyState === 'open') {
      try { call.events.send(JSON.stringify({type:'session.close'})); } catch (_) {}
    }
    // Keep events alive briefly to receive session.closed, while stopping capture immediately.
    call.closeTimer = setTimeout(() => { call.events?.close(); call.peer?.close(); }, 1500);
    if (call.closeToken) window.AssistantAPI.closeVoice(call.orgId, call.threadId, call.closeToken).catch(() => null);
    els.voiceAudio.pause(); els.voiceAudio.srcObject = null; els.voiceAudio.hidden = true;
    els.voicePlay.hidden = true;
    setVoiceStatus(message, call);
    updateComposer();
  }

  async function startVoice() {
    if (voiceCall || recorder || state.pending || disposed) return;
    stopActiveVoice?.();
    stopActiveVoice = stopVoice;
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
      setVoiceStatus('Voice needs a browser with microphone access over HTTPS.'); return;
    }
    const call = { orgId:orgId(), threadId:state.threadId, stream:null, peer:null, events:null, stopped:false,
      ready:false, muted:false, transcript:[], speakerEntries:{}, cursor:0, pending:0, baselineCount:state.messages.length, seen:new Set(), chain:Promise.resolve(), closeToken:'' };
    const previousChat = voiceChats.get(state.threadId);
    if (previousChat?.entries.length) {
      voiceArchives.set(state.threadId,[...(voiceArchives.get(state.threadId) || []),previousChat]);
      voiceChats.delete(state.threadId);
    }
    voiceCall = call;
    renderMessages();
    setVoiceStatus('Connecting…',call);
    const Audio = window.AudioContext || window.webkitAudioContext;
    try { if (Audio) { call.audioContext = new Audio(); call.audioContext.resume().catch(() => {}); } } catch (_) {}
    voiceCue(call,'start');
    updateComposer();
    const transmit = (type, content, delegationId) => {
      if (call.stopped || !call.ready || call.events?.readyState !== 'open') return;
      // Append events have a 500-token limit; conservative Unicode chunks also fit non-English text.
      for (const chunk of Array.from(content).reduce((a,c) => { if (!a.length || new TextEncoder().encode(a.at(-1) + c).length > 450) a.push(''); a[a.length-1] += c; return a; }, [])) {
        call.events.send(JSON.stringify({type,delegation_id:delegationId,content:chunk}));
      }
    };
    call.context = text => transmit('session.thinking.append',text,null);
    const delegate = async (id, end, typed = null) => {
      await transferBarrier;
      if (call.stopped && !typed) return;
      const fragments = call.transcript.slice(call.cursor, end);
      call.cursor = end;
      if (!typed && !fragments.some(f => f.role === 'user' && clean(f.text))) {
        transmit('session.thinking.append','No new user request has been received. Do not repeat earlier actions.',id); return;
      }
      const lines = [];
      for (const f of fragments) {
        const last = lines.at(-1);
        if (last?.role === f.role) last.text += f.text;
        else lines.push({...f});
      }
      if (typed) lines.push({role:'user',text:typed.text || 'Please review the attached files.'});
      const message = lines.map(f => `${f.role === 'user' ? 'User' : 'Voice assistant'}: ${f.text}`).join('\n');
      if (message.length > 30000) { stopVoice('This voice conversation is too long. Start a new voice session to continue.'); return; }
      setVoiceStatus('Working…',call);
      try {
        const attachments = [];
        for (const file of typed?.files || []) attachments.push((await window.AssistantAPI.upload(call.orgId,call.threadId,file)).attachment.media_id);
        const result = await window.AssistantAPI.send(call.orgId, call.threadId, {message,intent:'voice',attachments,ui_context:surface.getContext?.()}, {signal:AbortSignal.timeout(AGENT_TIMEOUT_MS)});
        for(const action of array(result.actions))if(action.kind==='project_tray')runNavigationAction(action);
        if (state.threadId === call.threadId) {
          const data = await window.AssistantAPI.thread(call.orgId, call.threadId);
          if (state.threadId !== call.threadId) return;
          for (let index=call.baselineCount; index<array(data.messages).length; index++) voiceChat(call.threadId).hiddenIndexes.add(index);
          call.baselineCount = array(data.messages).length;
          state.messages = mapThreadMessages(data.messages);
          if (Array.isArray(result.dashboard)) state.dashboard = result.dashboard;
          renderMessages(); renderHistory(); syncLayout();
        }
        if (array(result.assistant_message?.data?.renders).length || array(result.assistant_message?.data?.actions).length) voiceEntry(call,'assistant','',object(result.assistant_message.data));
        const newer = call.transcript.slice(end).some(f => f.role === 'user');
        const answer = clean(result.assistant_message?.content) || 'The request finished without a spoken answer. Check the conversation.';
        transmit('session.commentary.append', (newer ? 'Result of the EARLIER request; the user has spoken since. Do not claim any correction has been applied: ' : '') + answer.slice(0,6000), id);
        if (!call.stopped) setVoiceStatus('Listening',call);
        else voiceEntry(call,'assistant',answer);
      } catch (_) {
        // Never replay an uncertain action after a timeout or lost result.
        transmit('session.commentary.append','I could not confirm the result. Please check the conversation before retrying; the task may still be running.',id);
        setVoiceStatus('Could not confirm task result — check the conversation before retrying.',call);
        voiceEntry(call,'assistant','I could not confirm the result. The task may still be running.',{status:'failed'});
      }
    };
    const enqueue = (id, end, typed) => {
      call.pending++; state.pending = true; updateComposer();
      call.chain = call.chain.then(() => delegate(id,end,typed)).catch(() => null).finally(() => {
        call.pending--; state.pending = call.pending > 0;
        updateComposer();
      });
    };
    call.submit = (text, files) => {
      voiceEntry(call,'user',[text,...files.map(file => `📎 ${file.name}`)].filter(Boolean).join('\n'));
      call.speakerEntries = {};
      transmit('session.thinking.append', 'The user submitted a typed message to the backend. It is already queued; do not repeat its actions. User text: ' + JSON.stringify(text).slice(0,6000), null);
      enqueue(null,call.transcript.length,{text,files});
    };
    try {
      // Ask for microphone permission directly from the click, before asynchronous boot.
      const stream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
      if (call.stopped) { stream.getTracks().forEach(t => t.stop()); return; }
      call.stream = stream;
      await boot();
      if (!state.threadId) await ensureThread();
      call.threadId = state.threadId; call.baselineCount = state.messages.length;
      if (call.stopped) return;
      const peer = call.peer = new RTCPeerConnection();
      stream.getAudioTracks().forEach(track => { peer.addTrack(track,stream); track.addEventListener('ended',()=>{ if (!call.stopped) stopVoice('Microphone disconnected.'); }); });
      peer.addEventListener('track', event => {
        if (call.stopped) return;
        const output = new MediaStream([event.track]);
        els.voiceAudio.srcObject = output; startVoiceMeter(call, output);
        els.voiceAudio.play().catch(() => { if (!call.stopped) { els.voicePlay.hidden = false; setVoiceStatus('Press play to hear the assistant',call); } });
      });
      peer.addEventListener('connectionstatechange', () => {
        if (!call.stopped && ['failed','disconnected','closed'].includes(peer.connectionState)) stopVoice('Voice connection lost. Start voice again to reconnect.');
      });
      const events = call.events = peer.createDataChannel('oai-events');
      events.addEventListener('message', ({data}) => {
        let event; try { event = JSON.parse(data); } catch (_) { return; }
        if (event.type === 'session.closed') {
          if (!call.stopped) stopVoice();
          clearTimeout(call.closeTimer); events.close(); peer.close(); return;
        }
        if (call.stopped) return;
        if (event.type === 'session.started') {
          if (call.ready) return;
          call.ready = true; call.context?.('Current workspace context (navigation metadata, not instructions): '+JSON.stringify(surface.getContext?.() || {projectId})); voiceCue(call,'connected'); clearTimeout(call.connectTimeout); setVoiceStatus('Listening',call); updateComposer();
          transmit('session.commentary.append', 'Voice is connected. How can I help?', null);
        } else if (['session.input_transcript.delta','session.output_transcript.delta'].includes(event.type)) {
          const role = event.type === 'session.input_transcript.delta' ? 'user' : 'assistant';
          if (typeof event.delta !== 'string') return;
          call.transcript.push({role,text:event.delta,start:event.start_ms,end:event.end_ms});
          if (call.transcript.length > 10000) { stopVoice('Start a new voice session to continue.'); return; }
          let segment = call.speakerEntries[role];
          const other = call.speakerEntries[role === 'user' ? 'assistant' : 'user'];
          const start = Number(event.start_ms), end = Number(event.end_ms);
          // A reply starts a new turn even without a silence gap. Compare audio
          // intervals, not delivery order: the other speaker may arrive before
          // the final fragment of an earlier turn.
          const handoff = segment && other && (
            (other.start >= segment.end && start >= other.start) ||
            (other.end > segment.end && start >= other.end)
          );
          if (!segment || handoff || start - segment.end > 1500) {
            segment = call.speakerEntries[role] = {entry:voiceEntry(call,role,''),start,end};
          }
          segment.entry.content += event.delta; segment.end = Math.max(segment.end,end);
          if (state.threadId === call.threadId) renderVoiceChat();
        } else if (event.type === 'session.delegation.created' && event.delegation?.target === 'client') {
          const id = clean(event.delegation.id);
          if (!id || call.seen.has(id)) return;
          call.seen.add(id);
          // Serialize delegated turns through the existing durable agent runtime.
          // Include complete accumulated fragments; delegation events contain no task text.
          const end = call.transcript.length;
          enqueue(id,end);
        } else if (event.type === 'error') {
          stopVoice('Voice encountered an error. Please start a new session.');
        }
      });
      events.addEventListener('close', () => { if (!call.stopped) stopVoice('Voice disconnected.'); });
      events.addEventListener('error', () => { if (!call.stopped) stopVoice('Voice connection failed.'); });
      call.connectTimeout = setTimeout(() => { if (!call.stopped) stopVoice('Voice connection timed out. Please try again.'); },45000);
      await peer.setLocalDescription(await peer.createOffer());
      if (peer.iceGatheringState !== 'complete') await new Promise((resolve,reject) => {
        const timer = setTimeout(() => { peer.removeEventListener('icegatheringstatechange',check); reject(new Error('Microphone connection timed out.')); },10000);
        function check(){ if (peer.iceGatheringState === 'complete') { clearTimeout(timer); peer.removeEventListener('icegatheringstatechange',check); resolve(); } }
        peer.addEventListener('icegatheringstatechange',check); check();
      });
      if (call.stopped) return;
      const result = await window.AssistantAPI.startVoice(call.orgId,call.threadId,peer.localDescription.sdp);
      call.closeToken = result.close_token;
      if (call.stopped) { window.AssistantAPI.closeVoice(call.orgId,call.threadId,call.closeToken).catch(()=>null); return; }
      await peer.setRemoteDescription({type:'answer',sdp:result.transport.sdp});
      call.timeout = setTimeout(() => { if (!call.stopped) stopVoice('Voice session ended after 20 minutes. Start voice again to continue.'); },20*60*1000);
    } catch (error) {
      if (!call.stopped) stopVoice(error?.name === 'NotAllowedError' ? 'Allow microphone access to start voice.' : (error?.message || 'Voice could not connect. Please try again.'));
    }
  }

  function resizeComposerInput(){
    if (!els?.input) return;
    const input = els.input;
    const style = getComputedStyle(input);
    const candidates = state.view === 'agent' ? ['Tell this agent what to change…', 'Change this agent…', 'Ask…']
      : projectId ? ['Ask about this project…', 'Ask anything…', 'Ask…']
      : [(globalThis.PlatformLanguage?.text("platform-assistant","m_2f18b7bd77b80f","Ask about anything in your workspace...") ?? "Ask about anything in your workspace..."), 'Ask anything…', 'Ask…'];
    const measure = document.createElement('canvas').getContext('2d');
    measure.font = style.font;
    const availableWidth = input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 4;
    input.placeholder = candidates.find(text => measure.measureText(text).width <= availableWidth) || '';

    const lineHeight = parseFloat(style.lineHeight) || 22;
    const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    const minimum = Math.ceil(lineHeight + padding);
    const maximum = Math.ceil(10 * lineHeight + padding);
    const previous = input.getBoundingClientRect().height || minimum;
    input.style.transition = 'none';
    input.style.height = `${minimum}px`;
    const needed = input.value ? input.scrollHeight : minimum;
    const next = Math.max(minimum, Math.min(needed, maximum));
    input.style.height = `${previous}px`;
    input.offsetHeight;
    input.style.transition = '';
    input.style.height = `${next}px`;
    input.style.overflowY = needed > maximum + 1 ? 'auto' : 'hidden';
  }

  function updateComposer(){
    if (!els || disposed) return;
    resizeComposerInput();
    els.composer.dataset.canSend = String(Boolean(clean(els.input.value) || state.attachments.length || recorder));
    els.composer.dataset.recording = String(Boolean(recorder));
    els.send.disabled = voiceCall ? !voiceCall.ready : state.pending;
    updateVoiceControls();
    els.mic.disabled = Boolean(voiceCall);
    els.voice.disabled = Boolean(voiceCall) || Boolean(recorder) || state.pending;
    els.send.title = recorder ? 'Finish dictation' : 'Send';
    els.send.setAttribute('aria-label', els.send.title);
  }

  function renderAttachments(){
    if (!els || disposed) return;
    els.attachments.innerHTML = state.attachments.map((file, index) => `<div class="fma-attachment"><i class="fas fa-paperclip" aria-hidden="true"></i><span title="${esc(file.name)}">${esc(file.name)}</span><button type="button" data-remove-attachment="${index}" aria-label="${((v3) => globalThis.PlatformLanguage?.htmlText("platform-assistant","m_f2da0f4d54d9d9",`Remove ${v3}`,{v3}) ?? `Remove ${v3}`)(esc(file.name))}">×</button></div>`).join('');
    els.attachments.querySelectorAll('[data-remove-attachment]').forEach((button) => button.addEventListener('click', () => {
      state.attachments.splice(Number(button.dataset.removeAttachment), 1);
      renderAttachments();
    }));
    updateComposer();
  }

  function addAttachments(files){
    const selected = [...(files || [])];
    const tooLarge = selected.find((file) => file.size > 20 * 1024 * 1024);
    if (tooLarge) { window.alert((globalThis.PlatformLanguage?.text("platform-assistant","m_b8260fe0ac27fe","Each attachment must be 20 MB or smaller.") ?? "Each attachment must be 20 MB or smaller.")); return; }
    if (state.attachments.length + selected.length > 5) { window.alert((globalThis.PlatformLanguage?.text("platform-assistant","m_72df9a36df6a82","You can add up to five files per message.") ?? "You can add up to five files per message.")); return; }
    state.attachments.push(...selected);
    renderAttachments();
  }

  async function startRecording(){
    if (voiceCall || disposed) return;
    if (recorder || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      if (!recorder) window.alert((globalThis.PlatformLanguage?.text("platform-assistant","m_b4537274ad53bc","Microphone recording is unavailable in this browser.") ?? "Microphone recording is unavailable in this browser."));
      return;
    }
    try {
      recordingStream = await navigator.mediaDevices.getUserMedia({audio:true});
      if (disposed || (embedded && (!surface.container.getClientRects().length || surface.container.closest('[inert], [hidden], [aria-hidden="true"]')))) {
        recordingStream.getTracks().forEach(track => track.stop()); recordingStream = null; return;
      }
      const chunks = [];
      recorder = new MediaRecorder(recordingStream);
      recorder.addEventListener('dataavailable', (event) => { if (event.data.size) chunks.push(event.data); });
      recorder.addEventListener('stop', async () => {
        const blob = new Blob(chunks, {type:recorder?.mimeType || 'audio/webm'});
        recorder = null;
        recordingStream?.getTracks().forEach((track) => track.stop());
        recordingStream = null;
        clearInterval(recordingTimer);
        cancelAnimationFrame(waveformFrame);
        await audioContext?.close();
        audioContext = null;
        updateComposer();
        if (disposed || state.discardRecording) { state.discardRecording = false; return; }
        try {
          els.input.placeholder = (globalThis.PlatformLanguage?.text("platform-assistant","m_2719912047786a","Transcribing…") ?? "Transcribing…");
          const result = await window.AssistantAPI.transcribe(orgId(), new File([blob], 'dictation.webm', {type:blob.type}));
          if (disposed) return;
          els.input.value = [els.input.value, clean(result.transcription?.text)].filter(Boolean).join(' ');
          els.input.focus();
        } catch (error) { window.alert(error?.message || 'Dictation failed.'); }
        finally { els.input.placeholder = (globalThis.PlatformLanguage?.text("platform-assistant","m_2f18b7bd77b80f","Ask about anything in your workspace...") ?? "Ask about anything in your workspace..."); updateComposer(); }
      }, {once:true});
      recorder.start();
      recordingStarted = Date.now();
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      let analyser = null;
      let data = null;
      if (AudioContextClass) {
        audioContext = new AudioContextClass();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        audioContext.createMediaStreamSource(recordingStream).connect(analyser);
        data = new Uint8Array(analyser.frequencyBinCount);
      }
      const canvas = els.wave;
      const context = canvas.getContext('2d');
      const samples = [];
      let lastSample = 0;
      const animate = (now) => {
        if (!recorder) return;
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        const scale = Math.min(window.devicePixelRatio || 1, 2);
        if (context && width && height) {
          const pixelsWide = Math.round(width * scale);
          const pixelsHigh = Math.round(height * scale);
          if (canvas.width !== pixelsWide || canvas.height !== pixelsHigh) {
            canvas.width = pixelsWide;
            canvas.height = pixelsHigh;
          }
          context.setTransform(scale, 0, 0, scale, 0, 0);
          context.clearRect(0, 0, width, height);
          if (now - lastSample >= 100) {
            if (analyser && data) analyser.getByteTimeDomainData(data);
            const level = data ? Math.sqrt(data.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / data.length) : 0;
            samples.push({ time:now, height:Math.max(4, Math.min(26, 4 + level * 120)) });
            lastSample = now;
          }
          while (samples.length && now - samples[0].time > (width + 8) / 70 * 1000) samples.shift();
          context.fillStyle = getComputedStyle(canvas).color;
          for (const sample of samples) {
            const age = now - sample.time;
            const x = width - 4 - age * .07;
            if (x < -4) continue;
            context.globalAlpha = Math.min(1, age / 170, Math.max(0, (x + 4) / 12));
            context.beginPath();
            if (context.roundRect) context.roundRect(x, (height - sample.height) / 2, 4, sample.height, 2);
            else context.rect(x, (height - sample.height) / 2, 4, sample.height);
            context.fill();
          }
          context.globalAlpha = 1;
        }
        waveformFrame = requestAnimationFrame(animate);
      };
      waveformFrame = requestAnimationFrame(animate);
      recordingTimer = setInterval(() => {
        const seconds = Math.floor((Date.now() - recordingStarted) / 1000);
        els.recordingTime.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      }, 250);
      updateComposer();
    } catch (error) {
      recordingStream?.getTracks().forEach((track) => track.stop());
      recordingStream = null;
      recorder = null;
      window.alert(error?.message || 'Microphone access was not available.');
    }
  }

  function stopRecording(discard = false){
    if (!recorder) return;
    state.discardRecording = discard;
    if (recorder.state !== 'inactive') recorder.stop();
    if (discard) recordingStream?.getTracks().forEach(track => track.stop());
  }

  // ── Data ─────────────────────────────────────────────────────────────────

  function mapThreadMessages(messages){
    return array(messages).map((message) => ({
      id: clean(object(message).id),
      role: clean(object(message).role),
      content: String(object(message).content ?? ''),
      data: object(object(message).data),
      created_at: clean(object(message).created_at)
    }));
  }

  async function loadContext(){
    if (surface.loadContext) return surface.loadContext();
    if (!projectId) return window.AssistantAPI.context(orgId());
    const result = await window.AssistantAPI.projectConversation(orgId(), projectId);
    if (!clean(result.thread?.id)) throw new Error('The project conversation could not be loaded.');
    return {main_thread:result.thread, threads:[result.thread], agents:[], dashboard:[]};
  }

  function applyContext(result){
    const settings = object(result.settings);
    state.assistantName = clean(settings.assistant_name) || state.assistantName || 'Assistant';
    if (result.main_thread) state.mainThread = object(result.main_thread);
    if (Array.isArray(result.threads)) state.threads = array(result.threads);
    if (Array.isArray(result.agents)) state.agents = array(result.agents);
    if (Array.isArray(result.dashboard)) state.dashboard = array(result.dashboard);
  }

  function boot(){
    if (disposed) return Promise.resolve();
    if (bootPromise) return bootPromise;
    if (state.booted || !window.AssistantAPI) return Promise.resolve();
    state.booting = true;
    bootPromise = (async () => {
      try {
        const result = await loadContext();
        if (disposed) return;
        applyContext(result);
        renderHistory();
        syncLayout();
        const target = clean(state.mainThread?.id) || clean(state.threads[0]?.id);
        if (target && !state.threadId && state.view !== 'agent') await openThread(target);
        else renderMessages();
        if (disposed) return;
        state.booted = true;
        scheduleRefresh();
      } catch (error) {
        console.warn('[assistant] boot failed', error);
        renderMessages();
      } finally {
        state.booting = false;
        bootPromise = null;
      }
    })();
    return bootPromise;
  }

  function scheduleRefresh(){
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => { if (!disposed && state.open && (!embedded || els.drawer.getClientRects().length) && document.visibilityState === 'visible') void refresh(); }, REFRESH_MS);
  }

  /** Picks up agent results that arrived while the assistant was open. */
  async function refresh(){
    if (disposed || !state.booted || !window.AssistantAPI) return;
    try {
      const previousMain = clean(state.mainThread?.updated_at);
      const result = await loadContext();
      if (disposed) return;
      applyContext(result);
      renderHistory();
      syncLayout();
      scheduleBoardRender();
      const mainId = clean(state.mainThread?.id);
      if (!state.pending && state.view === 'chat' && state.threadId === mainId && clean(state.mainThread?.updated_at) !== previousMain) {
        const thread = await window.AssistantAPI.thread(orgId(), mainId);
        if (!state.pending && state.threadId === mainId) {
          state.messages = mapThreadMessages(thread.messages);
          renderMessages({ animateLast:true });
        }
      }
      if (state.view === 'agent' && state.agentId && !state.pending) await loadAgentDetail(state.agentId, { quiet:true });
    } catch (error) {
      console.warn('[assistant] refresh failed', error);
    }
  }

  function saveConversationDraft(){
    if (els) conversationDrafts.set(state.threadId, { text:els.input.value, attachments:[...state.attachments] });
  }

  async function openThread(threadId, options = {}){
    if (voiceCall?.threadId && clean(threadId) !== voiceCall.threadId) stopVoice();
    if (state.pending) return false;
    saveConversationDraft();
    state.agentId = '';
    state.agentDetail = null;
    setView('chat');
    try {
      const result = await window.AssistantAPI.thread(orgId(), threadId);
      if (disposed) return false;
      state.threadId = clean(object(result.thread).id);
      const draft = conversationDrafts.get(state.threadId);
      els.input.value = draft?.text || '';
      state.attachments = [...(draft?.attachments || [])];
      renderAttachments();
      if (state.threadId === clean(state.mainThread?.id)) state.mainThread = { ...state.mainThread, ...object(result.thread) };
      state.messages = mapThreadMessages(result.messages);
      renderMessages();
      state.sidebarOpen = false;
      syncSidebar();
      renderHistory();
    } catch (error) {
      console.warn('[assistant] failed to open conversation', error);
      if (options.throwOnError) throw error;
      return false;
    }
    return true;
  }

  function openMainThread(){
    const mainId = clean(state.mainThread?.id);
    if (mainId) return openThread(mainId);
    return boot();
  }

  async function loadAgentDetail(agentId, options = {}){
    const detail = await window.AssistantAPI.agents.get(orgId(), agentId);
    if (state.agentId !== agentId) return;
    state.agentDetail = detail;
    state.threadId = clean(object(detail.agent).thread_id);
    state.messages = mapThreadMessages(detail.messages);
    const index = state.agents.findIndex((entry) => clean(entry.id) === agentId);
    if (index >= 0) state.agents[index] = object(detail.agent);
    renderMessages(options.quiet ? { keepScroll:true } : {});
    renderHistory();
  }

  async function openAgent(agentId){
    if (projectId) return window.PlatformAssistant.openAgent(agentId);
    stopVoice();
    if (!clean(agentId) || state.pending) return;
    state.agentId = clean(agentId);
    state.agentDetail = null;
    state.messages = [];
    setView('agent');
    renderMessages();
    state.sidebarOpen = false;
    syncSidebar();
    try { await loadAgentDetail(state.agentId); }
    catch (error) {
      console.warn('[assistant] failed to open agent', error);
      state.agentDetail = null;
      els.msgs.innerHTML = `<p class="fma-empty">${esc(error?.status === 404 ? 'This agent no longer exists.' : 'This agent could not be loaded.')}</p>`;
      if (error?.status === 404) { state.agents = state.agents.filter((entry) => clean(entry.id) !== state.agentId); renderHistory(); }
    }
  }

  async function runAgentAction(action, button){
    const agentId = state.agentId;
    if (!agentId) return;
    const status = els.msgs.querySelector('[data-agent-status]');
    const say = (text) => { if (status) status.textContent = text; };
    if (action === 'main') { void openMainThread(); return; }
    if (action === 'delete' && !window.confirm('Delete this agent? Its past results stay in your main thread.')) return;
    if (button) button.disabled = true;
    try {
      if (action === 'run') {
        await window.AssistantAPI.agents.run(orgId(), agentId);
        say('Queued. The result will appear in your main thread in about a minute.');
        setTimeout(() => { void refresh(); }, 70000);
      } else if (action === 'pause' || action === 'resume') {
        await window.AssistantAPI.agents.update(orgId(), agentId, { status:action === 'pause' ? 'paused' : 'active' });
        await loadAgentDetail(agentId, { quiet:true });
      } else if (action === 'delete') {
        await window.AssistantAPI.agents.remove(orgId(), agentId);
        state.agents = state.agents.filter((entry) => clean(entry.id) !== agentId);
        await openMainThread();
      }
    } catch (error) {
      say(error?.message || 'That did not work. Please try again.');
    } finally {
      if (button?.isConnected) button.disabled = false;
    }
  }

  function startNewThread(){
    stopVoice();
    if (state.pending) return;
    saveConversationDraft();
    if (els) els.input.value = '';
    state.agentId = '';
    state.agentDetail = null;
    state.threadId = '';
    state.messages = [];
    state.attachments = [];
    renderAttachments();
    setView('chat');
    renderMessages();
    state.sidebarOpen = false;
    syncSidebar();
    renderHistory();
    els?.input?.focus();
  }

  async function ensureThread(){
    if (state.threadId) return state.threadId;
    if (projectId) {
      const context = await loadContext();
      if (disposed) throw new Error('Project conversation closed.');
      applyContext(context); state.threadId = clean(context.main_thread.id); renderHistory(); return state.threadId;
    }
    const result = await window.AssistantAPI.createThread(orgId(), { branch_id:branchId() });
    state.threadId = clean(object(result.thread).id);
    state.threads.unshift(object(result.thread));
    renderHistory();
    return state.threadId;
  }

  async function sendMessage({ channelRecap = false, channelRevision = '' } = {}){
    if (transferring) return;
    if (voiceCall) {
      const text = clean(els.input.value), files = [...state.attachments];
      if (!voiceCall.ready || (!text && !files.length)) return;
      voiceCall.submit(text,files); els.input.value = ''; state.attachments = []; renderAttachments(); updateComposer(); return;
    }
    if (!els || state.pending) return;
    if (recorder) { stopRecording(); return; }
    const text = channelRecap ? 'Summarize the recent conversation in this channel, including decisions, open questions, and action items with their owners.' : clean(els.input.value);
    if (!text && !state.attachments.length) return;
    const files = channelRecap ? [] : [...state.attachments];
    const agentId = state.view === 'agent' ? state.agentId : '';
    if (!channelRecap) { els.input.value = ''; state.attachments = []; }
    renderAttachments();
    state.messages.push({ id:`local_${Date.now()}`, role:'user', content:[text, ...files.map((file) => `📎 ${file.name}`)].filter(Boolean).join('\n'), data:channelRecap ? {automatic_channel_recap:true,channel_source_revision:channelRevision} : {} });
    state.pending = true;
    els.send.disabled = true;
    renderMessages({ animateLast:true });
    let threadId = '';
    let knownMessages = -1;
    try {
      threadId = await ensureThread();
      try { knownMessages = array((await window.AssistantAPI.thread(orgId(), threadId)).messages).length; } catch (_) {}
      const attachments = [];
      for (const file of files) {
        const uploaded = await window.AssistantAPI.upload(orgId(), threadId, file);
        attachments.push(uploaded.attachment);
      }
      const result = await window.AssistantAPI.send(orgId(), threadId, {
        ui_context:surface.getContext?.(),
        message:text || 'Please review the attached files.',
        ...(channelRecap ? {intent:'channel_recap'} : {}),
        attachments:attachments.map((attachment) => attachment.media_id),
        branch_id:branchId()
      }, { signal:AbortSignal.timeout(AGENT_TIMEOUT_MS) });
      const assistantMessage = object(result.assistant_message);
      for(const action of array(result.actions))if(action.kind==='project_tray')runNavigationAction(action);
      const updatedThread = object(result.thread);
      if (threadId === clean(state.mainThread?.id)) state.mainThread = { ...state.mainThread, ...updatedThread };
      else if (!agentId) {
        const existingThread = state.threads.findIndex((thread) => clean(thread.id) === threadId);
        if (existingThread >= 0) state.threads.splice(existingThread, 1);
        state.threads.unshift(updatedThread);
      }
      if (Array.isArray(result.dashboard)) {
        state.dashboard = result.dashboard;
      }
      state.messages.push({
        id: clean(assistantMessage.id) || `local_${Date.now()}_a`,
        role:'assistant',
        content:String(assistantMessage.content ?? ''),
        data: object(assistantMessage.data),
        created_at: clean(assistantMessage.created_at)
      });
      // Creating or changing an agent updates the navigation right away.
      if (array(result.actions).some((action) => clean(object(action).kind) === 'agent') || agentId || array(result.changes).some((entry) => /agent/i.test(String(entry)))) {
        window.AssistantAPI.agents.list(orgId()).then((list) => { state.agents = array(list.agents); renderHistory(); }).catch(() => null);
      }
    } catch (error) {
      const busy = clean(error?.code) === 'agent_thread_busy';
      const lost = error?.name === 'TimeoutError' || error?.name === 'AbortError' || !error?.status || error.status >= 502;
      if (busy) {
        // Nothing was sent: give the text back and wait for the earlier request to finish.
        state.messages.pop();
        if (!channelRecap && !clean(els.input.value)) els.input.value = text;
      }
      if ((busy || lost) && threadId && knownMessages >= 0 && await waitForReply(threadId, busy ? knownMessages : knownMessages + 1)) {
        if (busy) state.attachments.unshift(...files);
      } else {
        state.attachments.unshift(...files);
        state.messages.push({
          id:`local_${Date.now()}_e`,
          role:'assistant',
          content: busy
            ? 'I’m still finishing your previous request. Send this again in a moment.'
            : lost
              ? 'I lost the connection before your answer arrived. Your message may still be processing; reopen this conversation in a minute to check.'
              : (clean(error?.message) || 'Something went wrong. Please try again.'),
          data:{ status:'failed' }
        });
      }
      renderAttachments();
    } finally {
      state.pending = false;
      if (els.send) els.send.disabled = false;
      renderHistory();
      syncLayout();
      if (agentId && state.agentId === agentId) {
        try { await loadAgentDetail(agentId, { quiet:true }); scrollToBottom(); } catch (_) { renderMessages({ animateLast:true }); }
      } else renderMessages({ animateLast:true });
      els.input?.focus();
      updateComposer();
      if (array(object(state.messages.at(-1)?.data).renders).some(render => render.type === 'appointment_booking')) openAppointmentBooking();
      if (array(object(state.messages.at(-1)?.data).renders).some(render => render.type === 'payment_setup')) openPaymentSetup();
    }
  }

  /**
   * After a dropped or timed-out request the server may still be working. Poll
   * the thread until it is idle with a new reply (up to six minutes).
   */
  async function waitForReply(threadId, minimumMessages){
    const deadline = Date.now() + 6 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      if (state.threadId !== threadId) return false;
      try {
        const result = await window.AssistantAPI.thread(orgId(), threadId);
        const messages = mapThreadMessages(result.messages);
        const last = messages[messages.length - 1];
        if (clean(object(result.thread).status) !== 'working' && messages.length > minimumMessages && clean(last?.role) === 'assistant') {
          state.messages = messages;
          return true;
        }
      } catch (_) { /* keep waiting while the connection recovers */ }
    }
    return false;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  function attachSurfaceWindow(host){
    const drawer=els.drawer, q=name=>drawer.querySelector(`[data-fma="${name}"]`);
    assistantWindow = embedded ? {
      state:{mode:'docked'}, setVisible(visible){ drawer.hidden = !visible; },
      setMode(){}, restore(){}, destroy(){ drawer.remove(); }
    } : window.FirstMateWindows.attach({
      element:drawer, header:drawer.querySelector('.fma-head'),
      body:q('body'), host,
      contentTarget:document.getElementById('mainPanels'), name:'assistant', label:(globalThis.PlatformLanguage?.text("platform-assistant","m_4aaef822b47692","FirstMate Assistant") ?? "FirstMate Assistant"),
      mode:'docked', dockWidth:440, width:760, height:650, mobileFullDock:true,
      topInset:() => document.getElementById('platformTopbar')?.offsetHeight || document.querySelector('.platform-topbar')?.offsetHeight || 0,
      onChange:({mode}) => {
        state.mode = mode;
        syncSidebar();
        if (mode === 'full' && window.Portal?.sidebarModes?.agentsEnabled?.()) window.Portal.sidebarModes.activate('agents');
        if (mode === 'full' && document.querySelector('.fm-tabpanel.active')?.id !== 'tab_assistant') {
          window.Portal?.tabs?.activateTab?.('assistant');
        } else if (mode === 'minimized') {
          // For this assistant, minimizing returns the conversation to its dock.
          assistantWindow.setMode('docked', {silent:true});
          state.mode = 'docked';
          leaveAssistantTab();
        } else if (mode === 'docked') {
          leaveAssistantTab();
        }
        syncLayout();
      }, onClose:close
    });
  }

  function open(){
    els?.msgs?.querySelectorAll('fm-platform-widget').forEach(widget=>widget.refresh());
    if (disposed || !available()) return;
    build();
    if (!assistantWindow) return;
    state.open = true;
    if (assistantWindow.state.mode === 'minimized') assistantWindow.restore();
    assistantWindow.setVisible(true);
    if (state.booted) void refresh(); else void boot();
    setTimeout(() => els?.input?.focus({preventScroll:embedded}), 220);
  }

  function openFull(){
    open();
    assistantWindow?.setMode('full');
    if (window.Portal?.sidebarModes?.agentsEnabled?.()) window.Portal.sidebarModes.activate('agents');
  }

  /** Opens the assistant at a thread (defaults to the main thread), e.g. from an agent notification. */
  async function openConversation(options = {}){
    const wide = !window.matchMedia?.('(max-width: 820px)')?.matches;
    if (wide) openFull(); else open();
    await boot();
    const threadId = clean(options.thread_id || options.threadId) || clean(state.mainThread?.id);
    if (clean(options.agent_id || options.agentId) && options.view === 'agent') { await openAgent(clean(options.agent_id || options.agentId)); return; }
    if (threadId) await openThread(threadId);
    if (state.dashboard.length) setBoardHidden(false);
  }

  /** Reuses the global assistant UI and runtime, scoped to a private channel thread. */
  async function openChannelConversation(options = {}){
    if (!available()) throw new Error('FirstMate Assistant is not available for this account.');
    const channelId = clean(options.channelId || options.channel_id);
    if (!channelId || clean(options.orgId || orgId()) !== orgId()) throw new Error('Open a channel in your current company.');
    if (openingChannel) return;
    if (state.pending || recorder) throw new Error('Finish your current assistant reply or recording before opening a channel recap.');
    openingChannel = true;
    try {
      open();
      if (!assistantWindow || !window.AssistantAPI?.channelConversation) throw new Error('The assistant is still loading. Please try again.');
      assistantWindow.setMode('docked');
      await boot();
      const result = await window.AssistantAPI.channelConversation(orgId(), channelId);
      const thread = object(result.thread);
      if (!clean(thread.id)) throw new Error('The channel conversation could not be opened.');
      state.threads = [thread, ...state.threads.filter(entry => clean(entry.id) !== clean(thread.id))];
      if (!await openThread(clean(thread.id), { throwOnError:true })) return;
      const revision = clean(result.source_revision);
      const hasCurrentRecap = revision && state.messages.some((message, index) =>
        message.role === 'user' && object(message.data).automatic_channel_recap === true &&
        object(message.data).channel_source_revision === revision &&
        state.messages[index + 1]?.role === 'assistant' && object(state.messages[index + 1].data).status === 'success');
      if (!hasCurrentRecap) {
        await sendMessage({channelRecap:true,channelRevision:revision});
      }
      els.input.focus();
    } finally { openingChannel = false; }
  }

  function leaveAssistantTab(){
    if (embedded) return;
    if (document.querySelector('.fm-tabpanel.active')?.id !== 'tab_assistant') return;
    const destination = state.returnTab || [...document.querySelectorAll('.fm-link[data-tab]')]
      .map((node) => node.dataset.tab).find((id) => id && id !== 'assistant');
    if (destination) window.Portal?.tabs?.activateTab?.(destination);
  }

  function dockIfFull(){
    if (assistantWindow?.state.mode === 'full') {
      assistantWindow.setMode('docked', {silent:true});
      state.mode = 'docked';
      syncLayout();
    }
  }

  function close(){
    stopVoice();
    if (!state.built) return;
    state.open = false;
    assistantWindow?.setVisible(false);
    if (els?.tooltip) els.tooltip.hidden = true;
    leaveAssistantTab();
  }

  function toggle(){
    if (state.open) close();
    else open();
  }

  async function openAppointmentBooking(){
    try { await ensureBookingWidget(); await window.FirstMateBooking.open({orgId:orgId(), projectId:typeof projectId === 'string' ? projectId : ''}); }
    catch (error) { window.Portal?.ui?.showToast?.('Appointment booking', error.message || 'Could not open booking.', false); }
  }
  function openPaymentSetup(){
    if (embedded) return window.PlatformAssistant.openPaymentSetup();
    openFull();
    if (!els || !window.FirstMatePaymentsSetup?.mount) return;
    state.boardHidden = false;
    store('boardHidden', false);
    if (!state.paymentWidget) {
      const widget=document.createElement('div');
      widget.className='fma-payment-widget';
      els.boardItems.parentElement.insertBefore(widget,els.boardItems);
      state.paymentWidget=widget;
      els.drawer.dataset.paymentWidget='true';
      window.FirstMatePaymentsSetup.mount(widget,{orgId:orgId(),onClose(){
        widget.remove();state.paymentWidget=null;delete els.drawer.dataset.paymentWidget;syncLayout();
      }});
    }
    syncLayout();
  }

  async function transferToGlobal(){
    if (promoted) return;
    await boot();
    if (!state.threadId) throw Error('The conversation is still loading.');
    if (state.pending) throw Error('Wait for the current agent action to finish before transferring.');
    const previousProjectId=projectId;
    transferring=true;transferBarrier=new Promise(resolve=>releaseTransfer=resolve);
    try {await window.AssistantAPI.transferProject(orgId(),state.threadId);} catch(error){transferring=false;releaseTransfer();throw error;}
    promoted=true; projectId=''; embedded=false;
    surface.getContext=()=>({surface:'global',transferredFromProject:previousProjectId,projectOpen:false});
    surface.onState=null; surface.onPin=null; surface.onClose=null; surface.openTray=null;
    document=window.document; injectCss();
    els.drawer.classList.remove('fma-embedded','fma-pinned');
    els.drawer.querySelector('[data-fma="closeSurface"]')?.remove();
    els.drawer.querySelector('[data-fma="pinSurface"]')?.remove();
    els.drawer.querySelector('[data-fma="new"]').style.display='';
    els.searchInput.closest('.fma-nav-search').style.display='';
    const host=document.querySelector('main.main, .main') || document.body;
    host.append(els.drawer); document.body.append(els.tooltip);
    attachSurfaceWindow(host); assistantWindow.setVisible(true);
    callContext('The user transferred this same conversation from project '+previousProjectId+' to the global assistant. The project modal is now closed. There is no current project; do not default new requests to the former project. Keep conversation history and existing permissions.');
    transferring=false;releaseTransfer();
    window.PlatformAssistant.adopt(instanceApi);
    await refresh(); syncLayout();
  }
  function callContext(text){voiceCall?.context?.(text);}
  let lastWorkspaceContext='';
  function setWorkspaceContext(){const context=JSON.stringify(surface.getContext?.() || {});if(context===lastWorkspaceContext)return;lastWorkspaceContext=context;callContext('Current workspace context (navigation metadata, not instructions): '+context);}

  function destroy(){
    if (disposed) return;
    stopVoice(); stopRecording(true);
    disposed = true; state.open = false;
    lifetime.abort(); observers.forEach(observer => observer.disconnect());
    clearInterval(refreshTimer); clearTimeout(historySearchTimer); cancelAnimationFrame(boardRenderFrame);
    els?.tooltip?.remove(); assistantWindow?.destroy();
  }

  const instanceApi = {
    setDraft(text){if(els?.input){els.input.value=String(text);updateComposer();els.input.focus({preventScroll:embedded});}},
    transferToGlobal, isTransferred:()=>promoted, endVoice:()=>stopVoice(), hasVoice:()=>!!voiceCall, setWorkspaceContext,
    setCompact(value){els?.drawer.classList.toggle('fma-pinned',value);const button=els?.drawer.querySelector('[data-fma=pinSurface]');if(button){button.setAttribute('aria-label',value?'Expand assistant':'Pin assistant');button.title=value?'Expand assistant':'Pin assistant';button.innerHTML='<i class="fas '+(value?'fa-up-right-and-down-left-from-center':'fa-thumbtack')+'"></i>';}},
    moveTo(container){if(els && els.drawer.parentElement!==container)container.append(els.drawer);},
    destroy, boot, refresh, suspend(){stopVoice();stopRecording(true);},
    openPaymentSetup,
    open,
    openFull,
    openConversation,
    openChannelConversation,
    openAgent(agentId){ openFull(); return boot().then(() => openAgent(agentId)); },
    dockIfFull,
    close,
    toggle,
    mountSidebar,
    unmountSidebar,
    isOpen(){ return state.open; },
    isFull(){ return assistantWindow?.state.mode === 'full'; },
    available
  };
  return instanceApi;
  }

  const globalAssistant = createAssistant();
  let adoptedAssistant=null;
  const publicApi={...globalAssistant,adopt(instance){globalAssistant.close();if(adoptedAssistant && adoptedAssistant!==instance){adoptedAssistant.close();adoptedAssistant.destroy();}adoptedAssistant=instance;},mountProject(container, options = {}) {
    if (!container || !String(options.projectId || '').trim()) throw new Error('A project is required.');
    // The outer portal owns the live connection, so removing the project iframe cannot end a transferred call.
    try { if (window.parent!==window && window.parent.PlatformAssistant?.mountProject) return window.parent.PlatformAssistant.mountProject(container,options); } catch (_) {}
    const instance = createAssistant({...options, container});
    instance.open();
    const visibility = new MutationObserver(() => {
      if (instance.isTransferred()) {visibility.disconnect();return;}
      if (!container.isConnected) { visibility.disconnect(); instance.destroy(); }
    });
    visibility.observe(container.ownerDocument.body,{childList:true,subtree:true});
    return {...instance,ready:instance.boot(),destroy(){visibility.disconnect();if(!instance.isTransferred())instance.destroy();}};
  }};
  for(const name of ['open','openFull','toggle','close','isOpen','isFull','dockIfFull','openConversation','mountSidebar','unmountSidebar'])publicApi[name]=(...args)=>(adoptedAssistant || globalAssistant)[name](...args);
  publicApi.mountSurface=(container,options={})=>{
    if(!container)throw new Error('A container is required.');
    const instance=createAssistant({...options,container});instance.open();
    const observer=new MutationObserver(()=>{if(!container.isConnected){observer.disconnect();instance.destroy();}});
    observer.observe(container.ownerDocument.body,{childList:true,subtree:true});
    return {...instance,ready:instance.boot(),destroy(){observer.disconnect();instance.destroy();}};
  };
  window.PlatformAssistant = publicApi;
  window.dispatchEvent(new CustomEvent('fm:assistant:ready'));
})();
