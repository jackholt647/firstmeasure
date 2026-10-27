/* libraries/pdf-viewer/firstmate-pdf-viewer.js
 * FirstMate's own PDF document viewer (window.FirstMatePdf). Continuous pages on a calm
 * canvas, one floating toolbar, thumbnails, zoom, selectable text and per-page markup drawn
 * with FirstMateMarkup.PhotoMarkup. It fills the host element and draws nothing outside it.
 * Contract, behaviour and limits: docs/architecture/pdf-viewer.md.
 */
(function(){
  'use strict';
  const root = window;
  const VERSION = '20261027-1';
  const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/';
  const SCRIPT_SRC = (document.currentScript && document.currentScript.src) || '';
  const config = {
    pdfjsSrc: `${CDN}pdf.js/3.11.174/pdf.min.js`,
    pdfjsWorkerSrc: `${CDN}pdf.js/3.11.174/pdf.worker.min.js`,
    pdfLibSrc: `${CDN}pdf-lib/1.17.1/pdf-lib.min.js`,
    markupSrc: (() => {
      try { return SCRIPT_SRC ? new URL('../markup/firstmate-markup.js', SCRIPT_SRC).href : '/libraries/markup/firstmate-markup.js'; }
      catch (_) { return '/libraries/markup/firstmate-markup.js'; }
    })()
  };

  const CSS_UNITS = 96 / 72;            // 100% zoom shows a PDF point as 1/72 inch on a 96 dpi screen
  const MIN_ZOOM = 0.25;
  const MAX_ZOOM = 5;
  const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
  const ZOOM_MENU = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
  const PHONE_MAX = 560;
  const COMPACT_MAX = 700;
  const WIDE_MIN = 900;
  const THUMB_WIDTH = 92;
  // Markup text keeps pixel sizes (fontPx…). They are stored relative to a page 1000 px wide
  // and scaled to the page's width on screen, so text keeps its size relative to the page at any zoom.
  const MARKUP_REF_WIDTH = 1000;
  const MARKUP_PX_KEYS = ['fontPx', 'naturalWidthPx', 'naturalHeightPx'];
  const isCoarse = () => !!root.matchMedia?.('(pointer: coarse)').matches;
  const reducedMotion = () => !!root.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const MAX_CANVAS_PIXELS = isCoarse() ? 5242880 : 8388608;

  function L(key, fallback, vars){
    let text = fallback;
    try {
      const out = root.PlatformLanguage?.text?.('pdf-viewer', key, fallback, vars);
      if (typeof out === 'string' && out) text = out;
    } catch (_) {}
    return vars ? String(text).replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match)) : text;
  }
  function esc(value){
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const clampZoom = (value) => clamp(Number(value) || 1, MIN_ZOOM, MAX_ZOOM);
  const cloneItems = (items) => JSON.parse(JSON.stringify(Array.isArray(items) ? items : []));
  function normalizeZoom(value){
    if (value === 'fit-width' || value === 'fit-page') return value;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? clampZoom(n) : 'fit-width';
  }
  function normalizeHex(value){
    const v = String(value ?? '').trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(v)) return v;
    if (/^#[0-9a-f]{3}$/.test(v)) return `#${v.slice(1).split('').map((c) => c + c).join('')}`;
    return '';
  }
  function scaleMarkupItems(items, factor){
    if (!Array.isArray(items) || !Number.isFinite(factor) || factor <= 0 || factor === 1) return items;
    items.forEach((item) => {
      if (!item || item.type !== 'text') return;
      MARKUP_PX_KEYS.forEach((key) => {
        const v = Number(item[key]);
        if (item[key] != null && Number.isFinite(v)) item[key] = v * factor;
      });
    });
    return items;
  }
  function codedError(code, message, cause){
    const error = new Error(message);
    error.name = 'FirstMatePdfError';
    error.code = code;
    if (cause) error.cause = cause;
    return error;
  }
  function classifyError(error){
    if (error && error.name === 'FirstMatePdfError') return error;
    const name = String(error?.name || '');
    if (name === 'PasswordException') return codedError('password', L('pdfv_err_password', 'This PDF is password protected, so it can’t be shown here.'), error);
    if (name === 'InvalidPDFException' || name === 'FormatError') return codedError('invalid', L('pdfv_err_invalid', 'This file isn’t a valid PDF, or it is damaged.'), error);
    if (name === 'MissingPDFException') return codedError('missing', L('pdfv_err_missing', 'The PDF could not be found.'), error);
    if (name === 'UnexpectedResponseException') return codedError('network', L('pdfv_err_network', 'The PDF could not be downloaded. Check your connection and try again.'), error);
    return codedError('unknown', L('pdfv_err_unknown', 'Something went wrong while opening this PDF.'), error);
  }

  // ---- Script loading ----
  const scriptPromises = Object.create(null);
  function loadScript(src, globalName){
    if (globalName && root[globalName]) return Promise.resolve(root[globalName]);
    if (scriptPromises[src]) return scriptPromises[src];
    scriptPromises[src] = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = () => {
        if (!globalName || root[globalName]) resolve(root[globalName]);
        else { delete scriptPromises[src]; reject(codedError('library', L('pdfv_err_library', 'The PDF viewer could not load. Check your connection and try again.'))); }
      };
      script.onerror = () => {
        delete scriptPromises[src];
        script.remove();
        reject(codedError('library', L('pdfv_err_library', 'The PDF viewer could not load. Check your connection and try again.')));
      };
      document.head.appendChild(script);
    });
    return scriptPromises[src];
  }
  let pdfjsPromise = null;
  function loadPdfjs(){
    if (!pdfjsPromise) {
      pdfjsPromise = (async () => {
        let lib = root.pdfjsLib || root['pdfjs-dist/build/pdf'];
        if (!lib) lib = await loadScript(config.pdfjsSrc, 'pdfjsLib');
        if (!lib?.getDocument) throw codedError('library', L('pdfv_err_library', 'The PDF viewer could not load. Check your connection and try again.'));
        if (lib.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc && !lib.GlobalWorkerOptions.workerPort) {
          lib.GlobalWorkerOptions.workerSrc = config.pdfjsWorkerSrc;
        }
        return lib;
      })().catch((error) => { pdfjsPromise = null; throw error; });
    }
    return pdfjsPromise;
  }
  function loadMarkupLib(){
    if (root.FirstMateMarkup?.PhotoMarkup) return Promise.resolve(root.FirstMateMarkup);
    return loadScript(config.markupSrc, 'FirstMateMarkup');
  }
  function saveBlob(blob, fileName){
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // ---- Markup rasterising for download (ported from renderPhotoWithMarkupBlob in firstmate-markup.js) ----
  function arrowParts(item){
    const x1 = Number(item.x1 || 0), y1 = Number(item.y1 || 0), x2 = Number(item.x2 || 0), y2 = Number(item.y2 || 0);
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const len = 0.035;
    const a = Math.PI / 7;
    return {
      shaft: { x1, y1, x2, y2 },
      left: { x1: x2, y1: y2, x2: x2 - Math.cos(angle - a) * len, y2: y2 - Math.sin(angle - a) * len },
      right: { x1: x2, y1: y2, x2: x2 - Math.cos(angle + a) * len, y2: y2 - Math.sin(angle + a) * len }
    };
  }
  function wrapLines(ctx, text, maxWidth){
    const out = [];
    String(text || '').replace(/\r/g, '').replace(/ /g, ' ').split('\n').forEach((line) => {
      let current = '';
      line.split(/\s+/).forEach((word) => {
        const test = current ? `${current} ${word}` : word;
        if (current && ctx.measureText(test).width > maxWidth) { out.push(current); current = word; }
        else current = test;
      });
      out.push(current);
    });
    return out.length ? out : [''];
  }
  async function markupPng(items, width, height){
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const strokeScale = Math.max(1, Math.sqrt(W * H) / 100);
    (Array.isArray(items) ? items : []).forEach((item) => {
      if (!item) return;
      ctx.save();
      ctx.strokeStyle = item.color || '#111';
      ctx.fillStyle = item.color || '#111';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (item.type === 'stroke') {
        const points = Array.isArray(item.points) ? item.points : [];
        ctx.lineWidth = Math.max(1, Number(item.size || 2.2) * strokeScale);
        if (points.length === 1) {
          ctx.beginPath();
          ctx.arc(Number(points[0].x || 0) * W, Number(points[0].y || 0) * H, ctx.lineWidth / 2, 0, Math.PI * 2);
          ctx.fill();
        } else if (points.length > 1) {
          ctx.beginPath();
          points.forEach((point, index) => {
            const x = Number(point.x || 0) * W;
            const y = Number(point.y || 0) * H;
            if (index) ctx.lineTo(x, y); else ctx.moveTo(x, y);
          });
          ctx.stroke();
        }
      } else if (item.type === 'arrow') {
        ctx.lineWidth = Math.max(1, Number(item.size || 2.8) * strokeScale);
        Object.values(arrowParts(item)).forEach((part) => {
          ctx.beginPath();
          ctx.moveTo(part.x1 * W, part.y1 * H);
          ctx.lineTo(part.x2 * W, part.y2 * H);
          ctx.stroke();
        });
      } else if (item.type === 'text' && String(item.text || '').trim()) {
        const x = Number(item.x || 0) * W;
        const y = Number(item.y || 0) * H;
        const width = Number(item.width || 0.24) * W;
        const height = Number(item.height || 0.07) * H;
        // The box on screen is lines × 1.2 em plus 0.7 em of padding; solve for the font size,
        // then again with the wrapped line count so the text fills the box as it did on screen.
        let lines = String(item.text || '').split('\n').length || 1;
        let fontSize = Math.max(6, height / (lines * 1.2 + 0.7));
        let wrapped = [];
        for (let i = 0; i < 3; i += 1) {
          ctx.font = `700 ${fontSize}px Arial, sans-serif`;
          wrapped = wrapLines(ctx, item.text, Math.max(10, width - fontSize * 0.9));
          if (wrapped.length <= lines) break;
          lines = wrapped.length;
          fontSize = Math.max(6, height / (lines * 1.2 + 0.7));
        }
        const radius = Math.min(8 * (W / MARKUP_REF_WIDTH), height / 2, width / 2);
        ctx.fillStyle = 'rgba(255,255,255,.72)';
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, y, width, height, radius); else ctx.rect(x, y, width, height);
        ctx.fill();
        ctx.fillStyle = item.color || '#111';
        ctx.textBaseline = 'top';
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, width, height);
        ctx.clip();
        wrapped.forEach((line, index) => ctx.fillText(line || ' ', x + fontSize * 0.45, y + fontSize * 0.35 + index * fontSize * 1.2));
        ctx.restore();
      }
      ctx.restore();
    });
    const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not draw markup.'))), 'image/png'));
    canvas.width = canvas.height = 0;
    return new Uint8Array(await blob.arrayBuffer());
  }

  // ---- Styles ----
  const CSS = `
.fm-pdf{--fm-pdf-accent:var(--primary,#16a34a);--fm-pdf-on-accent:var(--on-primary,#fff);--fm-pdf-tint:rgba(22,163,74,.12);--fm-pdf-tint:color-mix(in srgb,var(--fm-pdf-accent) 13%,transparent);--fm-pdf-ring:rgba(22,163,74,.28);--fm-pdf-ring:color-mix(in srgb,var(--fm-pdf-accent) 32%,transparent);--fm-pdf-bg:#eef0f3;--fm-pdf-ink:#101828;--fm-pdf-body:#344054;--fm-pdf-icon:#475467;--fm-pdf-muted:#667085;--fm-pdf-line:rgba(15,23,42,.08);--fm-pdf-glass:rgba(255,255,255,.86);--fm-pdf-shadow:0 14px 36px -10px rgba(15,23,42,.26),0 2px 6px rgba(15,23,42,.06);--fm-pdf-rail:132px;--fm-pdf-ease:cubic-bezier(.22,1,.36,1);
  position:absolute;inset:0;overflow:hidden;background:var(--fm-pdf-bg);color:var(--fm-pdf-ink);font-family:inherit;font-size:13px;line-height:1.25;text-align:left;-webkit-tap-highlight-color:transparent;contain:layout paint;isolation:isolate;outline:none}
.fm-pdf *,.fm-pdf *::before,.fm-pdf *::after{box-sizing:border-box}
.fm-pdf button{font-family:inherit;-webkit-appearance:none;appearance:none;margin:0}
.fm-pdf-stage{position:absolute;top:0;right:0;bottom:0;left:0;transition:left .3s var(--fm-pdf-ease)}
.fm-pdf.is-ready.rail-docked.rail-open .fm-pdf-stage{left:var(--fm-pdf-rail)}
.fm-pdf.is-instant .fm-pdf-stage,.fm-pdf.is-instant .fm-pdf-rail{transition:none!important}
.fm-pdf-scroll{position:absolute;inset:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;outline:none;touch-action:pan-x pan-y;-webkit-overflow-scrolling:touch;scrollbar-width:thin;scrollbar-color:rgba(15,23,42,.22) transparent}
.fm-pdf-scroll::-webkit-scrollbar{width:11px;height:11px}
.fm-pdf-scroll::-webkit-scrollbar-track{background:transparent}
.fm-pdf-scroll::-webkit-scrollbar-thumb{background:rgba(15,23,42,.18);border-radius:999px;border:3px solid transparent;background-clip:padding-box}
.fm-pdf-scroll:hover::-webkit-scrollbar-thumb{background-color:rgba(15,23,42,.3)}
.fm-pdf-pages{position:relative;display:flex;flex-direction:column;align-items:center;gap:16px;width:max-content;min-width:100%;padding:calc(24px + var(--fm-pdf-inset-top,0px)) 24px 104px;transform-origin:0 0}
.fm-pdf.is-phone .fm-pdf-pages{gap:10px;padding:calc(10px + var(--fm-pdf-inset-top,0px)) 8px 88px}
.fm-pdf.is-pinching .fm-pdf-pages{will-change:transform}
.fm-pdf-page{position:relative;flex:none;background:#fff;border-radius:4px;overflow:hidden;box-shadow:0 0 0 1px rgba(15,23,42,.05),0 1px 2px rgba(16,24,40,.06),0 12px 30px -8px rgba(16,24,40,.16)}
.fm-pdf-page::before{content:'';position:absolute;inset:0;background:linear-gradient(100deg,rgba(241,243,247,0) 30%,#f1f3f7 50%,rgba(241,243,247,0) 70%) 0 0/300% 100% no-repeat;animation:fm-pdf-shimmer 1.5s ease-in-out infinite;transition:opacity .3s ease}
.fm-pdf-page.is-rendered::before{opacity:0;animation:none}
.fm-pdf-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;opacity:0;transition:opacity .3s ease}
.fm-pdf-canvas.is-shown{opacity:1}
.fm-pdf.is-pinching .fm-pdf-canvas{transition:none}
.fm-pdf .textLayer{position:absolute;left:0;top:0;z-index:2;overflow:hidden;line-height:1;text-align:initial;-webkit-text-size-adjust:none;text-size-adjust:none;forced-color-adjust:none;transform-origin:0 0;caret-color:CanvasText}
.fm-pdf .textLayer :is(span,br){color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0% 0%}
.fm-pdf .textLayer span.markedContent{top:0;height:0}
.fm-pdf .textLayer ::selection{background:rgba(37,99,235,.26)}
.fm-pdf .textLayer br::selection{background:transparent}
.fm-pdf .textLayer[data-main-rotation="90"]{transform:rotate(90deg) translateY(-100%)}
.fm-pdf .textLayer[data-main-rotation="180"]{transform:rotate(180deg) translate(-100%,-100%)}
.fm-pdf .textLayer[data-main-rotation="270"]{transform:rotate(270deg) translateX(-100%)}
.fm-pdf-markup{position:absolute;inset:0;z-index:3;pointer-events:none}
.fm-pdf-markup>.r-proposal-markupdock{display:none!important}
.fm-pdf .fm-photo-markup-layer{position:absolute;inset:0;z-index:1;pointer-events:none}
.fm-pdf.markup-on .fm-photo-markup-layer{pointer-events:auto;cursor:crosshair;touch-action:none}
.fm-pdf.markup-on.tool-text .fm-photo-markup-layer{cursor:text}
.fm-pdf.markup-on.tool-eraser .fm-photo-markup-layer{cursor:cell}
.fm-pdf .fm-photo-markup-layer svg{position:absolute;inset:0;width:100%;height:100%;overflow:hidden}
.fm-pdf .fm-photo-markup-path{fill:none;stroke:#111;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
.fm-pdf .fm-photo-markup-arrow{fill:none;stroke-linecap:round}
.fm-pdf .fm-photo-markup-text{position:absolute;min-width:40px;min-height:20px;padding:6px 8px;border-radius:8px;background:rgba(255,255,255,.72);color:#111;font-weight:700;line-height:1.2;white-space:pre-wrap;overflow:hidden;overflow-wrap:anywhere;word-break:normal;box-shadow:0 4px 14px rgba(15,23,42,.08);outline:0;cursor:text}
.fm-pdf .fm-photo-markup-text:focus{box-shadow:0 0 0 3px var(--fm-pdf-ring),0 4px 14px rgba(15,23,42,.08)}
.fm-pdf .fm-photo-markup-handle,.fm-pdf .fm-photo-markup-text-size{position:absolute;width:21px;height:21px;background:#fff;border:2px solid var(--fm-pdf-accent);box-shadow:0 5px 12px rgba(15,23,42,.16);display:none;z-index:2;opacity:.55;transition:opacity .14s ease}
.fm-pdf .fm-photo-markup-handle{border-radius:999px;transform:translate(-50%,-50%);cursor:grab}
.fm-pdf .fm-photo-markup-text-size{border-radius:5px;cursor:nwse-resize}
.fm-pdf .fm-photo-markup-handle:hover,.fm-pdf .fm-photo-markup-text-size:hover{opacity:1}
.fm-pdf .fm-photo-markup-text-delete{position:absolute;z-index:3;width:21px;height:21px;padding:0;border-radius:999px;border:1px solid rgba(15,23,42,.14);background:#fff;color:var(--fm-pdf-icon);font:700 15px/19px Arial,sans-serif;text-align:center;cursor:pointer;box-shadow:0 4px 10px rgba(15,23,42,.14);display:none}
.fm-pdf .fm-photo-markup-text-delete:hover{color:#d92d20;border-color:#fda29b}
.fm-pdf.markup-on .fm-photo-markup-handle,.fm-pdf.markup-on .fm-photo-markup-text-size,.fm-pdf.markup-on .fm-photo-markup-text-delete{display:block}

.fm-pdf-toolbar{position:absolute;left:50%;bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:5;display:flex;align-items:center;gap:2px;padding:4px;border-radius:999px;background:var(--fm-pdf-glass);border:1px solid var(--fm-pdf-line);box-shadow:var(--fm-pdf-shadow);-webkit-backdrop-filter:blur(18px) saturate(1.6);backdrop-filter:blur(18px) saturate(1.6);white-space:nowrap;transform:translateX(-50%);transition:opacity .24s ease,transform .34s var(--fm-pdf-ease)}
.fm-pdf.is-loading .fm-pdf-toolbar,.fm-pdf.is-error .fm-pdf-toolbar{opacity:0;transform:translate(-50%,18px);pointer-events:none}
.fm-pdf.chrome-hidden:not(.markup-on) .fm-pdf-toolbar{opacity:0;transform:translate(-50%,16px);pointer-events:none}
.fm-pdf-btn{position:relative;width:38px;height:38px;flex:none;border:0;border-radius:999px;background:transparent;color:var(--fm-pdf-icon);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-size:14px;transition:background .16s ease,color .16s ease,transform .16s ease,opacity .16s ease}
.fm-pdf-btn:hover{background:rgba(15,23,42,.06);color:var(--fm-pdf-ink)}
.fm-pdf-btn:active{transform:scale(.9)}
.fm-pdf-btn:disabled{opacity:.32;cursor:default;background:transparent;transform:none}
.fm-pdf-btn.is-on{background:var(--fm-pdf-tint);color:var(--fm-pdf-accent)}
.fm-pdf-btn:focus-visible,.fm-pdf-zoomlabel:focus-visible,.fm-pdf-mtool:focus-visible,.fm-pdf-mtoggle:focus-visible,.fm-pdf-thumb:focus-visible .fm-pdf-thumb-card,.fm-pdf-menu button:focus-visible{outline:2px solid var(--fm-pdf-accent);outline-offset:1px}
.fm-pdf-sep{width:1px;height:20px;flex:none;background:rgba(15,23,42,.1);margin:0 4px}
.fm-pdf-pagebox{display:inline-flex;align-items:center;gap:6px;padding:0 4px;font-variant-numeric:tabular-nums;color:var(--fm-pdf-muted);font-weight:600;font-size:13px}
.fm-pdf-pageinput{height:30px;width:4ch;min-width:36px;border:1px solid rgba(15,23,42,.12);border-radius:9px;background:#fff;color:var(--fm-pdf-ink);font:inherit;font-weight:700;text-align:center;padding:0 4px;outline:none;transition:border-color .16s ease,box-shadow .16s ease;-moz-appearance:textfield}
.fm-pdf-pageinput:hover{border-color:rgba(15,23,42,.2)}
.fm-pdf-pageinput:focus{border-color:var(--fm-pdf-accent);box-shadow:0 0 0 3px var(--fm-pdf-ring)}
.fm-pdf-pagetotal{white-space:nowrap}
.fm-pdf-zoomlabel{min-width:58px;height:32px;padding:0 8px;border:0;border-radius:999px;background:transparent;color:var(--fm-pdf-body);font-size:13px;font-weight:700;font-variant-numeric:tabular-nums;cursor:pointer;transition:background .16s ease}
.fm-pdf-zoomlabel:hover,.fm-pdf-zoomlabel[aria-expanded="true"]{background:rgba(15,23,42,.06)}
.fm-pdf-menu{position:absolute;bottom:calc(100% + 10px);left:50%;min-width:176px;padding:6px;border-radius:16px;background:rgba(255,255,255,.97);border:1px solid var(--fm-pdf-line);box-shadow:var(--fm-pdf-shadow);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);transform:translate(-50%,8px) scale(.96);transform-origin:50% 100%;opacity:0;pointer-events:none;transition:opacity .18s ease,transform .24s var(--fm-pdf-ease)}
.fm-pdf-menu.is-open{opacity:1;transform:translate(-50%,0) scale(1);pointer-events:auto}
.fm-pdf-menu button{width:100%;display:flex;align-items:center;gap:10px;height:34px;padding:0 10px;border:0;border-radius:10px;background:transparent;color:var(--fm-pdf-body);font-size:13px;font-weight:600;cursor:pointer;text-align:left;font-variant-numeric:tabular-nums}
.fm-pdf-menu button:hover{background:rgba(15,23,42,.05);color:var(--fm-pdf-ink)}
.fm-pdf-menu button>i:first-child{width:16px;text-align:center;color:var(--fm-pdf-muted);font-size:12px}
.fm-pdf-menu button span{flex:1}
.fm-pdf-menu .fm-pdf-check{color:var(--fm-pdf-accent);font-size:12px;opacity:0}
.fm-pdf-menu button[aria-checked="true"]{color:var(--fm-pdf-ink)}
.fm-pdf-menu button[aria-checked="true"] .fm-pdf-check{opacity:1}
.fm-pdf-menu-sep{height:1px;margin:5px 6px;background:rgba(15,23,42,.08)}
.fm-pdf.is-compact [data-act="fit"],.fm-pdf.is-compact [data-sep="fit"]{display:none}
.fm-pdf.is-phone .fm-pdf-toolbar .zoom-only,.fm-pdf.is-phone [data-act="prev"],.fm-pdf.is-phone [data-act="next"]{display:none}
.fm-pdf.is-phone .fm-pdf-toolbar{bottom:calc(12px + env(safe-area-inset-bottom,0px));padding:5px 6px}
.fm-pdf.is-phone .fm-pdf-pagebox{padding:0 6px}
.fm-pdf:not(.has-rail) [data-act="thumbs"],.fm-pdf:not(.has-rail) [data-sep="thumbs"]{display:none}

.fm-pdf-rail{position:absolute;left:0;top:0;bottom:0;width:var(--fm-pdf-rail);z-index:4;background:#f7f8fa;border-right:1px solid rgba(15,23,42,.07);transform:translateX(-101%);transition:transform .3s var(--fm-pdf-ease),box-shadow .3s ease;visibility:hidden}
.fm-pdf.is-ready.rail-open .fm-pdf-rail{transform:none;visibility:visible}
.fm-pdf.is-ready .fm-pdf-rail{transition:transform .3s var(--fm-pdf-ease),box-shadow .3s ease,visibility 0s linear .3s}
.fm-pdf.is-ready.rail-open .fm-pdf-rail{transition:transform .3s var(--fm-pdf-ease),box-shadow .3s ease}
.fm-pdf.is-ready:not(.rail-docked).rail-open .fm-pdf-rail{box-shadow:16px 0 44px -14px rgba(15,23,42,.32)}
.fm-pdf-rail-list{position:absolute;inset:0;overflow-y:auto;overflow-x:hidden;padding:18px 0 104px;display:flex;flex-direction:column;align-items:center;gap:14px;scrollbar-width:thin;scrollbar-color:rgba(15,23,42,.16) transparent;overscroll-behavior:contain}
.fm-pdf-rail-list::-webkit-scrollbar{width:8px}
.fm-pdf-rail-list::-webkit-scrollbar-thumb{background:rgba(15,23,42,.14);border-radius:999px;border:2px solid transparent;background-clip:padding-box}
.fm-pdf-thumb{flex:none;display:flex;flex-direction:column;align-items:center;gap:7px;border:0;background:none;padding:0;cursor:pointer;color:var(--fm-pdf-muted);font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;outline:none}
.fm-pdf-thumb-card{position:relative;display:block;width:${THUMB_WIDTH}px;background:#fff;border-radius:3px;overflow:hidden;box-shadow:0 0 0 1px rgba(15,23,42,.08),0 2px 6px rgba(16,24,40,.07);transition:box-shadow .2s ease,transform .2s var(--fm-pdf-ease)}
.fm-pdf-thumb-card canvas{position:absolute;inset:0;width:100%;height:100%;display:block;opacity:0;transition:opacity .3s ease}
.fm-pdf-thumb.is-drawn .fm-pdf-thumb-card canvas{opacity:1}
.fm-pdf-thumb:hover .fm-pdf-thumb-card{transform:translateY(-2px);box-shadow:0 0 0 1px rgba(15,23,42,.1),0 8px 18px -6px rgba(16,24,40,.2)}
.fm-pdf-thumb.is-current .fm-pdf-thumb-card{box-shadow:0 0 0 2px var(--fm-pdf-accent),0 8px 20px -8px var(--fm-pdf-ring)}
.fm-pdf-thumb-num{min-width:24px;padding:2px 7px;border-radius:999px;text-align:center;transition:background .2s ease,color .2s ease}
.fm-pdf-thumb.is-current .fm-pdf-thumb-num{background:var(--fm-pdf-accent);color:var(--fm-pdf-on-accent)}
.fm-pdf-scrim{position:absolute;inset:0;z-index:3;background:rgba(15,23,42,.16);opacity:0;pointer-events:none;transition:opacity .26s ease}
.fm-pdf.is-ready:not(.rail-docked).rail-open .fm-pdf-scrim{opacity:1;pointer-events:auto}

.fm-pdf-mdock{position:absolute;right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:6;display:flex;flex-direction:column;align-items:center;gap:10px;transition:opacity .24s ease,transform .34s var(--fm-pdf-ease)}
.fm-pdf-mdock[hidden]{display:none}
.fm-pdf.is-loading .fm-pdf-mdock,.fm-pdf.is-error .fm-pdf-mdock{opacity:0;transform:translateY(18px);pointer-events:none}
.fm-pdf.chrome-hidden:not(.markup-on) .fm-pdf-mdock{opacity:0;transform:translateY(16px);pointer-events:none}
.fm-pdf.is-phone .fm-pdf-mdock{right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px))}
.fm-pdf-mtoggle{width:46px;height:46px;flex:none;border-radius:999px;border:1px solid var(--fm-pdf-line);background:var(--fm-pdf-glass);-webkit-backdrop-filter:blur(18px) saturate(1.6);backdrop-filter:blur(18px) saturate(1.6);color:var(--fm-pdf-icon);box-shadow:var(--fm-pdf-shadow);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .2s ease,color .2s ease,border-color .2s ease,transform .2s var(--fm-pdf-ease),box-shadow .2s ease}
.fm-pdf-mtoggle:hover{color:var(--fm-pdf-ink);transform:translateY(-1px)}
.fm-pdf-mtoggle:active{transform:scale(.92)}
.fm-pdf.markup-on .fm-pdf-mtoggle{background:var(--fm-pdf-accent);border-color:var(--fm-pdf-accent);color:var(--fm-pdf-on-accent);box-shadow:0 12px 28px -10px var(--fm-pdf-accent),0 2px 6px rgba(15,23,42,.08)}
.fm-pdf-mtools{display:flex;flex-direction:column;align-items:center;gap:3px;padding:5px;border-radius:999px;background:var(--fm-pdf-glass);border:1px solid var(--fm-pdf-line);box-shadow:var(--fm-pdf-shadow);-webkit-backdrop-filter:blur(18px) saturate(1.6);backdrop-filter:blur(18px) saturate(1.6);opacity:0;visibility:hidden;transform:translateY(14px) scale(.94);transform-origin:50% 100%;pointer-events:none;transition:opacity .2s ease,transform .3s var(--fm-pdf-ease),visibility 0s linear .3s}
.fm-pdf.markup-on .fm-pdf-mtools{opacity:1;visibility:visible;transform:none;pointer-events:auto;transition:opacity .2s ease,transform .3s var(--fm-pdf-ease)}
.fm-pdf.markup-on .fm-pdf-mtools>*{animation:fm-pdf-pop .32s var(--fm-pdf-ease) backwards;animation-delay:calc(var(--i,0) * 16ms)}
.fm-pdf-mtool{position:relative;width:38px;height:38px;flex:none;border-radius:999px;border:0;background:transparent;color:var(--fm-pdf-icon);display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:14px;transition:background .16s ease,color .16s ease,transform .16s ease,opacity .16s ease}
.fm-pdf-mtool:hover{background:rgba(15,23,42,.06);color:var(--fm-pdf-ink)}
.fm-pdf-mtool:active{transform:scale(.9)}
.fm-pdf-mtool.is-active{background:var(--fm-pdf-accent);color:var(--fm-pdf-on-accent);box-shadow:0 6px 14px -6px var(--fm-pdf-accent)}
.fm-pdf-mtool:disabled{opacity:.3;cursor:default;background:transparent;transform:none}
.fm-pdf-msep{width:20px;height:1px;flex:none;background:rgba(15,23,42,.1);margin:3px 0}
.fm-pdf-msize{font-size:11px;font-weight:800;letter-spacing:.01em;font-variant-numeric:tabular-nums}
.fm-pdf-mswatch{width:18px;height:18px;border-radius:999px;box-shadow:0 0 0 2px #fff,0 0 0 3px rgba(15,23,42,.14)}
.fm-pdf-mwrap{position:relative;flex:none}
.fm-pdf-mpop{position:absolute;right:calc(100% + 12px);top:50%;z-index:2;padding:12px;border-radius:16px;background:rgba(255,255,255,.97);border:1px solid var(--fm-pdf-line);box-shadow:var(--fm-pdf-shadow);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);opacity:0;pointer-events:none;transform:translate(8px,-50%) scale(.96);transform-origin:100% 50%;transition:opacity .18s ease,transform .24s var(--fm-pdf-ease)}
.fm-pdf-mpop.is-open{opacity:1;pointer-events:auto;transform:translate(0,-50%) scale(1)}
.fm-pdf-mpop-size{display:flex;align-items:center;gap:12px;width:196px}
.fm-pdf-mpop-size input{flex:1;min-width:0;accent-color:var(--fm-pdf-accent);cursor:pointer}
.fm-pdf-msize-dot{flex:none;width:28px;height:28px;display:flex;align-items:center;justify-content:center}
.fm-pdf-msize-dot i{display:block;border-radius:999px;background:currentColor}
.fm-pdf .r-proposal-markup-colorbox,.fm-pdf .r-proposal-markup-recent{display:grid;grid-template-columns:repeat(6,28px);gap:8px}
.fm-pdf .r-proposal-markup-recent{margin-bottom:8px;min-height:28px}
.fm-pdf .r-proposal-markup-recent.empty{display:none}
.fm-pdf .r-proposal-markup-color{position:relative;display:block;width:28px;height:28px;padding:0;border-radius:999px;border:0;cursor:pointer;box-shadow:inset 0 0 0 1px rgba(15,23,42,.12);transition:transform .14s ease,box-shadow .14s ease}
.fm-pdf .r-proposal-markup-color:hover{transform:scale(1.08)}
.fm-pdf .r-proposal-markup-color.is-selected{box-shadow:0 0 0 2px #fff,0 0 0 4px var(--fm-pdf-accent)}
.fm-pdf .r-proposal-markup-color.custom{background:conic-gradient(#ff6b6b,#ffd166,#06d6a0,#118ab2,#9b5de5,#ff6b6b);overflow:hidden}
.fm-pdf .r-proposal-markup-color input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;border:0;padding:0}
.fm-pdf.is-short .fm-pdf-mtool{width:32px;height:32px;font-size:13px}
.fm-pdf.is-short .fm-pdf-mtools{gap:1px;padding:4px}

.fm-pdf-state{position:absolute;inset:0;z-index:7;display:flex;align-items:flex-start;justify-content:center;overflow:hidden;padding:calc(24px + var(--fm-pdf-inset-top,0px)) 24px 24px;background:var(--fm-pdf-bg);transition:opacity .35s ease,visibility 0s linear .35s}
.fm-pdf.is-phone .fm-pdf-state{padding:calc(10px + var(--fm-pdf-inset-top,0px)) 8px 8px}
.fm-pdf.is-ready .fm-pdf-state{opacity:0;visibility:hidden;pointer-events:none}
.fm-pdf.is-error .fm-pdf-state{align-items:center}
.fm-pdf-skel{display:flex;flex-direction:column;align-items:center;gap:16px;width:100%}
.fm-pdf-skel-page{width:min(100%,680px);aspect-ratio:8.5/11;flex:none;background:#fff;border-radius:4px;padding:9% 9%;display:flex;flex-direction:column;gap:14px;box-shadow:0 0 0 1px rgba(15,23,42,.05),0 12px 30px -8px rgba(16,24,40,.16);animation:fm-pdf-rise .4s var(--fm-pdf-ease) both}
.fm-pdf-skel-page+.fm-pdf-skel-page{animation-delay:.08s}
.fm-pdf-skel-page i{display:block;height:11px;border-radius:6px;background:linear-gradient(90deg,#eef1f5 25%,#f8f9fb 50%,#eef1f5 75%) 0 0/300% 100%;animation:fm-pdf-shimmer 1.4s ease-in-out infinite}
.fm-pdf-skel-page i:nth-child(1){height:22px;width:46%;margin-bottom:14px}
.fm-pdf-skel-page i:nth-child(2){width:92%}.fm-pdf-skel-page i:nth-child(3){width:86%}.fm-pdf-skel-page i:nth-child(4){width:64%;margin-bottom:12px}
.fm-pdf-skel-page i:nth-child(5){height:110px;width:100%;border-radius:10px;margin-bottom:12px}
.fm-pdf-skel-page i:nth-child(6){width:88%}.fm-pdf-skel-page i:nth-child(7){width:94%}.fm-pdf-skel-page i:nth-child(8){width:58%}
.fm-pdf-error{max-width:380px;margin:auto;text-align:center;background:#fff;border-radius:20px;padding:30px 28px 26px;border:1px solid var(--fm-pdf-line);box-shadow:var(--fm-pdf-shadow);animation:fm-pdf-rise .4s var(--fm-pdf-ease) both}
.fm-pdf-error-icon{width:54px;height:54px;border-radius:999px;margin:0 auto 16px;background:#fef3f2;color:#d92d20;display:flex;align-items:center;justify-content:center;font-size:21px;box-shadow:0 0 0 8px rgba(254,243,242,.6)}
.fm-pdf-error.is-password .fm-pdf-error-icon{background:#f2f4f7;color:var(--fm-pdf-icon);box-shadow:0 0 0 8px rgba(242,244,247,.6)}
.fm-pdf-error strong{display:block;font-size:16px;font-weight:800;color:var(--fm-pdf-ink);margin-bottom:6px}
.fm-pdf-error p{margin:0;font-size:13px;color:var(--fm-pdf-muted);line-height:1.5}
.fm-pdf-error button{margin-top:18px;height:38px;padding:0 18px;border-radius:999px;border:1px solid rgba(15,23,42,.12);background:#fff;color:var(--fm-pdf-ink);font-size:13px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:8px;transition:background .16s ease,border-color .16s ease}
.fm-pdf-error button:hover{background:#f9fafb;border-color:rgba(15,23,42,.2)}
@keyframes fm-pdf-shimmer{0%{background-position:100% 0}100%{background-position:0 0}}
@keyframes fm-pdf-rise{from{opacity:0;transform:translateY(10px)}}
@keyframes fm-pdf-pop{from{opacity:0;transform:translateY(8px) scale(.86)}}
@media (prefers-reduced-motion:reduce){.fm-pdf *,.fm-pdf *::before{animation:none!important;transition:none!important}}
`;
  function ensureStyle(){
    let style = document.getElementById('fm-pdf-viewer-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'fm-pdf-viewer-style';
      document.head.appendChild(style);
    }
    if (style.textContent !== CSS) style.textContent = CSS;
  }

  const icon = (name) => `<i class="fas ${name}" aria-hidden="true"></i>`;
  function button(cls, attrs, label, inner){
    return `<button type="button" class="${cls}" ${attrs} aria-label="${esc(label)}" data-fm-tooltip="${esc(label)}">${inner}</button>`;
  }
  function zoomText(z){ return `${Math.round(z * 100)}%`; }

  class Viewer {
    constructor(host, options){
      this.host = host;
      this.o = options;
      const m = options.markup;
      this.mo = m && typeof m === 'object' && m.enabled !== false ? m : null;
      this.readOnly = !!this.mo?.readOnly;
      this.pages = [];
      this.byEl = new WeakMap();
      this.byThumb = new WeakMap();
      this.zoom = 1;
      this.zoomMode = normalizeZoom(options.zoom ?? 'fit-width');
      this.current = 0;
      this.tool = 'pen';
      this.size = 1.5;
      this.color = '#d93025';
      this.markupActive = false;
      this.markupLoaded = false;
      this.cleanups = [];
      this.renders = 0;
      this.touchIds = new Set();
      this.thumbChain = Promise.resolve();
      this.saveChain = Promise.resolve();
      this.isTouch = isCoarse();
      this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
      this.ready.catch(() => {});
      ensureStyle();
      this.build();
      this.bind();
      this.updateLayoutClasses();
      this.start();
    }

    // ---- DOM ----
    build(){
      const host = this.host;
      if (root.getComputedStyle(host).position === 'static') {
        this.hostPosition = host.style.position;
        host.style.position = 'relative';
      }
      const el = this.el = document.createElement('div');
      el.className = 'fm-pdf is-loading';
      el.setAttribute('role', 'region');
      el.setAttribute('aria-label', String(this.o.title || this.o.fileName || L('pdfv_document', 'PDF document')));
      el.style.setProperty('--fm-pdf-inset-top', `${Number(this.o.insetTop) || 0}px`);
      const t = {
        thumbs: L('pdfv_thumbnails', 'Thumbnails'),
        prev: L('pdfv_prev', 'Previous page'),
        next: L('pdfv_next', 'Next page'),
        page: L('pdfv_page_number', 'Page number'),
        zoomOut: L('pdfv_zoom_out', 'Zoom out'),
        zoomIn: L('pdfv_zoom_in', 'Zoom in'),
        zoom: L('pdfv_zoom', 'Zoom'),
        fitWidth: L('pdfv_fit_width', 'Fit width'),
        fitPage: L('pdfv_fit_page', 'Fit page'),
        toolbar: L('pdfv_toolbar', 'Document controls'),
        tools: L('pdfv_markup_tools', 'Markup tools'),
        pen: L('pdfv_pen', 'Pen'),
        arrow: L('pdfv_arrow', 'Arrow'),
        text: L('pdfv_text', 'Text'),
        size: L('pdfv_size', 'Size'),
        color: L('pdfv_color', 'Color'),
        eraser: L('pdfv_eraser', 'Eraser'),
        undo: L('pdfv_undo', 'Undo'),
        redo: L('pdfv_redo', 'Redo'),
        clear: L('pdfv_clear_page', 'Clear page'),
        markup: L('pdfv_markup', 'Mark up')
      };
      const zoomItems = ZOOM_MENU.map((z) => `<button type="button" role="menuitemradio" aria-checked="false" data-zoom="${z}"><i aria-hidden="true"></i><span>${zoomText(z)}</span>${icon('fa-check fm-pdf-check')}</button>`).join('');
      let i = 0;
      const n = () => `style="--i:${i++}"`;
      el.innerHTML = `
        <aside class="fm-pdf-rail" aria-label="${esc(L('pdfv_thumbnails_label', 'Page thumbnails'))}"><div class="fm-pdf-rail-list"></div></aside>
        <div class="fm-pdf-scrim" data-act="close-rail"></div>
        <div class="fm-pdf-stage">
          <div class="fm-pdf-scroll" tabindex="0"><div class="fm-pdf-pages"></div></div>
          <div class="fm-pdf-toolbar" role="toolbar" aria-label="${esc(t.toolbar)}">
            ${button('fm-pdf-btn', 'data-act="thumbs" aria-pressed="false"', t.thumbs, icon('fa-table-cells-large'))}
            <span class="fm-pdf-sep" data-sep="thumbs"></span>
            ${button('fm-pdf-btn', 'data-act="prev"', t.prev, icon('fa-chevron-left'))}
            <label class="fm-pdf-pagebox"><input class="fm-pdf-pageinput" type="text" inputmode="numeric" autocomplete="off" enterkeyhint="go" aria-label="${esc(t.page)}" value="–"><span class="fm-pdf-pagetotal">/ –</span></label>
            ${button('fm-pdf-btn', 'data-act="next"', t.next, icon('fa-chevron-right'))}
            <span class="fm-pdf-sep zoom-only"></span>
            ${button('fm-pdf-btn zoom-only', 'data-act="zoom-out"', t.zoomOut, icon('fa-minus'))}
            <button type="button" class="fm-pdf-zoomlabel zoom-only" data-act="zoom-menu" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(t.zoom)}" data-fm-tooltip="${esc(t.zoom)}">100%</button>
            ${button('fm-pdf-btn zoom-only', 'data-act="zoom-in"', t.zoomIn, icon('fa-plus'))}
            <span class="fm-pdf-sep zoom-only" data-sep="fit"></span>
            ${button('fm-pdf-btn zoom-only', 'data-act="fit"', t.fitPage, icon('fa-expand'))}
            <div class="fm-pdf-menu" role="menu" aria-label="${esc(t.zoom)}">
              <button type="button" role="menuitemradio" aria-checked="false" data-zoom="fit-width">${icon('fa-arrows-left-right')}<span>${esc(t.fitWidth)}</span>${icon('fa-check fm-pdf-check')}</button>
              <button type="button" role="menuitemradio" aria-checked="false" data-zoom="fit-page">${icon('fa-expand')}<span>${esc(t.fitPage)}</span>${icon('fa-check fm-pdf-check')}</button>
              <div class="fm-pdf-menu-sep"></div>
              ${zoomItems}
            </div>
          </div>
          <div class="fm-pdf-mdock" hidden>
            <div class="fm-pdf-mtools" role="toolbar" aria-label="${esc(t.tools)}" aria-orientation="vertical">
              ${button('fm-pdf-mtool is-active', `data-tool="pen" aria-pressed="true" ${n()}`, t.pen, icon('fa-pen'))}
              ${button('fm-pdf-mtool', `data-tool="arrow" aria-pressed="false" ${n()}`, t.arrow, icon('fa-arrow-right'))}
              ${button('fm-pdf-mtool', `data-tool="text" aria-pressed="false" ${n()}`, t.text, icon('fa-font'))}
              <div class="fm-pdf-mwrap" ${n()}>${button('fm-pdf-mtool', 'data-act="pop-size" aria-haspopup="true" aria-expanded="false"', t.size, '<span class="fm-pdf-msize">1.5x</span>')}
                <div class="fm-pdf-mpop fm-pdf-mpop-size" data-pop="size"><input type="range" min="1" max="8" step="0.1" value="1.5" aria-label="${esc(t.size)}"><span class="fm-pdf-msize-dot"><i></i></span></div></div>
              <div class="fm-pdf-mwrap" ${n()}>${button('fm-pdf-mtool', 'data-act="pop-color" aria-haspopup="true" aria-expanded="false"', t.color, '<span class="fm-pdf-mswatch"></span>')}
                <div class="fm-pdf-mpop" data-pop="color"></div></div>
              ${button('fm-pdf-mtool', `data-tool="eraser" aria-pressed="false" ${n()}`, t.eraser, icon('fa-eraser'))}
              <span class="fm-pdf-msep" ${n()}></span>
              ${button('fm-pdf-mtool', `data-act="undo" ${n()}`, t.undo, icon('fa-rotate-left'))}
              ${button('fm-pdf-mtool', `data-act="redo" ${n()}`, t.redo, icon('fa-rotate-right'))}
              ${button('fm-pdf-mtool', `data-act="clear" ${n()}`, t.clear, icon('fa-trash-can'))}
            </div>
            ${button('fm-pdf-mtoggle', 'data-act="markup" aria-pressed="false"', t.markup, icon('fa-pen'))}
          </div>
          <div class="fm-pdf-state" aria-live="polite"></div>
        </div>`;
      host.appendChild(el);
      const q = (sel) => el.querySelector(sel);
      this.rail = q('.fm-pdf-rail');
      this.railList = q('.fm-pdf-rail-list');
      this.stage = q('.fm-pdf-stage');
      this.scroll = q('.fm-pdf-scroll');
      this.pagesEl = q('.fm-pdf-pages');
      this.stateEl = q('.fm-pdf-state');
      this.toolbar = q('.fm-pdf-toolbar');
      this.pageInput = q('.fm-pdf-pageinput');
      this.pageTotal = q('.fm-pdf-pagetotal');
      this.zoomLabel = q('.fm-pdf-zoomlabel');
      this.menu = q('.fm-pdf-menu');
      this.dock = q('.fm-pdf-mdock');
      this.sizeInput = q('[data-pop="size"] input');
      this.colorPop = q('[data-pop="color"]');
      this.updateSizeUi();
      this.updateColorUi();
    }

    on(target, type, fn, opts){
      target.addEventListener(type, fn, opts);
      this.cleanups.push(() => target.removeEventListener(type, fn, opts));
    }

    bind(){
      const el = this.el;
      this.on(el, 'click', (e) => this.onClick(e));
      this.on(el, 'keydown', (e) => this.onKey(e));
      this.on(this.scroll, 'scroll', () => this.onScroll(), { passive: true });
      this.on(this.scroll, 'wheel', (e) => this.onWheel(e), { passive: false });
      this.on(this.scroll, 'pointerdown', (e) => this.onPointerDownCapture(e), true);
      this.on(this.scroll, 'pointermove', (e) => this.onPointerMoveCapture(e), true);
      this.on(root, 'pointerup', (e) => this.onPointerEnd(e), true);
      this.on(root, 'pointercancel', (e) => this.onPointerEnd(e), true);
      this.on(this.scroll, 'touchstart', (e) => this.onTouchStart(e), { passive: false });
      this.on(this.scroll, 'touchmove', (e) => this.onTouchMove(e), { passive: false });
      this.on(this.scroll, 'touchend', (e) => this.onTouchEnd(e), { passive: false });
      this.on(this.scroll, 'touchcancel', (e) => this.onTouchEnd(e), { passive: false });
      this.on(el, 'gesturestart', (e) => this.onGesture(e), { passive: false });
      this.on(el, 'gesturechange', (e) => this.onGesture(e), { passive: false });
      this.on(el, 'gestureend', (e) => this.onGesture(e), { passive: false });
      this.on(this.pageInput, 'focus', () => this.pageInput.select());
      this.on(this.pageInput, 'keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this.commitPageInput(); this.scroll.focus({ preventScroll: true }); }
        else if (e.key === 'Escape') { this.pageInput.value = String(this.current || ''); this.scroll.focus({ preventScroll: true }); }
      });
      this.on(this.pageInput, 'change', () => this.commitPageInput());
      this.on(this.pageInput, 'blur', () => { this.pageInput.value = String(this.current || '–'); });
      this.on(this.sizeInput, 'input', () => this.setSize(Number(this.sizeInput.value)));
      this.on(this.colorPop, 'mousedown', (e) => {
        this.activePage?.inst?.saveTextSelection?.();
        if (!e.target.closest('input[type="color"]')) e.preventDefault();
      });
      this.on(this.colorPop, 'input', (e) => { if (e.target.matches('input[type="color"]')) this.setColor(e.target.value); });
      this.on(document, 'pointerdown', (e) => {
        if (!e.target.closest?.('.fm-pdf-mwrap,.fm-pdf-menu,[data-act="zoom-menu"]')) this.closePopups();
      }, true);
      this.on(document, 'visibilitychange', () => { if (document.visibilityState === 'hidden') this.flushSave(); });
      this.on(root, 'pagehide', () => this.flushSave());
      if (root.ResizeObserver) {
        this.ro = new ResizeObserver(() => this.onResize());
        this.ro.observe(this.el);
        this.ro.observe(this.scroll);
      } else {
        this.on(root, 'resize', () => this.onResize());
      }
    }

    // ---- Loading ----
    async start(){
      this.setState('loading');
      try {
        const lib = this.lib = await loadPdfjs();
        if (this.destroyed) return;
        const params = { isEvalSupported: false, enableXfa: false };
        if (this.o.data) params.data = this.o.data instanceof ArrayBuffer ? new Uint8Array(this.o.data.slice(0)) : this.o.data;
        else if (this.o.url) { params.url = this.o.url; params.withCredentials = !!this.o.withCredentials; }
        else throw codedError('missing', L('pdfv_err_missing', 'The PDF could not be found.'));
        const task = this.loadingTask = lib.getDocument(params);
        const pdf = this.pdf = await task.promise;
        if (this.destroyed) return;
        const count = pdf.numPages;
        if (!count) throw codedError('invalid', L('pdfv_err_empty', 'This PDF has no pages.'));
        const docPages = await Promise.all(Array.from({ length: count }, (_, idx) => pdf.getPage(idx + 1)));
        if (this.destroyed) return;
        this.pages = docPages.map((page, idx) => {
          const vp = page.getViewport({ scale: 1 });
          return { n: idx + 1, page, w: vp.width, h: vp.height, k: 1, cw: 0, ch: 0, items: [], renderedScale: 0, textState: 0 };
        });
        // Every page is shown at the width of the document's most common page, so a stray
        // landscape or oversized page never forces sideways scrolling; zoom is relative to that page.
        const widths = new Map();
        this.pages.forEach((p) => { const key = Math.round(p.w); widths.set(key, (widths.get(key) || 0) + 1); });
        const refKey = [...widths.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
        this.refW = this.pages.find((p) => Math.round(p.w) === refKey).w;
        this.pages.forEach((p) => { p.k = this.refW / p.w; });
        this.buildPages();
        this.buildThumbs();
        this.pageTotal.textContent = `/ ${count}`;
        this.pageInput.style.width = `${String(count).length + 2.4}ch`;
        this.updateLayoutClasses();
        this.el.classList.add('is-instant');
        this.setState('ready');
        void this.scroll.offsetWidth;
        const z = typeof this.zoomMode === 'string' ? this.fitScale(this.zoomMode, Number(this.o.initialPage) || 1) : this.zoomMode;
        this.zoom = clampZoom(z);
        this.layoutPages();
        this.updateZoomUi();
        requestAnimationFrame(() => requestAnimationFrame(() => this.el.classList.remove('is-instant')));
        const initial = clamp(Math.round(Number(this.o.initialPage) || 1), 1, count);
        this.goTo(initial, { silent: true });
        this.observe();
        if (this.mo) this.loadMarkup();
        try { this.o.onReady?.({ pageCount: count }); } catch (error) { console.error('[FirstMatePdf] onReady failed', error); }
        this.resolveReady({ pageCount: count });
      } catch (error) {
        this.fail(error);
      }
    }

    fail(error){
      if (this.destroyed) return;
      const err = classifyError(error);
      if (err.cause) console.warn('[FirstMatePdf] could not open the PDF', err.cause);
      this.failed = err;
      this.setState('error', err);
      try { this.o.onError?.(err); } catch (e) { console.error('[FirstMatePdf] onError failed', e); }
      this.rejectReady(err);
    }

    retry(){
      if (this.destroyed) return;
      this.failed = null;
      try { this.loadingTask?.destroy?.(); } catch (_) {}
      this.loadingTask = null;
      this.pdf = null;
      this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
      this.ready.catch(() => {});
      this.start();
    }

    setState(kind, error){
      const el = this.el;
      el.classList.toggle('is-loading', kind === 'loading');
      el.classList.toggle('is-ready', kind === 'ready');
      el.classList.toggle('is-error', kind === 'error');
      if (kind === 'loading') {
        const page = '<div class="fm-pdf-skel-page" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>';
        this.stateEl.innerHTML = `<div class="fm-pdf-skel" role="status" aria-label="${esc(L('pdfv_loading', 'Loading document'))}">${page}${page}</div>`;
      } else if (kind === 'error') {
        const password = error?.code === 'password';
        const retry = ['network', 'library', 'unknown'].includes(error?.code);
        const title = password ? L('pdfv_err_password_title', 'This PDF is password protected') : L('pdfv_err_title', 'This PDF couldn’t be opened');
        this.stateEl.innerHTML = `<div class="fm-pdf-error${password ? ' is-password' : ''}" role="alert">
          <div class="fm-pdf-error-icon">${icon(password ? 'fa-lock' : 'fa-triangle-exclamation')}</div>
          <strong>${esc(title)}</strong><p>${esc(error?.message || '')}</p>
          ${retry ? `<button type="button" data-act="retry">${icon('fa-rotate-right')}<span>${esc(L('pdfv_try_again', 'Try again'))}</span></button>` : ''}
        </div>`;
      } else {
        clearTimeout(this.stateTimer);
        this.stateTimer = setTimeout(() => { if (this.el.classList.contains('is-ready')) this.stateEl.innerHTML = ''; }, 420);
      }
    }

    buildPages(){
      const frag = document.createDocumentFragment();
      const total = this.pages.length;
      this.pages.forEach((p) => {
        const el = document.createElement('div');
        el.className = 'fm-pdf-page';
        el.dataset.page = String(p.n);
        el.setAttribute('role', 'group');
        el.setAttribute('aria-label', L('pdfv_page_of', 'Page {page} of {count}', { page: p.n, count: total }));
        const text = document.createElement('div');
        text.className = 'fm-pdf-textlayer textLayer';
        el.appendChild(text);
        p.el = el;
        p.textEl = text;
        this.byEl.set(el, p);
        frag.appendChild(el);
      });
      this.pagesEl.replaceChildren(frag);
    }

    buildThumbs(){
      if (this.o.thumbnails === false) return;
      this.railList.innerHTML = this.pages.map((p) => `<button type="button" class="fm-pdf-thumb" data-thumb="${p.n}" aria-label="${esc(L('pdfv_go_to_page', 'Go to page {page}', { page: p.n }))}"><span class="fm-pdf-thumb-card" style="aspect-ratio:${p.w.toFixed(2)}/${p.h.toFixed(2)}"><canvas></canvas></span><span class="fm-pdf-thumb-num">${p.n}</span></button>`).join('');
      this.pages.forEach((p) => {
        p.thumb = this.railList.querySelector(`[data-thumb="${p.n}"]`);
        this.byThumb.set(p.thumb, p);
      });
      if (!root.IntersectionObserver) return;
      this.thumbIO = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          const p = this.byThumb.get(entry.target);
          if (!p) return;
          p.thumbVisible = entry.isIntersecting;
          if (entry.isIntersecting) this.queueThumb(p);
        });
      }, { root: this.railList, rootMargin: '240px 0px' });
      this.pages.forEach((p) => this.thumbIO.observe(p.thumb));
    }

    observe(){
      if (!root.IntersectionObserver) {
        this.pages.forEach((p) => { p.near = true; p.keep = true; });
        this.pump();
        return;
      }
      this.nearIO = new IntersectionObserver((entries) => {
        entries.forEach((entry) => { const p = this.byEl.get(entry.target); if (p) p.near = entry.isIntersecting; });
        this.pump();
      }, { root: this.scroll, rootMargin: '100% 0px' });
      this.keepIO = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          const p = this.byEl.get(entry.target);
          if (!p) return;
          p.keep = entry.isIntersecting;
          if (!p.keep) this.release(p);
        });
      }, { root: this.scroll, rootMargin: '200% 0px' });
      this.pages.forEach((p) => { this.nearIO.observe(p.el); this.keepIO.observe(p.el); });
    }

    // ---- Layout and zoom ----
    insetTop(){ return Number(this.o.insetTop) || 0; }

    updateLayoutClasses(){
      const el = this.el;
      const w = el.clientWidth || this.host.clientWidth || 0;
      const h = el.clientHeight || this.host.clientHeight || 0;
      const phone = w > 0 && w < PHONE_MAX;
      const wide = w >= WIDE_MIN;
      el.classList.toggle('is-phone', phone);
      el.classList.toggle('is-compact', w > 0 && w < COMPACT_MAX);
      el.classList.toggle('is-wide', wide);
      el.classList.toggle('is-short', h > 0 && h < 600);
      const opt = this.o.thumbnails ?? 'auto';
      const available = opt !== false && !(phone && opt !== true);
      if (this.railWide !== wide) {
        if (this.railWide === undefined) this.railOpen = opt === true || (opt === 'auto' && wide);
        else if (!wide) this.railOpen = false;
        else this.railOpen = opt === true || (opt === 'auto' && !this.railUserClosed);
        this.railWide = wide;
      }
      if (!available) this.railOpen = false;
      this.railAvailable = available;
      el.classList.toggle('has-rail', available);
      el.classList.toggle('rail-docked', wide);
      this.applyRailOpen();
    }

    applyRailOpen(){
      const open = !!(this.railOpen && this.railAvailable);
      this.el.classList.toggle('rail-open', open);
      const btn = this.toolbar.querySelector('[data-act="thumbs"]');
      btn.classList.toggle('is-on', open);
      btn.setAttribute('aria-pressed', String(open));
      if (open) {
        this.pages.forEach((p) => { if (p.thumbVisible) this.queueThumb(p); });
        this.scrollThumbIntoView(false);
      }
    }

    toggleRail(force){
      this.railOpen = force == null ? !this.railOpen : !!force;
      if (!this.railOpen) this.railUserClosed = true; else this.railUserClosed = false;
      this.applyRailOpen();
    }

    fitScale(mode, pageNumber){
      const sc = this.scroll;
      const style = root.getComputedStyle(this.pagesEl);
      const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      const padTop = parseFloat(style.paddingTop) || 0;
      const availW = Math.max(40, sc.clientWidth - padX);
      if (!this.pages.length) return 1;
      if (mode === 'fit-page') {
        const p = this.pages[clamp((pageNumber || this.current || 1) - 1, 0, this.pages.length - 1)];
        const clearance = this.el.classList.contains('is-phone') ? 72 : 84;
        const availH = Math.max(40, sc.clientHeight - padTop - clearance);
        return clampZoom(Math.min(availW / (p.w * p.k * CSS_UNITS), availH / (p.h * p.k * CSS_UNITS)));
      }
      return clampZoom(availW / (this.refW * CSS_UNITS));
    }

    layoutPages(){
      const cs = this.zoom * CSS_UNITS;
      this.pages.forEach((p) => {
        const scale = cs * p.k;
        p.el.style.setProperty('--scale-factor', String(scale));
        p.cw = Math.round(p.w * scale);
        p.ch = Math.round(p.h * scale);
        p.el.style.width = `${p.cw}px`;
        p.el.style.height = `${p.ch}px`;
      });
    }

    captureAnchor(pt){
      if (!this.pages.length) return null;
      const sc = this.scroll;
      const rect = sc.getBoundingClientRect();
      const ax = pt ? pt.clientX - rect.left : sc.clientWidth / 2;
      const ay = pt ? pt.clientY - rect.top : this.insetTop();
      const cx = sc.scrollLeft + ax;
      const cy = sc.scrollTop + ay;
      const p = this.pages[this.pageIndexAt(cy)];
      const h = p.el.offsetHeight || 1;
      const w = p.el.offsetWidth || 1;
      return { p, fx: (cx - p.el.offsetLeft) / w, fy: (cy - p.el.offsetTop) / h, ax, ay };
    }

    restoreAnchor(a){
      if (!a) return;
      const sc = this.scroll;
      sc.scrollTop = a.p.el.offsetTop + a.fy * a.p.el.offsetHeight - a.ay;
      sc.scrollLeft = a.p.el.offsetLeft + a.fx * a.p.el.offsetWidth - a.ax;
    }

    setScale(z, pt, anchor){
      z = clampZoom(z);
      if (!this.pages.length) { this.zoom = z; return; }
      const a = anchor || this.captureAnchor(pt);
      this.zoom = z;
      this.layoutPages();
      this.restoreAnchor(a);
      this.pages.forEach((p) => { if (p.near) this.syncMarkupScale(p); });
      this.updateZoomUi();
      this.scheduleSettle();
    }

    scheduleSettle(){
      this.settling = true;
      clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => {
        this.settling = false;
        if (this.destroyed) return;
        this.pages.forEach((p) => { if (!p.near && p.canvas) this.release(p); });
        this.pump();
      }, 180);
      this.pump();
    }

    setZoom(mode, pt){
      const next = normalizeZoom(mode);
      this.zoomMode = next;
      if (!this.pages.length) return;
      if (typeof next === 'string') this.setScale(this.fitScale(next), null);
      else this.setScale(next, pt || this.centerPoint());
    }

    centerPoint(){
      const r = this.scroll.getBoundingClientRect();
      return { clientX: r.left + this.scroll.clientWidth / 2, clientY: r.top + this.scroll.clientHeight / 2 };
    }

    zoomStep(dir){
      const z = this.zoom;
      const next = dir > 0
        ? ZOOM_STEPS.find((s) => s > z * 1.001) ?? MAX_ZOOM
        : [...ZOOM_STEPS].reverse().find((s) => s < z * 0.999) ?? MIN_ZOOM;
      this.setZoom(next);
    }

    updateZoomUi(){
      this.zoomLabel.textContent = zoomText(this.zoom);
      const fitBtn = this.toolbar.querySelector('[data-act="fit"]');
      const toPage = this.zoomMode === 'fit-width';
      const label = toPage ? L('pdfv_fit_page', 'Fit page') : L('pdfv_fit_width', 'Fit width');
      fitBtn.innerHTML = icon(toPage ? 'fa-expand' : 'fa-arrows-left-right');
      fitBtn.setAttribute('aria-label', label);
      fitBtn.setAttribute('data-fm-tooltip', label);
      this.toolbar.querySelector('[data-act="zoom-in"]').disabled = this.zoom >= MAX_ZOOM - 0.001;
      this.toolbar.querySelector('[data-act="zoom-out"]').disabled = this.zoom <= MIN_ZOOM + 0.001;
      this.menu.querySelectorAll('[data-zoom]').forEach((b) => {
        const v = b.dataset.zoom;
        const on = v === this.zoomMode || (typeof this.zoomMode === 'number' && Math.abs(Number(v) - this.zoomMode) < 0.005);
        b.setAttribute('aria-checked', String(!!on));
      });
    }

    onResize(){
      if (this.resizeRaf) return;
      this.resizeRaf = requestAnimationFrame(() => {
        this.resizeRaf = 0;
        if (this.destroyed) return;
        this.updateLayoutClasses();
        if (!this.pages.length) return;
        if (typeof this.zoomMode === 'string') {
          const z = this.fitScale(this.zoomMode);
          if (Math.abs(z - this.zoom) > 0.0005) this.setScale(z, null);
        }
        this.pump();
      });
    }

    // ---- Pages: tracking and navigation ----
    pageIndexAt(y){
      let lo = 0, hi = this.pages.length - 1, ans = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (this.pages[mid].el.offsetTop <= y) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return ans;
    }

    pageFromScroll(){
      const sc = this.scroll;
      const top = sc.scrollTop + this.insetTop();
      const bottom = sc.scrollTop + sc.clientHeight;
      const span = Math.max(1, bottom - top);
      const i0 = this.pageIndexAt(top);
      let best = i0, bestVis = -1;
      for (let i = i0; i < Math.min(this.pages.length, i0 + 5); i += 1) {
        const el = this.pages[i].el;
        const t = el.offsetTop, b = t + el.offsetHeight;
        if (t > bottom) break;
        const vis = (Math.min(b, bottom) - Math.max(t, top)) / Math.min(el.offsetHeight || 1, span);
        if (vis > bestVis + 0.001) { best = i; bestVis = vis; }
      }
      if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2) {
        const last = this.pages[this.pages.length - 1].el;
        if (last.offsetTop >= top && last.offsetTop + last.offsetHeight <= bottom + 1) best = this.pages.length - 1;
      }
      return best + 1;
    }

    onScroll(){
      const st = this.scroll.scrollTop;
      const dy = st - (this.lastScrollTop ?? st);
      this.lastScrollTop = st;
      if (this.isTouch && !this.markupActive && !this.pinch && !this.navLock && Math.abs(dy) > 3) this.setChromeHidden(st > 24);
      if (this.navLock) { this.armNavLock(); return; }
      if (this.scrollRaf) return;
      this.scrollRaf = requestAnimationFrame(() => {
        this.scrollRaf = 0;
        if (this.destroyed || !this.pages.length) return;
        this.setCurrent(this.pageFromScroll());
      });
    }

    armNavLock(){
      clearTimeout(this.navTimer);
      this.navTimer = setTimeout(() => {
        this.navLock = false;
        // A scroll that moved away from where the navigation landed was the reader's own.
        const sc = this.scroll;
        const target = Math.min(this.navTop ?? sc.scrollTop, Math.max(0, sc.scrollHeight - sc.clientHeight));
        if (!this.destroyed && this.pages.length && Math.abs(sc.scrollTop - target) > 2) this.setCurrent(this.pageFromScroll());
      }, 160);
    }

    goTo(n, opts = {}){
      if (!this.pages.length) { this.o.initialPage = n; return 0; }
      n = clamp(Math.round(Number(n) || 1), 1, this.pages.length);
      const p = this.pages[n - 1];
      const gap = this.el.classList.contains('is-phone') ? 8 : 12;
      const top = n === 1 ? 0 : Math.max(0, p.el.offsetTop - this.insetTop() - gap);
      this.navLock = true;
      this.navTop = top;
      this.armNavLock();
      const smooth = !!opts.smooth && !reducedMotion() && Math.abs(top - this.scroll.scrollTop) < this.scroll.clientHeight * 12;
      this.scroll.scrollTo({ top, left: this.scroll.scrollLeft, behavior: smooth ? 'smooth' : 'auto' });
      this.setCurrent(n, { silent: opts.silent, smooth });
      return n;
    }

    setCurrent(n, opts = {}){
      if (!n || n === this.current) return;
      const prev = this.current;
      this.current = n;
      if (document.activeElement !== this.pageInput) this.pageInput.value = String(n);
      this.toolbar.querySelector('[data-act="prev"]').disabled = n <= 1;
      this.toolbar.querySelector('[data-act="next"]').disabled = n >= this.pages.length;
      const old = this.pages[prev - 1]?.thumb;
      old?.classList.remove('is-current');
      old?.removeAttribute('aria-current');
      const thumb = this.pages[n - 1]?.thumb;
      if (thumb) { thumb.classList.add('is-current'); thumb.setAttribute('aria-current', 'page'); }
      this.scrollThumbIntoView(!!opts.smooth);
      this.updateMarkupButtons();
      if (opts.silent) return;
      try { this.o.onPageChange?.({ page: n, pageCount: this.pages.length }); } catch (error) { console.error('[FirstMatePdf] onPageChange failed', error); }
    }

    scrollThumbIntoView(smooth){
      const thumb = this.pages[this.current - 1]?.thumb;
      if (!thumb || !this.el.classList.contains('rail-open')) return;
      const list = this.railList;
      const top = thumb.offsetTop, bottom = top + thumb.offsetHeight;
      if (top >= list.scrollTop + 12 && bottom <= list.scrollTop + list.clientHeight - 96) return;
      list.scrollTo({ top: Math.max(0, top - list.clientHeight / 2 + thumb.offsetHeight / 2), behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' });
    }

    commitPageInput(){
      const n = parseInt(String(this.pageInput.value).replace(/[^\d]/g, ''), 10);
      if (Number.isFinite(n) && this.pages.length) this.goTo(n, { smooth: true });
      this.pageInput.value = String(this.current || '–');
    }

    setChromeHidden(hidden){
      hidden = !!hidden && !this.markupActive;
      if (hidden === !!this.chromeHidden) return;
      this.chromeHidden = hidden;
      this.el.classList.toggle('chrome-hidden', hidden);
      if (hidden) this.closePopups();
      try { this.o.onChromeChange?.({ hidden }); } catch (_) {}
    }

    // ---- Rendering ----
    pump(){
      if (this.destroyed || !this.pages.length) return;
      const cs = this.zoom * CSS_UNITS;
      const need = this.pages.filter((p) => p.near && !p.rendering && (this.settling ? !p.canvas : p.renderedScale !== cs));
      const cur = this.current || 1;
      need.sort((a, b) => Math.abs(a.n - cur) - Math.abs(b.n - cur));
      for (const p of need) {
        if (this.renders >= 2) break;
        this.renderPage(p);
      }
      this.pages.forEach((p) => {
        if (!p.near) return;
        this.ensureMarkup(p);
        this.syncMarkupScale(p);
      });
    }

    async renderPage(p){
      p.rendering = true;
      this.renders += 1;
      const cs = this.zoom * CSS_UNITS;
      let canvas = null;
      try {
        const vp = p.page.getViewport({ scale: cs * p.k });
        let ratio = root.devicePixelRatio || 1;
        const area = vp.width * vp.height;
        if (area * ratio * ratio > MAX_CANVAS_PIXELS) ratio = Math.sqrt(MAX_CANVAS_PIXELS / area);
        canvas = document.createElement('canvas');
        canvas.className = 'fm-pdf-canvas';
        canvas.width = Math.max(1, Math.floor(vp.width * ratio));
        canvas.height = Math.max(1, Math.floor(vp.height * ratio));
        canvas.setAttribute('aria-hidden', 'true');
        const ctx = canvas.getContext('2d', { alpha: false });
        const task = p.renderTask = p.page.render({ canvasContext: ctx, viewport: vp, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null });
        await task.promise;
        if (this.destroyed || p.released) { freeCanvas(canvas); return; }
        const first = !p.canvas;
        if (p.canvas) { const old = p.canvas; old.replaceWith(canvas); freeCanvas(old); canvas.classList.add('is-shown'); }
        else {
          p.el.insertBefore(canvas, p.el.firstChild);
          requestAnimationFrame(() => canvas.classList.add('is-shown'));
        }
        p.canvas = canvas;
        p.renderedScale = cs;
        p.el.classList.add('is-rendered');
        if (first) this.drawThumbFromCanvas(p);
        this.renderText(p);
      } catch (error) {
        freeCanvas(canvas);
        if (error?.name !== 'RenderingCancelledException') console.warn(`[FirstMatePdf] page ${p.n} failed to render`, error);
      } finally {
        p.rendering = false;
        p.released = false;
        p.renderTask = null;
        this.renders -= 1;
        if (!this.destroyed) {
          if (p.keep === false && p.canvas) this.release(p);
          this.pump();
        }
      }
    }

    async renderText(p){
      if (p.textState || !this.lib?.renderTextLayer) return;
      p.textState = 1;
      try {
        const content = await p.page.getTextContent();
        if (this.destroyed || p.textState !== 1) return;
        p.textEl.replaceChildren();
        const viewport = p.page.getViewport({ scale: this.zoom * CSS_UNITS * p.k });
        const task = p.textTask = this.lib.renderTextLayer({ textContentSource: content, textContent: content, container: p.textEl, viewport, textDivs: [] });
        await task.promise;
        if (p.textState === 1) p.textState = 2;
      } catch (error) {
        if (p.textState === 1) p.textState = 0;
        if (error?.name !== 'AbortException') console.warn(`[FirstMatePdf] page ${p.n} text failed`, error);
      } finally {
        p.textTask = null;
      }
    }

    release(p){
      if (p.rendering) { p.released = true; try { p.renderTask?.cancel(); } catch (_) {} }
      if (p.canvas) { freeCanvas(p.canvas); p.canvas.remove(); p.canvas = null; }
      try { p.textTask?.cancel(); } catch (_) {}
      p.textTask = null;
      if (p.textState) { p.textEl.replaceChildren(); p.textState = 0; }
      p.renderedScale = 0;
      p.el.classList.remove('is-rendered');
    }

    // ---- Thumbnails ----
    queueThumb(p){
      if (p.thumbDrawn || p.thumbQueued || !this.el.classList.contains('rail-open')) return;
      p.thumbQueued = true;
      this.thumbChain = this.thumbChain.then(() => this.drawThumb(p)).catch(() => {});
    }

    drawThumbFromCanvas(p){
      if (!p.thumb || p.thumbDrawn || !p.canvas) return;
      const target = p.thumb.querySelector('canvas');
      const dpr = Math.min(2, root.devicePixelRatio || 1);
      target.width = Math.round(THUMB_WIDTH * dpr);
      target.height = Math.round(THUMB_WIDTH * dpr * p.h / p.w);
      const ctx = target.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(p.canvas, 0, 0, target.width, target.height);
      p.thumbDrawn = true;
      p.thumb.classList.add('is-drawn');
    }

    async drawThumb(p){
      p.thumbQueued = false;
      if (this.destroyed || p.thumbDrawn || !p.thumbVisible) return;
      for (let i = 0; i < 30 && this.renders > 0 && !this.destroyed; i += 1) await new Promise((r) => setTimeout(r, 60));
      if (this.destroyed || p.thumbDrawn) return;
      if (p.canvas) { this.drawThumbFromCanvas(p); return; }
      const target = p.thumb.querySelector('canvas');
      const dpr = Math.min(2, root.devicePixelRatio || 1);
      const vp = p.page.getViewport({ scale: (THUMB_WIDTH * dpr) / p.w });
      target.width = Math.round(vp.width);
      target.height = Math.round(vp.height);
      try {
        await p.page.render({ canvasContext: target.getContext('2d', { alpha: false }), viewport: vp }).promise;
        p.thumbDrawn = true;
        p.thumb.classList.add('is-drawn');
      } catch (error) {
        if (error?.name !== 'RenderingCancelledException') console.warn(`[FirstMatePdf] thumbnail ${p.n} failed`, error);
      }
    }

    // ---- Pointer, wheel, touch and keys ----
    onPointerDownCapture(e){
      if (e.pointerType === 'touch') {
        this.touchIds.add(e.pointerId);
        if (this.touchIds.size > 1) { this.abortStroke(); this.tap = null; e.stopPropagation(); return; }
        this.tap = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() };
      }
      const active = document.activeElement;
      if (active?.closest?.('.fm-photo-markup-text') && !active.contains(e.target)) active.blur();
      if (!e.target.closest?.('.fm-photo-markup-text') && !this.el.contains(document.activeElement)) this.scroll.focus({ preventScroll: true });
      if (!this.markupActive) return;
      const pageEl = e.target.closest?.('.fm-pdf-page');
      const p = pageEl && this.byEl.get(pageEl);
      if (p?.inst) this.activatePage(p);
    }

    onPointerMoveCapture(e){
      if (e.pointerType !== 'touch') return;
      if (this.touchIds.size > 1) { e.stopPropagation(); return; }
      if (this.tap && this.tap.id === e.pointerId && Math.hypot(e.clientX - this.tap.x, e.clientY - this.tap.y) > 10) this.tap = null;
    }

    onPointerEnd(e){
      if (e.pointerType !== 'touch') return;
      this.touchIds.delete(e.pointerId);
      const tap = this.tap;
      if (!tap || tap.id !== e.pointerId) return;
      this.tap = null;
      if (e.type === 'pointerup' && performance.now() - tap.t < 350 && this.scroll.contains(e.target)) this.setChromeHidden(false);
    }

    abortStroke(){
      const inst = this.activePage?.inst;
      if (!inst) return;
      if (inst.drawing) {
        const drawing = inst.drawing;
        inst.items = inst.items.filter((item) => item !== drawing);
        inst.drawing = null;
        inst.renderLayer();
      }
      inst.erasing = false;
      inst.eraserPoints = [];
      inst.dragging = null;
    }

    onWheel(e){
      if (!e.ctrlKey || !this.pages.length) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const factor = clamp(Math.pow(2, -(e.deltaY * unit) / 240), 0.5, 2);
      this.wheelZoom = clampZoom((this.wheelZoom || this.zoom) * factor);
      this.wheelPt = { clientX: e.clientX, clientY: e.clientY };
      if (this.wheelRaf) return;
      this.wheelRaf = requestAnimationFrame(() => {
        this.wheelRaf = 0;
        const z = this.wheelZoom;
        this.wheelZoom = 0;
        if (!z || this.destroyed) return;
        this.zoomMode = z;
        this.setScale(z, this.wheelPt);
      });
    }

    onTouchStart(e){
      if (e.touches.length !== 2 || !this.pages.length) return;
      const [a, b] = e.touches;
      const mid = { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 };
      const rect = this.pagesEl.getBoundingClientRect();
      this.pinch = { d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1, mid0: mid, mid, z0: this.zoom, anchor: this.captureAnchor(mid), s: 1, tx: 0, ty: 0, native: false, raf: 0 };
      this.pagesEl.style.transformOrigin = `${mid.clientX - rect.left}px ${mid.clientY - rect.top}px`;
      this.el.classList.add('is-pinching');
      this.setChromeHidden(false);
      if (e.cancelable) e.preventDefault();
    }

    onTouchMove(e){
      const pin = this.pinch;
      if (!pin || e.touches.length < 2) return;
      if (e.cancelable) e.preventDefault(); else pin.native = true;
      const [a, b] = e.touches;
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
      pin.mid = { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 };
      pin.s = clampZoom(pin.z0 * d / pin.d0) / pin.z0;
      pin.tx = pin.native ? 0 : pin.mid.clientX - pin.mid0.clientX;
      pin.ty = pin.native ? 0 : pin.mid.clientY - pin.mid0.clientY;
      if (!pin.raf) {
        pin.raf = requestAnimationFrame(() => {
          pin.raf = 0;
          if (this.pinch === pin) this.pagesEl.style.transform = `translate(${pin.tx}px,${pin.ty}px) scale(${pin.s})`;
        });
      }
    }

    onTouchEnd(e){
      const pin = this.pinch;
      if (!pin || e.touches.length >= 2) return;
      cancelAnimationFrame(pin.raf);
      this.pinch = null;
      this.pagesEl.style.transform = '';
      this.pagesEl.style.transformOrigin = '';
      this.el.classList.remove('is-pinching');
      const target = pin.native ? pin.mid0 : pin.mid;
      const rect = this.scroll.getBoundingClientRect();
      const anchor = pin.anchor ? { ...pin.anchor, ax: target.clientX - rect.left, ay: target.clientY - rect.top } : null;
      const z = clampZoom(pin.z0 * pin.s);
      if (Math.abs(z - this.zoom) > 0.001) this.zoomMode = z;
      this.setScale(z, null, anchor);
    }

    onGesture(e){
      // Safari trackpad pinch (and iOS, where touch events already handle it).
      e.preventDefault();
      if (this.pinch || !this.pages.length) return;
      if (e.type === 'gesturestart') { this.gestureZoom = this.zoom; return; }
      if (e.type === 'gesturechange' && this.gestureZoom) {
        const z = clampZoom(this.gestureZoom * e.scale);
        this.zoomMode = z;
        this.setScale(z, { clientX: e.clientX, clientY: e.clientY });
      }
      if (e.type === 'gestureend') this.gestureZoom = 0;
    }

    onKey(e){
      const t = e.target;
      const inMarkupText = !!t.closest?.('.fm-photo-markup-text');
      const editing = inMarkupText || !!t.matches?.('input,textarea,select,[contenteditable="true"]');
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape') {
        if (this.closePopups()) { e.preventDefault(); e.stopPropagation(); return; }
        if (inMarkupText) { t.blur(); this.scroll.focus({ preventScroll: true }); e.stopPropagation(); return; }
        if (this.markupActive) { this.setMarkupActive(false); e.stopPropagation(); return; }
        if (this.railOpen && !this.el.classList.contains('rail-docked')) { this.toggleRail(false); e.stopPropagation(); }
        return;
      }
      if (mod && !e.altKey) {
        const k = e.key;
        if (k === '+' || k === '=' || k === 'Add') this.zoomStep(1);
        else if (k === '-' || k === '_' || k === 'Subtract') this.zoomStep(-1);
        else if (k === '0') this.setZoom(this.o.zoom ?? 'fit-width');
        else return;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (editing || e.altKey || !this.pages.length) return;
      if (e.key === 'PageDown') this.goTo(this.current + 1, { smooth: true });
      else if (e.key === 'PageUp') this.goTo(this.current - 1, { smooth: true });
      else if (e.key === 'Home') this.goTo(1);
      else if (e.key === 'End') this.goTo(this.pages.length);
      else return;
      // Handled here, so a host (a media modal paging between files) does not act on it too.
      e.preventDefault();
      e.stopPropagation();
    }

    onClick(e){
      const thumb = e.target.closest('[data-thumb]');
      if (thumb) {
        this.goTo(Number(thumb.dataset.thumb), { smooth: true });
        if (!this.el.classList.contains('rail-docked')) this.toggleRail(false);
        return;
      }
      const colorBtn = e.target.closest('[data-markup-color]');
      if (colorBtn) { this.setColor(colorBtn.dataset.markupColor); return; }
      const zoomBtn = e.target.closest('[data-zoom]');
      if (zoomBtn) {
        const v = zoomBtn.dataset.zoom;
        this.setZoom(v === 'fit-width' || v === 'fit-page' ? v : Number(v));
        this.closePopups();
        return;
      }
      const toolBtn = e.target.closest('[data-tool]');
      if (toolBtn) { this.setTool(toolBtn.dataset.tool); return; }
      const actBtn = e.target.closest('[data-act]');
      if (!actBtn || actBtn.disabled) return;
      const act = actBtn.dataset.act;
      if (act === 'thumbs') this.toggleRail();
      else if (act === 'close-rail') this.toggleRail(false);
      else if (act === 'prev') this.goTo(this.current - 1, { smooth: true });
      else if (act === 'next') this.goTo(this.current + 1, { smooth: true });
      else if (act === 'zoom-in') this.zoomStep(1);
      else if (act === 'zoom-out') this.zoomStep(-1);
      else if (act === 'fit') this.setZoom(this.zoomMode === 'fit-width' ? 'fit-page' : 'fit-width');
      else if (act === 'zoom-menu') this.togglePopup(this.menu, actBtn);
      else if (act === 'markup') this.setMarkupActive(!this.markupActive);
      else if (act === 'undo') this.undo();
      else if (act === 'redo') this.redo();
      else if (act === 'clear') this.clearPage();
      else if (act === 'pop-size') this.togglePopup(this.el.querySelector('[data-pop="size"]'), actBtn);
      else if (act === 'pop-color') { this.renderPalette(); this.togglePopup(this.colorPop, actBtn); }
      else if (act === 'retry') this.retry();
    }

    togglePopup(pop, trigger){
      const open = !pop.classList.contains('is-open');
      this.closePopups();
      if (!open) return;
      if (pop === this.menu) {
        this.menu.style.left = `${trigger.offsetLeft + trigger.offsetWidth / 2}px`;
      }
      pop.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
      this.openTrigger = trigger;
    }

    closePopups(){
      let closed = false;
      this.el.querySelectorAll('.fm-pdf-menu.is-open,.fm-pdf-mpop.is-open').forEach((pop) => { pop.classList.remove('is-open'); closed = true; });
      this.openTrigger?.setAttribute('aria-expanded', 'false');
      this.openTrigger = null;
      return closed;
    }

    // ---- Markup ----
    canEdit(){ return !!(this.mo && !this.readOnly && this.markupLoaded && !this.markupLoadFailed && this.Markup?.PhotoMarkup); }

    async loadMarkup(){
      try { this.Markup = await loadMarkupLib(); }
      catch (error) { console.warn('[FirstMatePdf] markup tools could not load', error); return; }
      if (this.destroyed || !this.Markup?.PhotoMarkup) return;
      let data = {};
      if (typeof this.mo.load === 'function') {
        try { data = (await this.mo.load()) || {}; }
        catch (error) {
          // Editing on top of markup that failed to load would overwrite it on the next save.
          console.warn('[FirstMatePdf] markup failed to load; showing the document without markup editing', error);
          this.markupLoadFailed = true;
        }
      }
      if (this.destroyed) return;
      this.pages.forEach((p) => {
        const items = data[p.n] ?? data[String(p.n)];
        p.items = Array.isArray(items) ? cloneItems(items) : [];
        p.hadItems = p.items.length > 0;
      });
      this.markupLoaded = true;
      this.dock.hidden = !this.canEdit();
      this.renderPalette();
      this.updateColorUi();
      this.pump();
      if (this.pendingMarkup) { this.pendingMarkup = false; this.setMarkupActive(true); }
    }

    ensureMarkup(p){
      if (p.inst || !this.markupLoaded || !this.Markup?.PhotoMarkup || !p.cw) return;
      const host = document.createElement('div');
      host.className = 'fm-pdf-markup';
      p.el.appendChild(host);
      p.markupW = p.cw;
      try {
        p.inst = new this.Markup.PhotoMarkup(host, {
          items: scaleMarkupItems(cloneItems(p.items), p.cw / MARKUP_REF_WIDTH),
          size: this.size,
          onChange: (items) => this.onMarkupChange(p, items)
        });
      } catch (error) {
        console.warn('[FirstMatePdf] markup layer failed', error);
        host.remove();
        return;
      }
      p.inst.tool = this.tool;
      p.inst.color = this.color;
      p.inst.size = this.size;
      if (this.markupActive && !this.activePage && p.n === this.current) this.activatePage(p);
    }

    syncMarkupScale(p){
      if (!p.inst || !p.cw || p.markupW === p.cw) return;
      const factor = p.cw / p.markupW;
      p.markupW = p.cw;
      scaleMarkupItems(p.inst.items, factor);
      (Array.isArray(p.inst.history) ? p.inst.history : []).forEach((snapshot) => scaleMarkupItems(snapshot, factor));
      if (p.inst.items.some((item) => item?.type === 'text')) p.inst.renderLayer();
    }

    onMarkupChange(p, items){
      if (this.destroyed || !this.canEdit()) return;
      p.items = scaleMarkupItems(cloneItems(items), MARKUP_REF_WIDTH / (p.markupW || p.cw || MARKUP_REF_WIDTH));
      p.touched = true;
      this.lastEdited = p;
      this.scheduleSave();
      this.updateMarkupButtons();
    }

    activatePage(p){
      if (this.activePage === p) { if (this.markupActive && p.inst && !p.inst.active) p.inst.setActive(true); return; }
      if (this.activePage?.inst?.active) this.activePage.inst.setActive(false);
      this.activePage = p;
      if (this.markupActive) p.inst?.setActive(true);
      this.updateMarkupButtons();
    }

    setMarkupActive(on){
      // Asked for before the markup has loaded: switch it on once it has.
      if (on && this.mo && !this.readOnly && !this.markupLoaded) { this.pendingMarkup = true; return; }
      if (!on) this.pendingMarkup = false;
      on = !!on && this.canEdit();
      if (on === this.markupActive) return;
      this.markupActive = on;
      this.el.classList.toggle('markup-on', on);
      const toggle = this.dock.querySelector('[data-act="markup"]');
      toggle.setAttribute('aria-pressed', String(on));
      const label = on ? L('pdfv_markup_done', 'Done marking up') : L('pdfv_markup', 'Mark up');
      toggle.setAttribute('aria-label', label);
      toggle.setAttribute('data-fm-tooltip', label);
      toggle.innerHTML = icon(on ? 'fa-check' : 'fa-pen');
      this.updateToolClass();
      if (on) {
        this.setChromeHidden(false);
        root.getSelection?.()?.removeAllRanges?.();
        const p = this.lastEdited || this.pages[this.current - 1];
        this.activePage = null;
        if (p) { this.ensureMarkup(p); this.activatePage(p); }
      } else {
        const active = document.activeElement;
        if (active?.closest?.('.fm-photo-markup-text') && this.el.contains(active)) active.blur();
        this.pages.forEach((p) => { if (p.inst?.active) p.inst.setActive(false); });
        this.activePage = null;
        this.closePopups();
        this.flushSave();
      }
      this.updateMarkupButtons();
      try { this.o.onMarkupToggle?.({ active: on }); } catch (_) {}
    }

    updateToolClass(){
      ['pen', 'arrow', 'text', 'eraser'].forEach((t) => this.el.classList.toggle(`tool-${t}`, this.tool === t));
    }

    setTool(tool){
      if (!['pen', 'arrow', 'text', 'eraser'].includes(tool)) return;
      this.tool = tool;
      this.pages.forEach((p) => { if (p.inst) p.inst.tool = tool; });
      this.dock.querySelectorAll('[data-tool]').forEach((b) => {
        const on = b.dataset.tool === tool;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', String(on));
      });
      this.closePopups();
      this.updateToolClass();
      if (!this.markupActive) this.setMarkupActive(true);
    }

    setSize(value){
      const v = clamp(Number(value) || 1.5, 1, 8);
      this.size = v;
      this.pages.forEach((p) => { if (p.inst) p.inst.size = v; });
      this.updateSizeUi();
    }

    updateSizeUi(){
      this.el.querySelector('.fm-pdf-msize').textContent = `${this.size.toFixed(1)}x`;
      if (Number(this.sizeInput.value) !== this.size) this.sizeInput.value = String(this.size);
      const dot = this.el.querySelector('.fm-pdf-msize-dot i');
      const px = Math.round(4 + (this.size - 1) * (20 / 7));
      dot.style.width = dot.style.height = `${px}px`;
      dot.parentElement.style.color = this.color;
    }

    setColor(value){
      const c = normalizeHex(value);
      if (!c) return;
      this.color = c;
      this.pages.forEach((p) => { if (p.inst) p.inst.color = c; });
      const inst = this.activePage?.inst;
      if (inst?.setColor) inst.setColor(c); // also colours selected text in a text box and remembers the colour
      else this.Markup?.rememberMarkupColor?.(c);
      this.updateColorUi();
      if (this.colorPop.classList.contains('is-open') && !document.activeElement?.matches?.('input[type="color"]')) this.renderPalette();
    }

    updateColorUi(){
      this.el.querySelector('.fm-pdf-mswatch').style.background = this.color;
      const dot = this.el.querySelector('.fm-pdf-msize-dot');
      if (dot) dot.style.color = this.color;
      this.colorPop.querySelectorAll('[data-markup-color]').forEach((b) => b.classList.toggle('is-selected', b.dataset.markupColor === this.color));
    }

    renderPalette(){
      if (!this.Markup?.markupColorPaletteHtml) return;
      this.colorPop.innerHTML = this.Markup.markupColorPaletteHtml(this.color);
      this.updateColorUi();
    }

    editPage(){ return this.lastEdited || this.pages[this.current - 1] || null; }

    updateMarkupButtons(){
      if (!this.dock || this.dock.hidden) return;
      const inst = this.editPage()?.inst;
      const undo = this.dock.querySelector('[data-act="undo"]');
      const redo = this.dock.querySelector('[data-act="redo"]');
      const clear = this.dock.querySelector('[data-act="clear"]');
      undo.disabled = !(inst && inst.historyIndex > 0);
      redo.disabled = !(inst && inst.historyIndex >= 0 && inst.historyIndex < inst.history.length - 1);
      const cur = this.pages[this.current - 1];
      clear.disabled = !(cur?.inst?.items?.length || cur?.items?.length);
    }

    undo(){
      const p = this.editPage();
      if (p?.inst?.undo?.()) this.lastEdited = p;
      this.updateMarkupButtons();
    }

    redo(){
      const p = this.editPage();
      if (p?.inst?.redo?.()) this.lastEdited = p;
      this.updateMarkupButtons();
    }

    async clearPage(){
      const p = this.pages[this.current - 1];
      if (!p) return;
      this.ensureMarkup(p);
      const inst = p.inst;
      if (!inst || !inst.items.length) return;
      const message = L('pdfv_clear_confirm', 'Clear all markup from page {page}?', { page: p.n });
      const confirmed = await (root.PlatformUI?.confirm?.(message, { title: L('pdfv_clear_title', 'Clear page'), okLabel: L('pdfv_clear_ok', 'Clear'), danger: true }) || root.confirm(message));
      if (!confirmed || this.destroyed) return;
      inst.items = [];
      inst.renderLayer();
      inst.pushHistory();
      inst.emitChange();
      this.lastEdited = p;
      this.updateMarkupButtons();
    }

    markupMap(){
      const out = {};
      this.pages.forEach((p) => { if (p.items.length || p.touched || p.hadItems) out[p.n] = cloneItems(p.items); });
      return out;
    }

    scheduleSave(){
      if (typeof this.mo?.save !== 'function') return;
      this.dirty = true;
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.flushSave(), 300);
    }

    flushSave(){
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      if (!this.dirty || typeof this.mo?.save !== 'function') return this.saveChain;
      this.dirty = false;
      const pages = this.markupMap();
      // Saves run in order; each sends every page, so a failed save is repaired by the next one.
      this.saveChain = this.saveChain.then(() => this.mo.save(pages)).catch((error) => {
        console.warn('[FirstMatePdf] markup save failed', error);
      });
      return this.saveChain;
    }

    // ---- Download ----
    downloadName(marked){
      let name = String(this.o.fileName || '').trim();
      if (!name && this.o.url) {
        try { name = decodeURIComponent(new URL(this.o.url, location.href).pathname.split('/').pop() || ''); } catch (_) {}
      }
      name = name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() || 'document.pdf';
      const base = name.replace(/\.pdf$/i, '') || 'document';
      return `${base}${marked ? '-markup' : ''}.pdf`;
    }

    async exportPdf({ withMarkup = false } = {}){
      await this.ready;
      const bytes = await this.pdf.getData();
      const marked = withMarkup ? this.pages.filter((p) => p.items.length) : [];
      if (!marked.length) return new Blob([bytes], { type: 'application/pdf' });
      const PDFLib = await loadScript(config.pdfLibSrc, 'PDFLib');
      let doc;
      try { doc = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false }); }
      catch (error) {
        const encrypted = /encrypt/i.test(String(error?.message || error?.name || ''));
        throw codedError(encrypted ? 'encrypted' : 'export', encrypted
          ? L('pdfv_err_export_encrypted', 'This PDF is protected, so markup can’t be added to a download.')
          : L('pdfv_err_export', 'The marked-up PDF could not be made.'), error);
      }
      const docPages = doc.getPages();
      for (const p of marked) {
        const page = docPages[p.n - 1];
        if (!page) continue;
        const box = page.getCropBox();
        const rot = (((page.getRotation()?.angle || 0) % 360) + 360) % 360;
        const visW = rot % 180 ? box.height : box.width;
        const visH = rot % 180 ? box.width : box.height;
        const k = Math.min(2, 4096 / Math.max(visW, visH));
        const png = await doc.embedPng(await markupPng(p.items, visW * k, visH * k));
        // The markup was drawn over the page as it is shown (after /Rotate); place it in the
        // page's own unrotated space so it lands on the same spot.
        const origin = {
          0: [box.x, box.y],
          90: [box.x + box.width, box.y],
          180: [box.x + box.width, box.y + box.height],
          270: [box.x, box.y + box.height]
        }[rot] || [box.x, box.y];
        page.drawImage(png, { x: origin[0], y: origin[1], width: visW, height: visH, rotate: PDFLib.degrees(rot) });
      }
      const out = await doc.save();
      return new Blob([out], { type: 'application/pdf' });
    }

    async download({ withMarkup = false } = {}){
      if (withMarkup) await this.flushSave();
      const marked = !!withMarkup && this.pages.some((p) => p.items.length);
      const blob = await this.exportPdf({ withMarkup: marked });
      const fileName = this.downloadName(marked);
      saveBlob(blob, fileName);
      return { blob, fileName };
    }

    // ---- Teardown ----
    destroy(){
      if (this.destroyed) return this.saveChain;
      const pending = this.flushSave();
      this.destroyed = true;
      this.cleanups.forEach((fn) => { try { fn(); } catch (_) {} });
      this.cleanups = [];
      [this.nearIO, this.keepIO, this.thumbIO, this.ro].forEach((o) => { try { o?.disconnect(); } catch (_) {} });
      [this.settleTimer, this.navTimer, this.stateTimer, this.saveTimer].forEach((t) => clearTimeout(t));
      [this.resizeRaf, this.scrollRaf, this.wheelRaf].forEach((r) => r && cancelAnimationFrame(r));
      this.pages.forEach((p) => {
        try { p.renderTask?.cancel(); } catch (_) {}
        try { p.textTask?.cancel(); } catch (_) {}
        try { p.inst?.setActive?.(false); p.inst?.destroy?.(); } catch (_) {}
        p.inst = null;
        freeCanvas(p.canvas);
        freeCanvas(p.thumb?.querySelector('canvas'));
      });
      try { this.loadingTask?.destroy?.(); } catch (_) {}
      this.el.remove();
      if (this.hostPosition !== undefined) this.host.style.position = this.hostPosition;
      return pending;
    }
  }

  function freeCanvas(canvas){
    if (!canvas) return;
    try { canvas.width = 0; canvas.height = 0; } catch (_) {}
  }

  function mount(host, options = {}){
    if (!host || host.nodeType !== 1) throw new TypeError('FirstMatePdf.mount needs a host element.');
    const v = new Viewer(host, options || {});
    return {
      get ready(){ return v.ready; },
      get page(){ return v.current; },
      get pageCount(){ return v.pages.length; },
      get zoom(){ return v.zoom; },
      get zoomMode(){ return v.zoomMode; },
      get markupActive(){ return v.markupActive; },
      get element(){ return v.el; },
      setPage(n, opts){ return v.goTo(n, opts); },
      next(){ return v.goTo(v.current + 1, { smooth: true }); },
      prev(){ return v.goTo(v.current - 1, { smooth: true }); },
      zoomIn(){ v.zoomStep(1); },
      zoomOut(){ v.zoomStep(-1); },
      setZoom(mode){ v.setZoom(mode); },
      setMarkupActive(on){ v.setMarkupActive(on); },
      setThumbnails(open){ v.toggleRail(open); },
      setInsets({ top } = {}){
        v.o.insetTop = Number(top) || 0;
        v.el.style.setProperty('--fm-pdf-inset-top', `${v.o.insetTop}px`);
        v.onResize();
      },
      getMarkup(){ return v.markupMap(); },
      flush(){ return v.flushSave(); },
      exportPdf(opts){ return v.exportPdf(opts); },
      download(opts){ return v.download(opts); },
      resize(){ v.onResize(); },
      destroy(){ return v.destroy(); }
    };
  }

  root.FirstMatePdf = {
    version: VERSION,
    config,
    load(){ return loadPdfjs().then(() => undefined); },
    mount
  };
})();
