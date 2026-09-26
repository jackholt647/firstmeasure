/* public/libraries/apps/stats/app.js
 * The Stats tab: configurable dashboard views rendered from cached warehouse
 * metrics, plus the conversational stats agent (ask questions, get inline
 * charts, edit dashboards by talking).
 */
(function(){
  'use strict';

  const runtime = window.FirstMateEmbeddableApps;
  if (!runtime || typeof runtime.registerApp !== 'function') return;

  const clean = (value) => String(value ?? '').trim();
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const array = (value) => Array.isArray(value) ? value : [];
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));

  const AGENT_TIMEOUT_MS = 150000;
  const SERIES_COLORS = ['#2e90fa', '#12b76a', '#7f56d9', '#f79009', '#f04438', '#0e7090', '#c11574', '#344054'];
  const VIEW_ICONS = ['fa-chart-line', 'fa-chart-column', 'fa-chart-pie', 'fa-sack-dollar', 'fa-trophy', 'fa-helmet-safety', 'fa-bullseye', 'fa-users', 'fa-phone', 'fa-calendar-days', 'fa-truck-fast', 'fa-star'];
  const VIEW_COLORS = ['#175cd3', '#067647', '#6941c6', '#b42318', '#b54708', '#0e7090', '#344054', '#c11574'];
  const TIME_RANGES = [
    ['this_week', 'This week'], ['this_month', 'This month'], ['last_month', 'Last month'],
    ['this_quarter', 'This quarter'], ['this_year', 'This year'], ['last_365_days', 'Last 12 months'], ['all_time', 'All time']
  ];

  // ── Formatting ───────────────────────────────────────────────────────────

  function formatMoney(cents){
    if (cents === null || cents === undefined || !Number.isFinite(Number(cents))) return '—';
    const dollars = Number(cents) / 100;
    const abs = Math.abs(dollars);
    const sign = dollars < 0 ? '-' : '';
    if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2)}M`;
    if (abs >= 10_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
    return `${sign}$${abs.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  }

  function formatValue(value, format){
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
    const num = Number(value);
    if (format === 'money') return formatMoney(num);
    if (format === 'percent') return `${num.toFixed(Math.abs(num) >= 100 ? 0 : 1)}%`;
    if (format === 'days') return `${num.toFixed(Math.abs(num) >= 100 ? 0 : 1)}d`;
    if (Math.abs(num) >= 10_000) return num.toLocaleString(undefined, { maximumFractionDigits: 0 });
    return Number.isInteger(num) ? String(num) : num.toFixed(1);
  }

  // Minimal markdown for assistant replies: escape everything first, then
  // apply bold/italic/code/link inline transforms and list/heading blocks.
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
        out.push(`<div class="st-md-h">${inline(heading[1])}</div>`);
      } else if (!trimmed) {
        closeList();
        out.push('<div class="st-md-gap"></div>');
      } else {
        closeList();
        out.push(`<div>${inline(line)}</div>`);
      }
    });
    closeList();
    return out.join('');
  }

  function formatBucket(bucket){
    const text = clean(bucket);
    const day = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (day) return `${Number(day[2])}/${Number(day[3])}`;
    const month = text.match(/^(\d{4})-(\d{2})$/);
    if (month) return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(month[2]) - 1]} ${month[1].slice(2)}`;
    return text;
  }

  // ── CSS ──────────────────────────────────────────────────────────────────

  function injectCss(){
    if (document.getElementById('fm-stats-css')) return;
    const style = document.createElement('style');
    style.id = 'fm-stats-css';
    style.textContent = `
      .st-shell{height:100%;min-height:0;display:flex;flex-direction:column;background:#f5f7fa;color:#101828;font-size:14px;}
      .st-top{flex:0 0 auto;display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:14px 18px 10px;background:#fff;border-bottom:1px solid #e4e7ec;}
      .st-views{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0;}
      .st-view-pill{display:inline-flex;align-items:center;gap:7px;padding:7px 13px;border-radius:999px;border:1px solid #e4e7ec;background:#fff;cursor:pointer;font-weight:600;color:#344054;max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background .15s ease,border-color .15s ease,box-shadow .15s ease,transform .12s ease;}
      .st-view-pill i{font-size:12px;}
      .st-view-pill:hover{border-color:#98a2b3;background:#f9fafb;}
      .st-view-pill:active{transform:scale(.97);}
      .st-view-pill.active{color:#fff;border-color:transparent;box-shadow:0 2px 8px rgba(16,24,40,.16);}
      .st-view-pill.active:hover{filter:brightness(1.06);}
      .st-view-add{padding:7px 11px;border-radius:999px;border:1px dashed #98a2b3;background:transparent;color:#475467;cursor:pointer;font-weight:600;transition:background .15s ease,border-color .15s ease,color .15s ease;}
      .st-view-add:hover{border-color:#475467;color:#101828;background:#f9fafb;}
      .st-spacer{flex:1;}
      .st-controls{display:flex;align-items:center;gap:8px;}
      .st-select{padding:7px 10px;border-radius:8px;border:1px solid #d0d5dd;background:#fff;color:#344054;font-weight:600;cursor:pointer;transition:border-color .15s ease,box-shadow .15s ease;}
      .st-select:hover{border-color:#98a2b3;}
      .st-btn{display:inline-flex;align-items:center;gap:7px;padding:8px 13px;border-radius:8px;border:1px solid #d0d5dd;background:#fff;color:#344054;font-weight:600;cursor:pointer;transition:background .15s ease,border-color .15s ease,box-shadow .15s ease,transform .12s ease;}
      .st-btn:hover{background:#f9fafb;border-color:#98a2b3;}
      .st-btn:active{transform:scale(.96);}
      .st-btn.primary{background:var(--primary-readable, var(--primary, #175cd3));border-color:transparent;color:#fff;}
      .st-btn.primary:hover{filter:brightness(1.07);background:var(--primary-readable, var(--primary, #175cd3));}
      .st-btn.icon{padding:8px 10px;}
      .st-body{flex:1;min-height:0;display:flex;}
      .st-main{flex:1;min-width:0;overflow:auto;padding:16px 18px 28px;}
      .st-banner{display:flex;align-items:center;gap:10px;padding:10px 14px;margin-bottom:14px;border:1px solid #fedf89;background:#fffaeb;color:#93370d;border-radius:10px;font-weight:600;}
      /* Consecutive same-size widgets group into auto-fit grid rows, so any
         count works: a wrapped card keeps the exact same track width as its
         row-mates instead of stretching or orphaning. */
      .st-grid{display:flex;flex-direction:column;gap:14px;}
      .st-row-sm{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;}
      .st-row-sm > .st-card:only-child{max-width:360px;}
      .st-row-md{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px;}
      .st-card{background:#fff;border:1px solid #e4e7ec;border-radius:12px;padding:14px 16px;min-width:0;box-sizing:border-box;display:flex;flex-direction:column;transition:box-shadow .2s ease,border-color .2s ease;}
      .st-card:hover{box-shadow:0 6px 20px rgba(16,24,40,.07);border-color:#d0d5dd;}
      .st-card-title{font-size:12.5px;font-weight:700;color:#667085;text-transform:uppercase;letter-spacing:.03em;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;gap:8px;}
      .st-kpi-value{font-size:27px;font-weight:800;color:#101828;line-height:1.15;}
      .st-kpi-sub{font-size:12px;color:#98a2b3;margin-top:3px;}
      .st-chart{width:100%;height:auto;display:block;}
      .st-line{fill:none;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round;}
      .st-node{stroke:#fff;stroke-width:1.5;cursor:pointer;}
      .st-grid-line{stroke:#eaecf0;stroke-width:1;}
      .st-axis{fill:#98a2b3;font-size:11px;}
      .st-bar{rx:3;}
      .st-bar-label{fill:#475467;font-size:11px;}
      .st-legend{display:flex;gap:12px;flex-wrap:wrap;margin-top:8px;font-size:12px;color:#475467;}
      .st-legend span{display:inline-flex;align-items:center;gap:5px;}
      .st-dot{width:9px;height:9px;border-radius:3px;display:inline-block;}
      .st-table{width:100%;border-collapse:collapse;font-size:13px;}
      .st-table td{padding:6px 4px;border-bottom:1px solid #f0f2f5;color:#344054;}
      .st-table td:last-child{text-align:right;font-weight:700;color:#101828;}
      .st-lb-row{display:flex;align-items:center;gap:10px;padding:5px 0;}
      .st-lb-rank{width:20px;color:#98a2b3;font-weight:700;font-size:12px;flex:0 0 auto;}
      .st-lb-name{flex:0 0 34%;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600;color:#344054;}
      .st-lb-bar{flex:1;height:9px;border-radius:5px;background:#f0f2f5;overflow:hidden;}
      .st-lb-bar span{display:block;height:100%;border-radius:5px;}
      .st-lb-value{flex:0 0 auto;font-weight:700;color:#101828;font-size:12.5px;min-width:52px;text-align:right;}
      .st-funnel-row{display:flex;align-items:center;gap:10px;padding:4px 0;}
      .st-funnel-name{flex:0 0 30%;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600;color:#344054;font-size:12.5px;}
      .st-funnel-bar{flex:1;display:flex;align-items:center;gap:8px;}
      .st-funnel-bar span{display:block;height:22px;border-radius:5px;min-width:2px;}
      .st-funnel-value{font-weight:700;font-size:12.5px;color:#101828;}
      .st-funnel-pct{color:#98a2b3;font-size:11.5px;}
      .st-empty{color:#98a2b3;text-align:center;padding:22px 8px;font-weight:600;}
      .st-empty-view{background:#fff;border:1px dashed #d0d5dd;border-radius:14px;padding:44px 20px;text-align:center;color:#667085;}
      .st-empty-view h3{margin:0 0 6px;color:#344054;}
      /* Chat drawer: width is user-resizable (inline flex-basis) and the
         open/close slide animates on flex-basis. */
      .st-chat{flex:0 0 460px;max-width:70%;display:flex;flex-direction:column;border-left:1px solid #e4e7ec;background:#fff;min-height:0;position:relative;overflow:hidden;transition:flex-basis .32s cubic-bezier(.4,0,.2,1),opacity .24s ease,border-color .32s ease;}
      .st-chat.st-closed{flex-basis:0 !important;opacity:0;pointer-events:none;border-left-color:transparent;}
      .st-chat.st-resizing{transition:none;}
      .st-chat-grip{position:absolute;left:0;top:0;bottom:0;width:7px;cursor:col-resize;z-index:30;touch-action:none;}
      .st-chat-grip::after{content:'';position:absolute;left:2px;top:0;bottom:0;width:3px;border-radius:2px;background:transparent;transition:background .15s ease;}
      .st-chat-grip:hover::after,.st-chat-grip.dragging::after{background:var(--primary-readable, var(--primary, #175cd3));opacity:.55;}
      .st-chat-head{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:11px 13px;border-bottom:1px solid #e4e7ec;flex-wrap:nowrap;}
      .st-chat-head .title{font-weight:800;color:#101828;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .st-chat-head .sub{display:block;font-size:11.5px;color:#98a2b3;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .st-chat-head .st-btn.icon{padding:7px 9px;flex:0 0 auto;}
      .st-menu{position:relative;flex:0 0 auto;}
      .st-menu-pop{position:absolute;top:calc(100% + 6px);right:0;z-index:60;background:#fff;border:1px solid #e4e7ec;border-radius:10px;box-shadow:0 8px 24px rgba(16,24,40,.14);min-width:210px;padding:6px;display:flex;flex-direction:column;animation:stPop .16s ease both;transform-origin:top right;}
      .st-menu-item{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:7px;cursor:pointer;font-weight:600;color:#344054;border:none;background:none;text-align:left;font:inherit;font-size:13px;}
      .st-menu-item:hover{background:#f2f4f7;}
      .st-menu-item.disabled{opacity:.45;cursor:default;}
      .st-menu-item.disabled:hover{background:none;}
      .st-menu-item i{width:16px;text-align:center;color:#667085;}
      .st-chat-msgs{flex:1;min-height:0;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:10px;}
      /* Children of a scrollable column flex container must not shrink —
         otherwise tall items (chart renders) collapse instead of scrolling. */
      .st-chat-msgs > *{flex:0 0 auto;}
      .st-msg{max-width:92%;border-radius:12px;padding:9px 12px;font-size:13.5px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word;}
      .st-msg.user{align-self:flex-end;background:var(--primary-readable, var(--primary, #175cd3));color:#fff;border-bottom-right-radius:4px;}
      .st-msg.assistant{align-self:flex-start;background:#f2f4f7;color:#101828;border-bottom-left-radius:4px;white-space:normal;}
      .st-msg.assistant ul,.st-msg.assistant ol{margin:4px 0;padding-left:20px;display:flex;flex-direction:column;gap:2px;}
      .st-msg.assistant code{background:#e7ebf0;border-radius:4px;padding:1px 5px;font-size:12.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}
      .st-msg.assistant.failed code{background:#fdead7;}
      .st-msg.assistant a{color:var(--primary-readable, var(--primary, #175cd3));font-weight:600;}
      .st-md-h{font-weight:800;margin:5px 0 2px;}
      .st-md-gap{height:7px;}
      .st-msg.assistant.failed{background:#fffaeb;border:1px solid #fedf89;color:#93370d;}
      .st-msg .st-msg-note{margin-top:7px;font-size:11.5px;color:#93370d;font-weight:700;}
      .st-msg-changes{margin-top:8px;border-top:1px solid #e4e7ec;padding-top:7px;font-size:12px;color:#475467;}
      .st-msg-changes div{display:flex;gap:6px;align-items:baseline;}
      .st-msg-render{align-self:stretch;max-width:100%;background:#fff;border:1px solid #e4e7ec;border-radius:12px;padding:10px 12px;overflow:hidden;box-sizing:border-box;}
      @keyframes stRise{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:none;}}
      .st-anim{animation:stRise .28s cubic-bezier(.4,0,.2,1) both;}
      @keyframes stPop{from{opacity:0;transform:scale(.95) translateY(-4px);}to{opacity:1;transform:none;}}
      @keyframes stFadeIn{from{opacity:0;}to{opacity:1;}}
      .st-pending{align-self:flex-start;color:#667085;font-size:13px;display:flex;align-items:center;gap:8px;padding:4px 2px;}
      .st-pending .dots span{animation:stPulse 1.2s infinite;display:inline-block;}
      .st-pending .dots span:nth-child(2){animation-delay:.2s}.st-pending .dots span:nth-child(3){animation-delay:.4s}
      @keyframes stPulse{0%,80%,100%{opacity:.25}40%{opacity:1}}
      .st-history-head{font-size:12px;font-weight:800;color:#667085;text-transform:uppercase;letter-spacing:.03em;margin-bottom:4px;}
      .st-history-item{border:1px solid #e4e7ec;border-radius:10px;padding:9px 12px;cursor:pointer;display:flex;flex-direction:column;gap:2px;transition:background .15s ease,border-color .15s ease,transform .15s ease;}
      .st-history-item:hover{background:#f9fafb;border-color:#98a2b3;transform:translateX(2px);}
      .st-history-item .name{font-weight:700;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .st-history-item .meta{font-size:11.5px;color:#98a2b3;font-weight:600;display:flex;gap:6px;flex-wrap:wrap;}
      .st-history-item .meta .view-badge{color:#475467;}
      .st-composer{flex:0 0 auto;display:flex;gap:8px;padding:11px 13px;border-top:1px solid #e4e7ec;}
      .st-composer textarea{flex:1;resize:none;border:1px solid #d0d5dd;border-radius:9px;padding:9px 11px;font:inherit;min-height:74px;max-height:190px;}
      .st-composer button{align-self:flex-end;}
      /* Modal */
      .st-overlay{position:fixed;inset:0;background:rgba(16,24,40,.45);z-index:1200;display:flex;align-items:center;justify-content:center;padding:18px;animation:stFadeIn .18s ease both;}
      .st-modal{background:#fff;border-radius:14px;width:min(480px,100%);max-height:92vh;overflow:auto;padding:20px;animation:stPop .2s ease both;transform-origin:center;}
      .st-modal h3{margin:0 0 14px;}
      .st-field{margin-bottom:13px;}
      .st-field label{display:block;font-size:12px;font-weight:700;color:#475467;margin-bottom:5px;}
      .st-field input,.st-field textarea{width:100%;border:1px solid #d0d5dd;border-radius:8px;padding:8px 11px;font:inherit;box-sizing:border-box;}
      .st-swatches{display:flex;gap:7px;flex-wrap:wrap;}
      .st-swatch{width:28px;height:28px;border-radius:8px;cursor:pointer;border:2px solid transparent;display:inline-flex;align-items:center;justify-content:center;color:#475467;background:#f2f4f7;}
      .st-swatch.color{color:transparent;}
      .st-swatch.selected{border-color:#101828;}
      .st-modal-actions{display:flex;gap:9px;justify-content:flex-end;margin-top:16px;}
      .st-modal-actions .danger{color:#b42318;border-color:#fda29b;margin-right:auto;}
      .st-preset-list{display:flex;flex-direction:column;gap:8px;}
      .st-preset-item{display:flex;align-items:center;gap:10px;border:1px solid #e4e7ec;border-radius:10px;padding:10px 12px;cursor:pointer;}
      .st-preset-item:hover{background:#f9fafb;}
      .st-preset-item .name{font-weight:700;color:#101828;}
      .st-preset-item .desc{font-size:12px;color:#667085;}
      @media (max-width:900px){.st-body{flex-direction:column;}.st-chat{flex:1;flex-basis:auto !important;max-width:none;border-left:none;border-top:1px solid #e4e7ec;transition:none;}.st-chat.st-closed{display:none;}.st-chat-grip{display:none;}}
      @media (max-width:640px){.st-row-sm{grid-template-columns:repeat(2,1fr);}.st-row-sm > .st-card:only-child{max-width:none;}}
    `;
    document.head.appendChild(style);
  }

  // ── Widget rendering (shared by dashboard cards and chat renders) ────────

  // Formula metrics carry their group_by inside their inputs — resolve the
  // effective dimension so labels (user names, template names) still apply.
  function effectiveGroupBy(spec){
    const source = object(spec);
    if (clean(source.group_by)) return clean(source.group_by);
    const inputs = object(source.inputs);
    for (const key of Object.keys(inputs)) {
      const nested = effectiveGroupBy(inputs[key]);
      if (nested) return nested;
    }
    return '';
  }

  function labelForRow(row, spec, labels){
    const raw = clean(row.group);
    if (row.group_label) return clean(row.group_label);
    const groupBy = effectiveGroupBy(spec);
    if (['primary_user_id', 'actor_user_id', 'project_user_id'].includes(groupBy)) {
      return labels.users.get(raw) || (raw ? raw.slice(0, 12) : 'Unassigned');
    }
    if (['template_id', 'project_template_id'].includes(groupBy)) return labels.templates.get(raw) || raw || 'No type';
    if (!raw) return groupBy === 'source' ? 'No source' : '—';
    return raw;
  }

  function seriesOf(widget, data){
    const metrics = array(widget.metrics);
    if (metrics.length) {
      return metrics.map((entry, index) => ({
        key: clean(object(entry).key) || `Series ${index + 1}`,
        spec: object(object(entry).spec),
        rows: array(object(data)[clean(object(entry).key) || `Series ${index + 1}`])
      }));
    }
    const key = Object.keys(object(data))[0];
    return [{ key: clean(widget.title) || 'Value', spec: object(widget.metric), rows: array(object(data)[key]) }];
  }

  function svgLineChart(widget, data, labels){
    const series = seriesOf(widget, data);
    const format = clean(widget.format) || 'number';
    const buckets = [...new Set(series.flatMap((s) => s.rows.map((row) => clean(row.bucket))))].filter(Boolean).sort();
    if (!buckets.length) return `<div class="st-empty">${(globalThis.PlatformLanguage?.htmlText("stats","m_660a3c1af32a63","No data for this period") ?? "No data for this period")}</div>`;
    const width = 1080, height = 300, padX = 46, padY = 26;
    const values = series.flatMap((s) => s.rows.map((row) => Number(row.value) || 0));
    const max = Math.max(...values, 1);
    const min = Math.min(...values, 0);
    const x = (index) => buckets.length === 1 ? width / 2 : padX + (index * (width - padX * 2)) / (buckets.length - 1);
    const y = (value) => height - padY - ((value - min) / (max - min || 1)) * (height - padY * 2);
    const gridLines = [0, 0.25, 0.5, 0.75, 1].map((frac) => {
      const value = min + frac * (max - min);
      return `<line class="st-grid-line" x1="${padX}" x2="${width - padX}" y1="${y(value)}" y2="${y(value)}"></line>`
        + `<text class="st-axis" x="${padX - 6}" y="${y(value) + 4}" text-anchor="end">${esc(formatValue(value, format))}</text>`;
    }).join('');
    const step = Math.max(1, Math.ceil(buckets.length / 10));
    const xLabels = buckets.map((bucket, index) => index % step ? '' :
      `<text class="st-axis" x="${x(index)}" y="${height - 6}" text-anchor="middle">${esc(formatBucket(bucket))}</text>`).join('');
    const lines = series.map((s, si) => {
      const color = SERIES_COLORS[si % SERIES_COLORS.length];
      const byBucket = new Map(s.rows.map((row) => [clean(row.bucket), row]));
      const points = buckets.map((bucket, index) => {
        const row = byBucket.get(bucket);
        return { index, value: row && row.value !== null ? Number(row.value) : 0, present: Boolean(row) };
      });
      const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.index).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
      const nodes = points.map((p) =>
        `<circle class="st-node" cx="${x(p.index).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="3.4" fill="${color}">`
        + `<title>${esc(s.key)} — ${esc(formatBucket(buckets[p.index]))}: ${esc(formatValue(p.value, format))}</title></circle>`).join('');
      return `<path class="st-line" stroke="${color}" d="${path}"></path>${nodes}`;
    }).join('');
    const legend = series.length > 1
      ? `<div class="st-legend">${series.map((s, si) => `<span><i class="st-dot" style="background:${SERIES_COLORS[si % SERIES_COLORS.length]}"></i>${esc(s.key)}</span>`).join('')}</div>`
      : '';
    return `<svg class="st-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img">${gridLines}${xLabels}${lines}</svg>${legend}`;
  }

  function svgBarChart(widget, data, labels){
    const series = seriesOf(widget, data);
    const format = clean(widget.format) || 'number';
    const rows = series[0].rows.filter((row) => row.group !== undefined || row.bucket !== undefined);
    if (!rows.length) return `<div class="st-empty">${(globalThis.PlatformLanguage?.htmlText("stats","m_660a3c1af32a63","No data for this period") ?? "No data for this period")}</div>`;
    const width = 1080, height = 300, padX = 46, padY = 34;
    const max = Math.max(...rows.map((row) => Number(row.value) || 0), 1);
    const band = (width - padX * 2) / rows.length;
    const barWidth = Math.min(64, band * 0.62);
    const bars = rows.map((row, index) => {
      const value = Number(row.value) || 0;
      const barHeight = Math.max(1, (value / max) * (height - padY * 2));
      const cx = padX + band * index + band / 2;
      const name = row.bucket !== undefined ? formatBucket(row.bucket) : labelForRow(row, series[0].spec, labels);
      const shortName = name.length > 13 ? `${name.slice(0, 12)}…` : name;
      return `<rect class="st-bar" x="${(cx - barWidth / 2).toFixed(1)}" y="${(height - padY - barHeight).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" fill="${SERIES_COLORS[0]}">`
        + `<title>${esc(name)}: ${esc(formatValue(value, format))}</title></rect>`
        + `<text class="st-bar-label" x="${cx.toFixed(1)}" y="${height - 8}" text-anchor="middle">${esc(shortName)}</text>`;
    }).join('');
    const gridLines = [0.5, 1].map((frac) => {
      const y = height - padY - frac * (height - padY * 2);
      return `<line class="st-grid-line" x1="${padX}" x2="${width - padX}" y1="${y}" y2="${y}"></line>`
        + `<text class="st-axis" x="${padX - 6}" y="${y + 4}" text-anchor="end">${esc(formatValue(max * frac, format))}</text>`;
    }).join('');
    return `<svg class="st-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img">${gridLines}${bars}</svg>`;
  }

  function svgDonut(widget, data, labels){
    const series = seriesOf(widget, data);
    const format = clean(widget.format) || 'number';
    const rows = series[0].rows.filter((row) => Number(row.value) > 0).slice(0, 8);
    if (!rows.length) return `<div class="st-empty">${(globalThis.PlatformLanguage?.htmlText("stats","m_660a3c1af32a63","No data for this period") ?? "No data for this period")}</div>`;
    const total = rows.reduce((sum, row) => sum + Number(row.value || 0), 0) || 1;
    const cx = 90, cy = 90, r = 62, strokeW = 26, circumference = 2 * Math.PI * r;
    let offset = 0;
    const arcs = rows.map((row, index) => {
      const frac = Number(row.value || 0) / total;
      const dash = `${(frac * circumference).toFixed(2)} ${circumference.toFixed(2)}`;
      const rotate = (offset * 360 - 90).toFixed(2);
      offset += frac;
      const name = labelForRow(row, series[0].spec, labels);
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${SERIES_COLORS[index % SERIES_COLORS.length]}" stroke-width="${strokeW}"`
        + ` stroke-dasharray="${dash}" transform="rotate(${rotate} ${cx} ${cy})">`
        + `<title>${esc(name)}: ${esc(formatValue(row.value, format))} (${(frac * 100).toFixed(1)}%)</title></circle>`;
    }).join('');
    const legend = rows.map((row, index) =>
      `<span><i class="st-dot" style="background:${SERIES_COLORS[index % SERIES_COLORS.length]}"></i>${esc(labelForRow(row, series[0].spec, labels))} · ${esc(formatValue(row.value, format))}</span>`).join('');
    return `<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;">`
      + `<svg class="st-chart" viewBox="0 0 180 180" style="max-width:150px;flex:0 0 150px;" role="img">${arcs}</svg>`
      + `<div class="st-legend" style="flex-direction:column;align-items:flex-start;gap:6px;margin-top:0;">${legend}</div></div>`;
  }

  function tableWidget(widget, data, labels){
    const series = seriesOf(widget, data);
    const format = clean(widget.format) || 'number';
    const rows = series[0].rows.slice(0, 15);
    if (!rows.length) return `<div class="st-empty">${(globalThis.PlatformLanguage?.htmlText("stats","m_660a3c1af32a63","No data for this period") ?? "No data for this period")}</div>`;
    return `<table class="st-table">${rows.map((row) =>
      `<tr><td>${esc(row.bucket !== undefined ? formatBucket(row.bucket) : labelForRow(row, series[0].spec, labels))}</td>`
      + `<td>${esc(formatValue(row.value, format))}</td></tr>`).join('')}</table>`;
  }

  function leaderboardWidget(widget, data, labels){
    const series = seriesOf(widget, data);
    const format = clean(widget.format) || 'number';
    const rows = series[0].rows.filter((row) => row.value !== null).slice(0, 15);
    if (!rows.length) return `<div class="st-empty">${(globalThis.PlatformLanguage?.htmlText("stats","m_660a3c1af32a63","No data for this period") ?? "No data for this period")}</div>`;
    const max = Math.max(...rows.map((row) => Number(row.value) || 0), 1);
    return rows.map((row, index) => {
      const pct = Math.max(2, (Number(row.value || 0) / max) * 100);
      return `<div class="st-lb-row"><span class="st-lb-rank">${index + 1}</span>`
        + `<span class="st-lb-name">${esc(labelForRow(row, series[0].spec, labels))}</span>`
        + `<span class="st-lb-bar"><span style="width:${pct.toFixed(1)}%;background:${SERIES_COLORS[index < 3 ? 1 : 0]}"></span></span>`
        + `<span class="st-lb-value">${esc(formatValue(row.value, format))}</span></div>`;
    }).join('');
  }

  function funnelWidget(widget, data, labels){
    const series = seriesOf(widget, data);
    const format = clean(widget.format) || 'number';
    const rows = series[0].rows.filter((row) => row.value !== null).slice(0, 10);
    if (!rows.length) return `<div class="st-empty">${(globalThis.PlatformLanguage?.htmlText("stats","m_660a3c1af32a63","No data for this period") ?? "No data for this period")}</div>`;
    const first = Number(rows[0].value) || 1;
    return rows.map((row, index) => {
      const value = Number(row.value || 0);
      const pct = Math.max(3, (value / (first || 1)) * 100);
      return `<div class="st-funnel-row"><span class="st-funnel-name">${esc(labelForRow(row, series[0].spec, labels))}</span>`
        + `<span class="st-funnel-bar"><span style="width:${pct.toFixed(1)}%;background:${SERIES_COLORS[index % SERIES_COLORS.length]}"></span>`
        + `<span class="st-funnel-value">${esc(formatValue(value, format))}</span>`
        + (index ? `<span class="st-funnel-pct">${((value / first) * 100).toFixed(0)}%</span>` : '')
        + `</span></div>`;
    }).join('');
  }

  function kpiWidget(widget, data){
    const series = seriesOf(widget, data);
    const format = clean(widget.format) || 'number';
    const rows = series[0].rows;
    const value = rows.length ? rows[0].value : null;
    const count = rows.length && rows[0].row_count !== undefined ? Number(rows[0].row_count) : null;
    return `<div class="st-kpi-value">${esc(formatValue(value, format))}</div>`
      + (count !== null && format !== 'number' ? `<div class="st-kpi-sub">${((v0,v1) => globalThis.PlatformLanguage?.htmlText("stats","m_8dca106357a148",`${v0} project${v1}`,{v0,v1}) ?? `${v0} project${v1}`)(count.toLocaleString(globalThis.PlatformLanguage?.formatLocale?.()),count === 1 ? '' : 's')}</div>` : '');
  }

  function renderWidgetBody(widget, data, labels){
    try {
      switch (clean(widget.type)) {
        case 'kpi': return kpiWidget(widget, data);
        case 'line': return svgLineChart(widget, data, labels);
        case 'bar': return svgBarChart(widget, data, labels);
        case 'donut': return svgDonut(widget, data, labels);
        case 'table': return tableWidget(widget, data, labels);
        case 'leaderboard': return leaderboardWidget(widget, data, labels);
        case 'funnel': return funnelWidget(widget, data, labels);
        default: return `<div class="st-empty">${(globalThis.PlatformLanguage?.htmlText("stats","m_d208e9fbfaba01","Unknown widget type") ?? "Unknown widget type")}</div>`;
      }
    } catch (error) {
      return `<div class="st-empty">${((v0) => globalThis.PlatformLanguage?.htmlText("stats","m_021aef9ec4e168",`Could not render (${v0})`,{v0}) ?? `Could not render (${v0})`)(esc(error && error.message))}</div>`;
    }
  }

  // ── Query assembly ───────────────────────────────────────────────────────

  // A widget's metric gets the dashboard time range only when its spec names
  // a time field without pinning its own preset/range; point-in-time widgets
  // (time:{}) stay all-time.
  function withRange(spec, preset){
    const clone = JSON.parse(JSON.stringify(object(spec)));
    const apply = (node) => {
      const time = object(node.time);
      if (time.field && !time.preset && !time.from) {
        node.time = preset === 'all_time' ? { field: time.field, ...(time.bucket ? { bucket: time.bucket } : {}) } : { ...time, preset };
      }
      Object.keys(object(node.inputs)).forEach((key) => apply(object(node.inputs)[key]));
    };
    apply(clone);
    return clone;
  }

  function widgetQueries(view, preset){
    const queries = {};
    const mapping = [];
    array(object(view.definition).widgets).forEach((widget) => {
      const id = clean(widget.id);
      if (!id) return;
      const metrics = array(widget.metrics);
      if (metrics.length) {
        metrics.forEach((entry, index) => {
          const key = `${id}::${clean(object(entry).key) || `Series ${index + 1}`}`;
          queries[key] = withRange(object(entry).spec, preset);
          mapping.push({ queryKey: key, widgetId: id, seriesKey: clean(object(entry).key) || `Series ${index + 1}` });
        });
      } else if (widget.metric) {
        const key = `${id}`;
        queries[key] = withRange(widget.metric, preset);
        mapping.push({ queryKey: key, widgetId: id, seriesKey: clean(widget.title) || 'Value' });
      }
    });
    return { queries, mapping };
  }

  // ── The app ──────────────────────────────────────────────────────────────

  function createApp(context){
    const root = context.roots?.main || context.root;
    if (!root) return { destroy(){} };
    injectCss();
    const api = window.StatsAPI;
    const host = context.host || {};
    const showToast = typeof host.showToast === 'function' ? host.showToast : () => {};

    // Route values come from the navigation router, not context.params — the
    // mount context carries the param *definitions*, not resolved values.
    const routeValue = (key) => {
      const fromNav = clean(object(window.Portal?.navigation?.read?.())[key]);
      if (fromNav) return fromNav;
      const fromContext = object(context.params)[key];
      return typeof fromContext === 'string' ? clean(fromContext) : '';
    };
    const routeThreadId = routeValue('statsThread');
    const state = {
      destroyed: false,
      orgId: clean(context.orgId),
      branchId: clean(context.branchId || 'default') || 'default',
      views: [],
      activeViewId: routeValue('statsView') || localStorage.getItem('fm_stats_view') || '',
      range: localStorage.getItem('fm_stats_range') || '',
      widgetData: {},
      labels: { users: new Map(), templates: new Map() },
      schema: null,
      sync: null,
      loading: false,
      loadToken: 0,
      chatOpen: localStorage.getItem('fm_stats_chat') === '1',
      chatWidth: Math.min(760, Math.max(360, Number(localStorage.getItem('fm_stats_chat_width')) || 460)),
      chat: { mode: 'chat', menuOpen: false, threadId: '', messages: [], sending: false, viewId: null, threads: [] },
      pendingThreadId: routeThreadId.startsWith('stats_thread_') ? routeThreadId : '',
      modal: null,
      syncPollTimer: null
    };

    function activeView(){
      return state.views.find((view) => view.id === state.activeViewId) || state.views[0] || null;
    }

    function currentRange(){
      const view = activeView();
      return state.range || clean(object(view?.definition).time_default) || 'this_month';
    }

    // ── Data loading ───────────────────────────────────────────────────────

    async function loadSchema(){
      try {
        const result = await api.schema(state.orgId);
        if (state.destroyed) return;
        state.schema = object(result.schema);
        state.sync = object(result.sync);
        state.labels.users = new Map(array(state.schema.users).map((user) => [clean(user.id), clean(user.name) || clean(user.email)]));
        state.labels.templates = new Map(array(state.schema.templates).map((tpl) => [clean(tpl.id), clean(tpl.name)]));
      } catch (_) {}
    }

    async function loadViews(){
      const result = await api.views.list(state.orgId);
      if (state.destroyed) return;
      state.views = array(result.views);
      if (!state.views.some((view) => view.id === state.activeViewId)) {
        state.activeViewId = state.views.length ? state.views[0].id : '';
      }
    }

    async function loadWidgetData(){
      const view = activeView();
      if (!view) { state.widgetData = {}; return; }
      const { queries, mapping } = widgetQueries(view, currentRange());
      if (!mapping.length) { state.widgetData = {}; return; }
      const token = ++state.loadToken;
      state.loading = true;
      renderMain();
      try {
        const result = await api.query(state.orgId, queries);
        if (state.destroyed || token !== state.loadToken) return;
        state.sync = object(result.sync);
        const data = {};
        mapping.forEach((entry) => {
          const rows = array(object(object(result.results)[entry.queryKey]).rows);
          data[entry.widgetId] = data[entry.widgetId] || {};
          data[entry.widgetId][entry.seriesKey] = rows;
        });
        state.widgetData = data;
      } catch (error) {
        if (token === state.loadToken) showToast(clean(error && error.message) || 'Could not load stats.', (globalThis.PlatformLanguage?.text("stats","m_7e784f9b5540ab","error") ?? "error"));
      } finally {
        if (token === state.loadToken) {
          state.loading = false;
          renderMain();
          scheduleSyncPoll();
        }
      }
    }

    function scheduleSyncPoll(){
      if (state.syncPollTimer) { clearTimeout(state.syncPollTimer); state.syncPollTimer = null; }
      if (state.sync && state.sync.backfill_done === false && !state.destroyed) {
        state.syncPollTimer = setTimeout(async () => {
          await loadSchema();
          await loadWidgetData();
        }, 5000);
      }
    }

    async function reloadAll(){
      await Promise.all([loadSchema(), loadViews()]);
      renderShell();
      await loadWidgetData();
    }

    // ── Rendering ──────────────────────────────────────────────────────────

    function renderShell(){
      if (state.destroyed) return;
      root.innerHTML = `
        <div class="st-shell">
          <div class="st-top">
            <div class="st-views" data-st="views"></div>
            <span class="st-spacer"></span>
            <div class="st-controls">
              <select class="st-select" data-st="range"></select>
              <button class="st-btn icon" data-st="edit-view" title="${(globalThis.PlatformLanguage?.htmlText("stats","m_551e1ad0a3a732","View settings") ?? "View settings")}"><i class="fas fa-pen"></i></button>
              <button class="st-btn ${String(state.chatOpen ? '' : 'primary')}" data-st="chat-toggle"><i class="fas fa-wand-magic-sparkles"></i>${(globalThis.PlatformLanguage?.htmlText("stats","m_be03b42e0b7fe3"," Assistant") ?? " Assistant")}</button>
            </div>
          </div>
          <div class="st-body">
            <div class="st-main" data-st="main"></div>
            <div class="st-chat ${String(state.chatOpen ? '' : 'st-closed')}" data-st="chat" style="flex-basis:${String(state.chatWidth)}px;"></div>
          </div>
        </div>`;
      renderViewPills();
      renderRangeSelect();
      renderMain();
      renderChat();
      // Toggling animates the drawer via class, without rebuilding the shell.
      root.querySelector('[data-st="chat-toggle"]')?.addEventListener('click', (event) => {
        state.chatOpen = !state.chatOpen;
        localStorage.setItem('fm_stats_chat', state.chatOpen ? '1' : '0');
        root.querySelector('[data-st="chat"]')?.classList.toggle('st-closed', !state.chatOpen);
        event.currentTarget?.classList.toggle('primary', !state.chatOpen);
        if (state.chatOpen) ensureChatThread();
        else if (state.chat.menuOpen) { state.chat.menuOpen = false; renderChat(); }
      });
      root.querySelector('[data-st="edit-view"]')?.addEventListener('click', () => openViewModal(activeView()));
      root.querySelector('[data-st="range"]')?.addEventListener('change', (event) => {
        state.range = clean(event.target.value);
        localStorage.setItem('fm_stats_range', state.range);
        loadWidgetData();
      });
    }

    function renderViewPills(){
      const holder = root.querySelector('[data-st="views"]');
      if (!holder) return;
      const active = activeView();
      holder.innerHTML = state.views.map((view) => {
        const isActive = active && view.id === active.id;
        const color = clean(view.color) || '#175cd3';
        return `<button class="st-view-pill ${isActive ? 'active' : ''}" data-view="${esc(view.id)}"`
          + ` style="${isActive ? `background:${esc(color)};` : ''}">`
          + `<i class="fas ${esc(clean(view.icon) || 'fa-chart-line')}"></i>${esc(view.title || (globalThis.PlatformLanguage?.text("stats","m_05017f54f07448","Untitled") ?? "Untitled"))}</button>`;
      }).join('') + `<button class="st-view-add" data-st="add-view"><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("stats","m_5fb7c1bfee1406"," New view") ?? " New view")}</button>`;
      holder.querySelectorAll('[data-view]').forEach((el) => el.addEventListener('click', () => {
        state.activeViewId = clean(el.getAttribute('data-view'));
        state.range = '';
        localStorage.setItem('fm_stats_view', state.activeViewId);
        try { host.setRoute && host.setRoute({ statsView: state.activeViewId }); } catch (_) {}
        renderShell();
        loadWidgetData();
        if (state.chatOpen) ensureChatThread(true);
      }));
      holder.querySelector('[data-st="add-view"]')?.addEventListener('click', () => openViewModal(null));
    }

    function renderRangeSelect(){
      const select = root.querySelector('[data-st="range"]');
      if (!select) return;
      const current = currentRange();
      select.innerHTML = TIME_RANGES.map(([key, label]) =>
        `<option value="${esc(key)}" ${key === current ? 'selected' : ''}>${esc(label)}</option>`).join('');
    }

    function renderMain(){
      const main = root.querySelector('[data-st="main"]');
      if (!main) return;
      const view = activeView();
      const banner = state.sync && state.sync.backfill_done === false
        ? `<div class="st-banner"><i class="fas fa-rotate fa-spin"></i>${(globalThis.PlatformLanguage?.htmlText("stats","m_254672ac54bfa8"," Building your stats warehouse — numbers may be incomplete for a minute…") ?? " Building your stats warehouse — numbers may be incomplete for a minute…")}</div>`
        : '';
      if (!view) {
        main.innerHTML = (String(banner) + "<div class=\"st-empty-view\"><h3>" + (globalThis.PlatformLanguage?.htmlText("stats","m_cd4d9d5b397b33","No stats views yet") ?? "No stats views yet") + "</h3><p>" + (globalThis.PlatformLanguage?.htmlText("stats","m_e7c73800d52870","Create a view or ask the assistant to build one for you.") ?? "Create a view or ask the assistant to build one for you.") + "</p></div>");
        return;
      }
      const widgets = array(object(view.definition).widgets);
      if (!widgets.length) {
        main.innerHTML = (String(banner) + "<div class=\"st-empty-view\"><h3>" + ((v1) => globalThis.PlatformLanguage?.htmlText("stats","m_02ca24837389af",`${v1} is empty`,{v1}) ?? `${v1} is empty`)(esc(view.title)) + "</h3>")
          + `<p>${(globalThis.PlatformLanguage?.htmlText("stats","m_c52e1e28af7e4e","Open the assistant and describe what you want to see — it will build the widgets for you.") ?? "Open the assistant and describe what you want to see — it will build the widgets for you.")}</p></div>`;
        return;
      }
      const cardHtml = (widget) => {
        const data = object(state.widgetData[clean(widget.id)]);
        const body = state.loading && !Object.keys(data).length
          ? `<div class="st-empty">${(globalThis.PlatformLanguage?.htmlText("stats","m_d2da77452877dd","Loading…") ?? "Loading…")}</div>`
          : renderWidgetBody(widget, data, state.labels);
        return `<div class="st-card ${esc(clean(widget.size) || 'md')}"><div class="st-card-title"><span>${esc(widget.title || '')}</span></div>${body}</div>`;
      };
      // Group consecutive sm/md widgets into shared auto-fit rows; lg/xl
      // widgets each take their own full-width block.
      const blocks = [];
      let run = null;
      widgets.forEach((widget) => {
        const size = clean(widget.size) || 'md';
        const tier = size === 'sm' ? 'sm' : size === 'md' ? 'md' : 'full';
        if (tier === 'full') {
          run = null;
          blocks.push({ tier, items: [widget] });
          return;
        }
        if (!run || run.tier !== tier) {
          run = { tier, items: [] };
          blocks.push(run);
        }
        run.items.push(widget);
      });
      main.innerHTML = `${banner}<div class="st-grid">${blocks.map((block) => block.tier === 'full'
        ? cardHtml(block.items[0])
        : `<div class="st-row-${block.tier}">${block.items.map(cardHtml).join('')}</div>`).join('')}</div>`;
    }

    // ── View modal ─────────────────────────────────────────────────────────

    function closeModal(){
      if (state.modal) state.modal.remove();
      state.modal = null;
    }

    function openViewModal(view){
      closeModal();
      const isNew = !view;
      const selected = {
        icon: clean(view?.icon) || 'fa-chart-line',
        color: clean(view?.color) || '#175cd3'
      };
      const overlay = document.createElement('div');
      overlay.className = 'st-overlay';
      overlay.innerHTML = `
        <div class="st-modal">
          <h3>${String(isNew ? 'New stats view' : 'View settings')}</h3>
          <div class="st-field"><label>${(globalThis.PlatformLanguage?.htmlText("stats","m_29dbd3d8b69f55","Title") ?? "Title")}</label><input data-m="title" maxlength="60" value="${String(esc(view?.title || ''))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("stats","m_94556c446164c0","e.g. Sales Overview") ?? "e.g. Sales Overview")}"></div>
          <div class="st-field"><label>${(globalThis.PlatformLanguage?.htmlText("stats","m_aa136ecb65672f","Description") ?? "Description")}</label><input data-m="description" maxlength="140" value="${String(esc(view?.description || ''))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("stats","m_a3f9a6b065b2d8","Optional") ?? "Optional")}"></div>
          <div class="st-field"><label>${(globalThis.PlatformLanguage?.htmlText("stats","m_3e4ee0ace818e7","Icon") ?? "Icon")}</label><div class="st-swatches" data-m="icons">${String(VIEW_ICONS.map((icon) =>
            `<span class="st-swatch ${icon === selected.icon ? 'selected' : ''}" data-icon="${esc(icon)}"><i class="fas ${esc(icon)}"></i></span>`).join(''))}</div></div>
          <div class="st-field"><label>${(globalThis.PlatformLanguage?.htmlText("stats","m_db7002926d9977","Color") ?? "Color")}</label><div class="st-swatches" data-m="colors">${String(VIEW_COLORS.map((color) =>
            `<span class="st-swatch color ${color === selected.color ? 'selected' : ''}" data-color="${esc(color)}" style="background:${esc(color)}"></span>`).join(''))}</div></div>
          ${String(isNew ? `<div class="st-field"><label>${(globalThis.PlatformLanguage?.htmlText("stats","m_1ceddb8b63f512","Start from") ?? "Start from")}</label><div class="st-preset-list" data-m="presets">
            <div class="st-preset-item" data-preset=""><i class="fas fa-wand-magic-sparkles"></i><div><div class="name">${(globalThis.PlatformLanguage?.htmlText("stats","m_10c61184707116","Blank — build it with the assistant") ?? "Blank — build it with the assistant")}</div><div class="desc">${(globalThis.PlatformLanguage?.htmlText("stats","m_8ec95914a0006b","Create an empty view, then describe what you want to see.") ?? "Create an empty view, then describe what you want to see.")}</div></div></div>
            ${array(object(state.schema).view_presets).map((preset) =>
              `<div class="st-preset-item" data-preset="${esc(preset.id)}"><i class="fas ${esc(preset.icon || 'fa-chart-line')}"></i><div><div class="name">${esc(preset.title)}</div><div class="desc">${esc(preset.description)}</div></div></div>`).join('')}
          </div></div>` : '')}
          <div class="st-modal-actions">
            ${String(!isNew ? `<button class="st-btn danger" data-m="delete">${(globalThis.PlatformLanguage?.htmlText("stats","m_5934f6da3456df","Delete view") ?? "Delete view")}</button>` : '')}
            <button class="st-btn" data-m="cancel">${(globalThis.PlatformLanguage?.htmlText("stats","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button>
            ${String(!isNew ? `<button class="st-btn primary" data-m="save">${(globalThis.PlatformLanguage?.htmlText("stats","m_5bab3e72de1ebf","Save") ?? "Save")}</button>` : '')}
          </div>
        </div>`;
      document.body.appendChild(overlay);
      state.modal = overlay;
      const pick = (holder, attr) => {
        overlay.querySelectorAll(`[data-m="${holder}"] .st-swatch`).forEach((el) => el.addEventListener('click', () => {
          overlay.querySelectorAll(`[data-m="${holder}"] .st-swatch`).forEach((s) => s.classList.remove('selected'));
          el.classList.add('selected');
          selected[attr === 'data-icon' ? 'icon' : 'color'] = clean(el.getAttribute(attr));
        }));
      };
      pick('icons', 'data-icon');
      pick('colors', 'data-color');
      overlay.addEventListener('click', (event) => { if (event.target === overlay) closeModal(); });
      overlay.querySelector('[data-m="cancel"]')?.addEventListener('click', closeModal);

      const readForm = () => ({
        title: clean(overlay.querySelector('[data-m="title"]')?.value),
        description: clean(overlay.querySelector('[data-m="description"]')?.value),
        icon: selected.icon,
        color: selected.color
      });

      if (isNew) {
        overlay.querySelectorAll('[data-m="presets"] .st-preset-item').forEach((el) => el.addEventListener('click', async () => {
          const presetId = clean(el.getAttribute('data-preset'));
          const form = readForm();
          try {
            let created;
            if (presetId) {
              created = await api.views.fromPreset(state.orgId, presetId);
              if (form.title || form.icon !== 'fa-chart-line' || form.color !== '#175cd3') {
                const view = object(created.view);
                created = await api.views.save(state.orgId, clean(view.id), {
                  title: form.title || view.title, description: form.description || view.description,
                  icon: form.icon, color: form.color, definition: object(view.definition)
                });
              }
            } else {
              created = await api.views.create(state.orgId, {
                title: form.title || (globalThis.PlatformLanguage?.text("stats","m_0ab8ca16f3e9a0","New view") ?? "New view"), description: form.description, icon: form.icon, color: form.color,
                definition: { title: form.title || (globalThis.PlatformLanguage?.text("stats","m_0ab8ca16f3e9a0","New view") ?? "New view"), time_default: 'this_month', widgets: [] }
              });
            }
            closeModal();
            state.activeViewId = clean(object(created.view).id);
            localStorage.setItem('fm_stats_view', state.activeViewId);
            await loadViews();
            renderShell();
            await loadWidgetData();
            if (!presetId) {
              state.chatOpen = true;
              localStorage.setItem('fm_stats_chat', '1');
              renderShell();
              ensureChatThread(true);
            }
          } catch (error) {
            showToast(clean(error && error.message) || 'Could not create the view.', (globalThis.PlatformLanguage?.text("stats","m_7e784f9b5540ab","error") ?? "error"));
          }
        }));
      } else {
        overlay.querySelector('[data-m="save"]')?.addEventListener('click', async () => {
          const form = readForm();
          try {
            await api.views.save(state.orgId, view.id, {
              title: form.title || view.title, description: form.description,
              icon: form.icon, color: form.color, definition: object(view.definition)
            });
            closeModal();
            await loadViews();
            renderShell();
          } catch (error) {
            showToast(clean(error && error.message) || 'Could not save the view.', (globalThis.PlatformLanguage?.text("stats","m_7e784f9b5540ab","error") ?? "error"));
          }
        });
        overlay.querySelector('[data-m="delete"]')?.addEventListener('click', async () => {
          if (!window.confirm(((v0) => globalThis.PlatformLanguage?.text("stats","m_5de0b9876cb373",`Delete the "${v0}" view? This cannot be undone.`,{v0}) ?? `Delete the "${v0}" view? This cannot be undone.`)(view.title))) return;
          try {
            await api.views.remove(state.orgId, view.id);
            closeModal();
            state.activeViewId = '';
            await loadViews();
            renderShell();
            await loadWidgetData();
          } catch (error) {
            showToast(clean(error && error.message) || 'Could not delete the view.', (globalThis.PlatformLanguage?.text("stats","m_7e784f9b5540ab","error") ?? "error"));
          }
        });
      }
    }

    // ── Chat ───────────────────────────────────────────────────────────────

    function welcomeMessage(){
      const view = activeView();
      return {
        role: 'assistant',
        content: view
          ? `Hi! I'm your stats assistant. Ask me anything — "how many leads did we get last month?", "who sold the most this quarter?" — or tell me to change the "${view.title}" dashboard and I'll do it.`
          : `Hi! I'm your stats assistant. Ask me anything about your numbers, or ask me to build you a dashboard.`,
        data: { welcome: true }
      };
    }

    function mapThreadMessages(messages){
      return array(messages).map((message) => ({
        role: clean(object(message).role), content: String(object(message).content || ''), data: object(object(message).data)
      }));
    }

    async function ensureChatThread(force){
      const view = activeView();
      const viewId = view ? view.id : '';
      if (!force && state.chat.viewId === viewId && state.chat.threadId) return;
      state.chat = { ...state.chat, mode: 'chat', menuOpen: false, threadId: '', messages: [welcomeMessage()], sending: false, viewId };
      renderChat();
      try {
        const result = await api.agent.threads(state.orgId, { view_id: viewId });
        if (state.destroyed) return;
        const threads = array(result.threads);
        if (threads.length) {
          state.chat.threadId = clean(object(threads[0]).id);
          const detail = await api.agent.thread(state.orgId, state.chat.threadId);
          if (state.destroyed) return;
          state.chat.messages = [welcomeMessage(), ...mapThreadMessages(detail.messages)];
        }
      } catch (_) {}
      setThreadRoute(state.chat.threadId);
      renderChat();
    }

    // Keeps the URL in sync with the open conversation so refreshes and
    // copied links restore it.
    function setThreadRoute(threadId){
      try { host.setRoute && host.setRoute({ statsThread: clean(threadId) }); } catch (_) {}
    }

    // Opens one specific past conversation (from the history list or a shared
    // ?statsThread= deep link), regardless of which view it belonged to.
    async function openThread(threadId){
      try {
        const detail = await api.agent.thread(state.orgId, threadId);
        if (state.destroyed) return;
        const thread = object(detail.thread);
        state.chat = {
          ...state.chat,
          mode: 'chat',
          menuOpen: false,
          threadId: clean(thread.id),
          viewId: clean(thread.view_id),
          messages: mapThreadMessages(detail.messages),
          sending: false
        };
        setThreadRoute(thread.id);
        renderChat();
      } catch (error) {
        setThreadRoute('');
        showToast(clean(error && error.message) || 'Could not open that conversation.', (globalThis.PlatformLanguage?.text("stats","m_7e784f9b5540ab","error") ?? "error"));
      }
    }

    async function openHistory(){
      state.chat.mode = 'history';
      renderChat();
      try {
        const result = await api.agent.threads(state.orgId, {});
        if (state.destroyed) return;
        state.chat.threads = array(result.threads);
      } catch (_) {
        state.chat.threads = [];
      }
      renderChat();
    }

    function viewTitleFor(viewId){
      const view = state.views.find((item) => item.id === clean(viewId));
      return view ? clean(view.title) : '';
    }

    function threadDate(value){
      const date = new Date(clean(value));
      return Number.isFinite(date.getTime())
        ? `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
        : '';
    }

    function threadLink(threadId){
      const params = new URLSearchParams({ tab: 'stats', statsThread: clean(threadId) });
      return `${location.origin}${location.pathname}?${params.toString()}`;
    }

    async function copyThreadLink(){
      if (!state.chat.threadId) return;
      const url = threadLink(state.chat.threadId);
      try {
        await navigator.clipboard.writeText(url);
        showToast((globalThis.PlatformLanguage?.text("stats","m_8af3af0fe0d467","Link copied — teammates with Stats access can open this conversation.") ?? "Link copied — teammates with Stats access can open this conversation."), (globalThis.PlatformLanguage?.text("stats","m_b4e54589824dc5","success") ?? "success"));
      } catch (_) {
        window.prompt((globalThis.PlatformLanguage?.text("stats","m_9cb90a16e71917","Copy this conversation link:") ?? "Copy this conversation link:"), url);
      }
    }

    function renderRowsMarkdown(widget, data){
      const lines = [];
      const format = clean(widget.format) || 'number';
      Object.entries(object(data)).forEach(([seriesKey, rows]) => {
        const list = array(rows);
        if (!list.length) return;
        if (Object.keys(object(data)).length > 1) lines.push(`_${seriesKey}_`, '');
        const hasBucket = list.some((row) => object(row).bucket !== undefined);
        const hasGroup = list.some((row) => object(row).group !== undefined);
        const header = [...(hasBucket ? ['Period'] : []), ...(hasGroup ? ['Group'] : []), 'Value'];
        lines.push(`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`);
        list.slice(0, 50).forEach((raw) => {
          const row = object(raw);
          const cells = [
            ...(hasBucket ? [clean(row.bucket)] : []),
            ...(hasGroup ? [labelForRow(row, object(widget.metric), state.labels)] : []),
            formatValue(row.value, format)
          ];
          lines.push(`| ${cells.map((cell) => String(cell).replace(/\|/g, '\\|')).join(' | ')} |`);
        });
        lines.push('');
      });
      return lines;
    }

    function exportThread(){
      const view = viewTitleFor(state.chat.viewId);
      const lines = [
        '# Stats assistant conversation',
        '',
        `- Exported: ${new Date().toLocaleString(globalThis.PlatformLanguage?.formatLocale?.())}`,
        ...(view ? [`- Dashboard: ${view}`] : []),
        ''
      ];
      state.chat.messages.forEach((message) => {
        const data = object(message.data);
        if (data.welcome) return;
        lines.push(`## ${message.role === 'user' ? 'You' : 'Stats assistant'}`, '', String(message.content || ''), '');
        if (clean(data.status) === 'failed') lines.push('_This run failed; any dashboard changes were rolled back._', '');
        array(data.changes).forEach((change) => lines.push(`- Changed: ${change}`));
        if (array(data.changes).length) lines.push('');
        array(data.renders).forEach((render) => {
          const widget = object(object(render).widget);
          lines.push(`### ${clean(widget.title) || 'Chart'}`, '');
          lines.push(...renderRowsMarkdown(widget, object(object(render).data)));
        });
      });
      const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
      const anchor = document.createElement('a');
      anchor.href = URL.createObjectURL(blob);
      anchor.download = `stats-conversation-${new Date().toISOString().slice(0, 10)}.md`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(anchor.href), 5000);
    }

    function messageHtml(message, animate){
      const anim = animate ? ' st-anim' : '';
      if (message.role === 'user') return `<div class="st-msg user${anim}">${esc(message.content)}</div>`;
      const data = object(message.data);
      const failed = clean(data.status) === 'failed';
      const reverted = array(data.reverted_views).length > 0;
      const changes = array(data.changes);
      let html = `<div class="st-msg assistant${anim} ${failed ? 'failed' : ''}">${renderMarkdown(message.content)}`;
      if (failed && reverted) html += `<div class="st-msg-note"><i class="fas fa-rotate-left"></i>${(globalThis.PlatformLanguage?.htmlText("stats","m_949b863139b69d"," Changes were rolled back") ?? " Changes were rolled back")}</div>`;
      if (!failed && changes.length) {
        html += `<div class="st-msg-changes"><strong>${(globalThis.PlatformLanguage?.htmlText("stats","m_c46a636ed38aee","What changed") ?? "What changed")}</strong>${String(changes.map((change) => `<div><i class="fas fa-check" style="color:#12b76a;font-size:10px;"></i><span>${esc(change)}</span></div>`).join(''))}</div>`;
      }
      html += `</div>`;
      array(data.renders).slice(0, 8).forEach((render) => {
        const widget = object(object(render).widget);
        const renderData = object(object(render).data);
        html += `<div class="st-msg-render${anim}"><div class="st-card-title"><span>${esc(widget.title || '')}</span></div>${renderWidgetBody(widget, renderData, state.labels)}</div>`;
      });
      return html;
    }

    function renderChat(){
      const chat = root.querySelector('[data-st="chat"]');
      if (!chat) return;
      const view = activeView();
      const history = state.chat.mode === 'history';
      const focusTitle = viewTitleFor(state.chat.viewId) || (view ? clean(view.title) : '');
      const hasConversation = state.chat.threadId && state.chat.messages.some((message) => message.role === 'user');
      const body = history
        ? `<div class="st-chat-msgs" data-c="msgs" style="gap:8px;">
            <div class="st-history-head">${(globalThis.PlatformLanguage?.htmlText("stats","m_6cd0ffdbdacd6f","Past conversations") ?? "Past conversations")}</div>
            ${String(state.chat.threads.length ? state.chat.threads.map((thread) => {
              const item = object(thread);
              const badge = viewTitleFor(item.view_id);
              return `<div class="st-history-item" data-thread="${esc(item.id)}">
                <span class="name">${esc(clean(item.title) || 'Untitled conversation')}</span>
                <span class="meta"><span>${esc(threadDate(item.updated_at))}</span>${badge ? `<span class="view-badge"><i class="fas fa-table-columns"></i> ${esc(badge)}</span>` : `<span class="view-badge">${(globalThis.PlatformLanguage?.htmlText("stats","m_df7920138f71f7","General") ?? "General")}</span>`}</span>
              </div>`;
            }).join('') : `<div class="st-empty">${(globalThis.PlatformLanguage?.htmlText("stats","m_872b5ed945ab78","No conversations yet") ?? "No conversations yet")}</div>`)}
          </div>`
        : `<div class="st-chat-msgs" data-c="msgs">
            ${String(state.chat.messages.map((message, index) => messageHtml(message, index === state.chat.messages.length - 1)).join(''))}
            ${String(state.chat.sending ? `<div class="st-pending st-anim"><span>${(globalThis.PlatformLanguage?.htmlText("stats","m_d8d206799cb842","Working on it") ?? "Working on it")}</span><span class="dots"><span>•</span><span>•</span><span>•</span></span></div>` : '')}
          </div>
          <div class="st-composer">
            <textarea data-c="input" rows="3" placeholder="${(globalThis.PlatformLanguage?.htmlText("stats","m_990c63d35bf9fb","Ask about your stats, or describe a dashboard change…") ?? "Ask about your stats, or describe a dashboard change…")}" ${String(state.chat.sending ? 'disabled' : '')}></textarea>
            <button class="st-btn primary icon" data-c="send" ${String(state.chat.sending ? 'disabled' : '')}><i class="fas fa-paper-plane"></i></button>
          </div>`;
      const menuItem = (action, icon, label, enabled) =>
        `<button class="st-menu-item ${enabled ? '' : 'disabled'}" data-c="${action}" ${enabled ? '' : `title="Start a conversation first"`}><i class="fas ${icon}"></i>${label}</button>`;
      chat.innerHTML = `
        <div class="st-chat-grip" data-c="grip" title="${(globalThis.PlatformLanguage?.htmlText("stats","m_262ffc4610efbc","Drag to resize") ?? "Drag to resize")}"></div>
        <div class="st-chat-head">
          <i class="fas fa-wand-magic-sparkles" style="color:var(--primary-readable, var(--primary, #175cd3));"></i>
          <span class="title">${(globalThis.PlatformLanguage?.htmlText("stats","m_f5ffc0afa0f574","Stats assistant") ?? "Stats assistant")}<span class="sub">${String(history ? 'Conversation history' : focusTitle ? `Focused on “${esc(focusTitle)}”` : 'General questions')}</span></span>
          ${String(history
            ? `<button class="st-btn icon" data-c="back" title="${(globalThis.PlatformLanguage?.htmlText("stats","m_74d08a454b2676","Back to conversation") ?? "Back to conversation")}"><i class="fas fa-arrow-left"></i></button>`
            : `<span class="st-menu">
                <button class="st-btn icon" data-c="menu" title="${(globalThis.PlatformLanguage?.htmlText("stats","m_a2d1808c7ed0ea","More options") ?? "More options")}"><i class="fas fa-ellipsis-vertical"></i></button>
                ${state.chat.menuOpen ? `<div class="st-menu-pop">
                  ${menuItem('share', 'fa-link', 'Copy share link', hasConversation)}
                  ${menuItem('export', 'fa-download', 'Export as Markdown', hasConversation)}
                  ${menuItem('history', 'fa-clock-rotate-left', 'Past conversations', true)}
                </div>` : ''}
              </span>
              <button class="st-btn icon" data-c="new" title="${(globalThis.PlatformLanguage?.htmlText("stats","m_84e4d3109d655d","New conversation") ?? "New conversation")}"><i class="fas fa-plus"></i></button>`)}
          <button class="st-btn icon" data-c="close" title="${(globalThis.PlatformLanguage?.htmlText("stats","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-xmark"></i></button>
        </div>
        ${String(body)}`;
      const msgs = chat.querySelector('[data-c="msgs"]');
      if (msgs && !history) msgs.scrollTop = msgs.scrollHeight;
      const grip = chat.querySelector('[data-c="grip"]');
      grip?.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = chat.getBoundingClientRect().width;
        chat.classList.add('st-resizing');
        grip.classList.add('dragging');
        const bodyWidth = root.querySelector('.st-body')?.getBoundingClientRect().width || 1200;
        const maxWidth = Math.min(760, Math.round(bodyWidth * 0.7));
        const move = (moveEvent) => {
          state.chatWidth = Math.round(Math.min(Math.max(startWidth + (startX - moveEvent.clientX), 360), maxWidth));
          chat.style.flexBasis = `${state.chatWidth}px`;
        };
        const up = () => {
          document.removeEventListener('pointermove', move);
          document.removeEventListener('pointerup', up);
          chat.classList.remove('st-resizing');
          grip.classList.remove('dragging');
          localStorage.setItem('fm_stats_chat_width', String(state.chatWidth));
        };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', up);
      });
      chat.querySelector('[data-c="close"]')?.addEventListener('click', () => {
        state.chatOpen = false;
        localStorage.setItem('fm_stats_chat', '0');
        renderShell();
      });
      chat.querySelector('[data-c="menu"]')?.addEventListener('click', () => {
        state.chat.menuOpen = !state.chat.menuOpen;
        renderChat();
      });
      chat.querySelector('[data-c="history"]')?.addEventListener('click', () => {
        state.chat.menuOpen = false;
        openHistory();
      });
      chat.querySelector('[data-c="back"]')?.addEventListener('click', () => {
        state.chat.mode = 'chat';
        renderChat();
      });
      chat.querySelector('[data-c="share"]')?.addEventListener('click', () => {
        if (!hasConversation) return;
        state.chat.menuOpen = false;
        renderChat();
        copyThreadLink();
      });
      chat.querySelector('[data-c="export"]')?.addEventListener('click', () => {
        if (!hasConversation) return;
        state.chat.menuOpen = false;
        renderChat();
        exportThread();
      });
      chat.querySelectorAll('[data-thread]').forEach((el) => el.addEventListener('click', () => {
        openThread(clean(el.getAttribute('data-thread')));
      }));
      chat.querySelector('[data-c="new"]')?.addEventListener('click', async () => {
        state.chat = { ...state.chat, mode: 'chat', menuOpen: false, threadId: '', messages: [welcomeMessage()], sending: false, viewId: activeView() ? activeView().id : '' };
        setThreadRoute('');
        renderChat();
      });
      const input = chat.querySelector('[data-c="input"]');
      input?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          sendMessage();
        }
      });
      chat.querySelector('[data-c="send"]')?.addEventListener('click', sendMessage);
      if (!state.chat.sending) input?.focus();
    }

    async function sendMessage(){
      const chat = root.querySelector('[data-st="chat"]');
      const input = chat?.querySelector('[data-c="input"]');
      const value = clean(input?.value);
      if (!value || state.chat.sending) return;
      let failedText = '';
      state.chat.sending = true;
      state.chat.messages = [...state.chat.messages, { role: 'user', content: value, data: {} }];
      renderChat();
      try {
        if (!state.chat.threadId) {
          const view = activeView();
          const created = await api.agent.createThread(state.orgId, { view_id: view ? view.id : '', branch_id: state.branchId });
          state.chat.threadId = clean(object(created.thread).id);
          setThreadRoute(state.chat.threadId);
        }
        const result = await api.agent.send(state.orgId, state.chat.threadId,
          { message: value, branch_id: state.branchId },
          { signal: AbortSignal.timeout(AGENT_TIMEOUT_MS) });
        const assistant = object(result.assistant_message);
        state.chat.messages = [...state.chat.messages, {
          role: 'assistant',
          content: String(assistant.content || (clean(result.status) === 'failed' ? "I couldn't finish that." : 'Done.')),
          data: { ...object(assistant.data), status: clean(result.status), changes: array(result.changes), renders: array(result.renders), reverted_views: array(result.reverted_views) }
        }];
        if (array(result.changes).length || array(result.reverted_views).length) {
          await loadViews();
          renderShell();
          await loadWidgetData();
        }
      } catch (error) {
        const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        const offline = error && (error.name === 'TypeError' || /failed to fetch|networkerror|load failed/i.test(clean(error.message)));
        state.chat.messages = [...state.chat.messages, {
          role: 'assistant',
          content: timedOut
            ? 'That took longer than expected — the change may still be applying. Give it a moment and refresh.'
            : offline
              ? "I couldn't reach the server just now — it may be restarting. Your question is still in the box below; try again in a few seconds."
              : (clean(error && error.message) || 'Something went wrong talking to the stats assistant.'),
          data: { status: 'failed' }
        }];
        if (offline) failedText = value;
      } finally {
        state.chat.sending = false;
        renderChat();
        if (failedText) {
          const retryInput = root.querySelector('[data-st="chat"] [data-c="input"]');
          if (retryInput) retryInput.value = failedText;
        }
      }
    }

    // ── Boot / lifecycle ───────────────────────────────────────────────────

    const refreshEvents = ['fm:projects:refresh', 'fm:money:updated', 'fm:work:updated'];
    let refreshTimer = null;
    const onExternalRefresh = () => {
      if (state.destroyed || !state.active) return;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => loadWidgetData(), 1200);
    };
    refreshEvents.forEach((name) => window.addEventListener(name, onExternalRefresh));

    const onDocumentClick = (event) => {
      if (!state.chat.menuOpen) return;
      if (event.target && typeof event.target.closest === 'function' && event.target.closest('.st-menu')) return;
      state.chat.menuOpen = false;
      renderChat();
    };
    document.addEventListener('click', onDocumentClick);

    state.active = true;
    reloadAll().then(() => {
      if (state.pendingThreadId) {
        // Shared conversation link: open the drawer straight to that thread.
        state.chatOpen = true;
        localStorage.setItem('fm_stats_chat', '1');
        renderShell();
        openThread(state.pendingThreadId);
        state.pendingThreadId = '';
      } else if (state.chatOpen) {
        ensureChatThread();
      }
    });

    return {
      destroy(){
        state.destroyed = true;
        if (state.syncPollTimer) clearTimeout(state.syncPollTimer);
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshEvents.forEach((name) => window.removeEventListener(name, onExternalRefresh));
        document.removeEventListener('click', onDocumentClick);
        closeModal();
        root.innerHTML = '';
      },
      setActive(active){
        state.active = active !== false;
      },
      update(nextContext){
        if (clean(nextContext?.orgId) && clean(nextContext.orgId) !== state.orgId) {
          state.orgId = clean(nextContext.orgId);
          state.activeViewId = '';
          reloadAll();
        }
      },
      refresh(){ return loadWidgetData(); }
    };
  }

  runtime.registerApp({
    id: 'portal.stats',
    package: 'stats',
    kind: 'portal_tab',
    title: (globalThis.PlatformLanguage?.text("stats","m_bd451534def6c4","Stats") ?? "Stats"),
    terminologyKey: 'stats.portal_tab',
    icon: 'fa-chart-column',
    order: 53,
    surfaces: ['portal_tab'],
    regions: ['main'],
    visible: true,
    fullBleed: true,
    access: {
      applicationsAny: ['management'],
      permissionsAny: ['view_projects', 'manage_projects', 'manage_company_settings']
    },
    mount: createApp
  });
})();
