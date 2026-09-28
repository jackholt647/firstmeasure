/* libraries/video-editor/firstmate-video-editor.js
 * Lightweight in-browser video editing suite for FirstMate surfaces.
 *
 * Companion to firstmate-markup.js: where photos get the markup dock, videos
 * get this editor. Everything runs client side — frames are composited onto a
 * canvas (trim, crop, rotate, flip, speed, text overlays) and re-encoded with
 * MediaRecorder, so no server transcoding is required. The edited clip is
 * handed back to the caller as a File via onSave.
 *
 *   window.FirstMateVideoEditor.open({
 *     src,                  // playable same-origin video URL
 *     title,                // header label
 *     fileName,             // basis for the exported file name
 *     saveLabel,            // primary button label (default 'Save as New Video')
 *     onSave(file, meta),   // required to persist; may return a promise
 *     onClose()
 *   })
 */
(function(){
  const root = window;
  const STYLE_ID = 'fm-video-editor-styles';
  const SPEED_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const TEXT_COLORS = ['#ffffff', '#111111', '#d93025', '#2563eb', '#15803d', '#fbbc04'];
  const CROP_PRESETS = [
    { id: 'free', label: (globalThis.PlatformLanguage?.text("video-editor","m_6ddc97e52c9c21","Free") ?? "Free"), ratio: 0 },
    { id: 'original', label: (globalThis.PlatformLanguage?.text("video-editor","m_5728aab06eec45","Full") ?? "Full"), ratio: -1 },
    { id: '16_9', label: '16:9', ratio: 16 / 9 },
    { id: '9_16', label: '9:16', ratio: 9 / 16 },
    { id: '1_1', label: '1:1', ratio: 1 },
    { id: '4_3', label: '4:3', ratio: 4 / 3 }
  ];
  const MAX_OUTPUT_DIMENSION = 1920;
  const EXPORT_FPS = 30;

  function cleanText(value){ return String(value ?? '').trim(); }
  function escapeHtml(value){
    return cleanText(value).replace(/[&<>"']/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
  }
  function clamp(value, min, max){ return Math.max(min, Math.min(max, value)); }
  function uid(prefix = 've'){ return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`; }
  function formatClock(seconds){
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }
  function formatPrecise(seconds){
    const value = Math.max(0, Number(seconds) || 0);
    const mins = Math.floor(value / 60);
    const secs = value - mins * 60;
    return `${mins}:${secs.toFixed(1).padStart(4, '0')}`;
  }
  function evenDimension(value){
    const rounded = Math.max(2, Math.round(value));
    return rounded % 2 === 0 ? rounded : rounded - 1;
  }
  function pickRecorderMimeType(){
    if (typeof root.MediaRecorder === 'undefined') return '';
    const candidates = [
      'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
      'video/mp4;codecs=avc1',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm'
    ];
    return candidates.find((type) => {
      try { return root.MediaRecorder.isTypeSupported(type); } catch (_) { return false; }
    }) || '';
  }
  function extensionForMime(mime){
    return cleanText(mime).toLowerCase().includes('mp4') ? 'mp4' : 'webm';
  }
  function safeFileBase(value){
    const base = cleanText(value)
      .replace(/\.[a-z0-9]{2,5}$/i, '')
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    return base || 'video';
  }

  function injectStyles(){
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .fm-video-editor{position:fixed;inset:0;z-index:4200;background:rgba(9,12,20,.94);backdrop-filter:blur(6px);display:flex;flex-direction:column;color:#f8fafc;font-family:inherit}
      .fm-video-editor *{box-sizing:border-box}
      .fm-video-editor-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 18px;border-bottom:1px solid rgba(255,255,255,.08)}
      .fm-video-editor-head strong{font-size:15px;font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
      .fm-video-editor-head-actions{display:flex;align-items:center;gap:8px;flex:0 0 auto}
      .fm-video-editor-iconbtn{width:36px;height:36px;border-radius:999px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#f8fafc;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:14px}
      .fm-video-editor-iconbtn:hover{background:rgba(255,255,255,.14)}
      .fm-video-editor-stage{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:18px;position:relative}
      .fm-video-editor-frame{position:relative;display:inline-block;max-width:100%;max-height:100%}
      .fm-video-editor-frame canvas{display:block;background:#000;border-radius:10px;box-shadow:0 18px 60px rgba(0,0,0,.5)}
      .fm-video-editor-overlay{position:absolute;inset:0;border-radius:10px;overflow:hidden}
      .fm-video-editor-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:10px;font-weight:800;color:#cbd5e1}
      .fm-video-editor-text-handle{position:absolute;transform:translate(-50%,-50%);cursor:grab;border:1.5px dashed transparent;border-radius:6px;padding:2px 6px;touch-action:none;user-select:none}
      .fm-video-editor-text-handle.selected{border-color:rgba(255,255,255,.85);background:rgba(15,23,42,.18)}
      .fm-video-editor-text-handle:active{cursor:grabbing}
      .fm-video-editor-crop{position:absolute;border:1.5px solid #fff;box-shadow:0 0 0 9999px rgba(2,6,14,.62);cursor:move;touch-action:none}
      .fm-video-editor-crop::before{content:'';position:absolute;inset:0;background:
        linear-gradient(rgba(255,255,255,.28),rgba(255,255,255,.28)) 33.33% 0/1px 100% no-repeat,
        linear-gradient(rgba(255,255,255,.28),rgba(255,255,255,.28)) 66.66% 0/1px 100% no-repeat,
        linear-gradient(rgba(255,255,255,.28),rgba(255,255,255,.28)) 0 33.33%/100% 1px no-repeat,
        linear-gradient(rgba(255,255,255,.28),rgba(255,255,255,.28)) 0 66.66%/100% 1px no-repeat}
      .fm-video-editor-crop-handle{position:absolute;width:14px;height:14px;background:#fff;border-radius:3px;box-shadow:0 1px 4px rgba(0,0,0,.45);touch-action:none}
      .fm-video-editor-crop-handle[data-crop-handle="nw"]{top:-7px;left:-7px;cursor:nwse-resize}
      .fm-video-editor-crop-handle[data-crop-handle="ne"]{top:-7px;right:-7px;cursor:nesw-resize}
      .fm-video-editor-crop-handle[data-crop-handle="sw"]{bottom:-7px;left:-7px;cursor:nesw-resize}
      .fm-video-editor-crop-handle[data-crop-handle="se"]{bottom:-7px;right:-7px;cursor:nwse-resize}
      .fm-video-editor-crop-handle[data-crop-handle="n"]{top:-7px;left:50%;margin-left:-7px;cursor:ns-resize}
      .fm-video-editor-crop-handle[data-crop-handle="s"]{bottom:-7px;left:50%;margin-left:-7px;cursor:ns-resize}
      .fm-video-editor-crop-handle[data-crop-handle="w"]{left:-7px;top:50%;margin-top:-7px;cursor:ew-resize}
      .fm-video-editor-crop-handle[data-crop-handle="e"]{right:-7px;top:50%;margin-top:-7px;cursor:ew-resize}
      .fm-video-editor-panel{flex:0 0 auto;border-top:1px solid rgba(255,255,255,.08);padding:10px 18px 14px;display:flex;flex-direction:column;gap:10px}
      .fm-video-editor-tools{display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap}
      .fm-video-editor-tool{height:38px;min-width:38px;padding:0 12px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#e2e8f0;font-weight:850;font-size:12.5px;cursor:pointer;display:inline-flex;align-items:center;gap:7px;white-space:nowrap}
      .fm-video-editor-tool i{font-size:13px}
      .fm-video-editor-tool:hover{background:rgba(255,255,255,.12)}
      .fm-video-editor-tool.active{background:var(--primary,#2563eb);border-color:var(--primary,#2563eb);color:#fff}
      .fm-video-editor-tool:disabled{opacity:.45;cursor:default}
      .fm-video-editor-subbar{display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;min-height:0}
      .fm-video-editor-subbar[hidden]{display:none}
      .fm-video-editor-chip{height:30px;padding:0 12px;border-radius:999px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.05);color:#e2e8f0;font-weight:850;font-size:12px;cursor:pointer}
      .fm-video-editor-chip.active{background:#fff;color:#0f172a;border-color:#fff}
      .fm-video-editor-subbar input[type=range]{accent-color:var(--primary,#2563eb)}
      .fm-video-editor-subbar label{font-size:12px;font-weight:800;color:#94a3b8;display:inline-flex;align-items:center;gap:8px}
      .fm-video-editor-text-input{height:32px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#fff;padding:0 10px;font-size:13px;font-weight:700;min-width:200px;outline:none}
      .fm-video-editor-swatch{width:24px;height:24px;border-radius:999px;border:2px solid transparent;cursor:pointer;padding:0}
      .fm-video-editor-swatch.active{border-color:#fff;box-shadow:0 0 0 2px rgba(255,255,255,.35)}
      .fm-video-editor-timeline{display:flex;align-items:center;gap:12px}
      .fm-video-editor-play{width:40px;height:40px;flex:0 0 auto;border-radius:999px;border:0;background:#fff;color:#0f172a;font-size:14px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
      .fm-video-editor-time{flex:0 0 auto;font-size:12px;font-weight:850;color:#94a3b8;font-variant-numeric:tabular-nums;min-width:74px;text-align:center}
      .fm-video-editor-track{position:relative;flex:1;height:52px;border-radius:10px;background:#1e293b;overflow:hidden;touch-action:none;cursor:pointer}
      .fm-video-editor-track canvas{position:absolute;inset:0;width:100%;height:100%}
      .fm-video-editor-trim-shade{position:absolute;top:0;bottom:0;background:rgba(2,6,14,.72);pointer-events:none}
      .fm-video-editor-trim-window{position:absolute;top:0;bottom:0;border:2px solid #fff;border-left-width:9px;border-right-width:9px;border-radius:8px;pointer-events:none}
      .fm-video-editor-trim-handle{position:absolute;top:0;bottom:0;width:22px;margin-left:-11px;cursor:ew-resize;touch-action:none;display:flex;align-items:center;justify-content:center}
      .fm-video-editor-trim-handle::after{content:'';width:3px;height:18px;border-radius:2px;background:#0f172a;opacity:.75}
      .fm-video-editor-playhead{position:absolute;top:0;bottom:0;width:2px;background:var(--primary,#2563eb);box-shadow:0 0 0 1px rgba(255,255,255,.4);pointer-events:none}
      .fm-video-editor-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
      .fm-video-editor-hint{font-size:12px;font-weight:750;color:#64748b;min-width:0}
      .fm-video-editor-foot-actions{display:flex;align-items:center;gap:10px;margin-left:auto}
      .fm-video-editor-btn{height:38px;padding:0 16px;border-radius:10px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:#e2e8f0;font-weight:900;font-size:13px;cursor:pointer;display:inline-flex;align-items:center;gap:8px}
      .fm-video-editor-btn:hover{background:rgba(255,255,255,.12)}
      .fm-video-editor-btn.primary{background:var(--primary,#2563eb);border-color:var(--primary,#2563eb);color:#fff}
      .fm-video-editor-btn.primary:hover{filter:brightness(1.08)}
      .fm-video-editor-btn:disabled{opacity:.55;cursor:default}
      .fm-video-editor-export{position:absolute;inset:0;z-index:5;background:rgba(9,12,20,.9);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
      .fm-video-editor-export strong{font-size:15px;font-weight:900}
      .fm-video-editor-export span{font-size:12.5px;font-weight:800;color:#94a3b8}
      .fm-video-editor-progress{width:min(340px,72vw);height:8px;border-radius:999px;background:rgba(255,255,255,.12);overflow:hidden}
      .fm-video-editor-progress i{display:block;height:100%;width:0;border-radius:999px;background:var(--primary,#2563eb);transition:width .18s linear}
      @media(max-width:720px){
        .fm-video-editor-stage{padding:10px}
        .fm-video-editor-panel{padding:8px 10px 12px}
        .fm-video-editor-tool{padding:0 9px;font-size:12px}
        .fm-video-editor-tool span{display:none}
        .fm-video-editor-time{display:none}
      }
    `;
    document.head.appendChild(style);
  }

  class VideoEditor {
    constructor(options = {}){
      this.options = options || {};
      this.src = cleanText(options.src);
      this.title = cleanText(options.title) || 'Edit Video';
      this.fileName = cleanText(options.fileName) || this.title;
      this.onSave = typeof options.onSave === 'function' ? options.onSave : null;
      this.onClose = typeof options.onClose === 'function' ? options.onClose : null;
      this.saveLabel = cleanText(options.saveLabel) || 'Save as New Video';

      this.state = {
        ready: false,
        duration: 0,
        trimStart: 0,
        trimEnd: 0,
        rotation: 0,
        flip: false,
        speed: 1,
        muted: false,
        volume: 1,
        crop: { x: 0, y: 0, w: 1, h: 1 },
        cropPreset: 'free',
        texts: [],
        selectedTextId: '',
        activeTool: '',
        exporting: false,
        saving: false
      };
      this.previewFrame = 0;
      this.exportAbort = null;
      this.destroyed = false;
      // Resolved in prepareSource(): a locally-held blob URL. Editing needs
      // frame-accurate seeking, and the media API serves files without
      // Accept-Ranges, which leaves a streamed <video> with an empty
      // `seekable` range (every seek snaps back to 0 and exports come out
      // empty). Buffering the bytes ourselves sidesteps that entirely and
      // also keeps the canvas untainted for cross-origin sources.
      this.playbackSrc = '';
      this.objectUrl = '';

      injectStyles();
      this.render();
      this.loadVideo();
    }

    /* ------------------------------------------------------------------ */
    /* Geometry helpers                                                    */

    rotatedSize(){
      const w = this.video?.videoWidth || 16;
      const h = this.video?.videoHeight || 9;
      return (this.state.rotation % 180 === 90) ? { w: h, h: w } : { w, h };
    }
    outputSize(){
      const rotated = this.rotatedSize();
      const crop = this.state.crop;
      let w = rotated.w * crop.w;
      let h = rotated.h * crop.h;
      const largest = Math.max(w, h);
      if (largest > MAX_OUTPUT_DIMENSION) {
        const scale = MAX_OUTPUT_DIMENSION / largest;
        w *= scale;
        h *= scale;
      }
      return { w: evenDimension(w), h: evenDimension(h) };
    }
    trimRange(){
      const start = clamp(this.state.trimStart, 0, this.state.duration);
      const end = clamp(this.state.trimEnd || this.state.duration, start + 0.05, this.state.duration);
      return { start, end, length: Math.max(0.05, end - start) };
    }
    hasEdits(){
      const { start, end } = this.trimRange();
      const crop = this.state.crop;
      return start > 0.01
        || end < this.state.duration - 0.01
        || this.state.rotation !== 0
        || this.state.flip
        || this.state.speed !== 1
        || this.state.muted
        || this.state.volume < 0.99
        || crop.x > 0.001 || crop.y > 0.001 || crop.w < 0.999 || crop.h < 0.999
        || this.state.texts.length > 0;
    }

    /* ------------------------------------------------------------------ */
    /* Shell                                                               */

    render(){
      this.el = document.createElement('div');
      this.el.className = 'fm-video-editor';
      this.el.innerHTML = `
        <div class="fm-video-editor-head">
          <strong title="${String(escapeHtml(this.title))}"><i class="fas fa-clapperboard" style="margin-right:8px;color:#94a3b8"></i>${String(escapeHtml(this.title))}</strong>
          <div class="fm-video-editor-head-actions">
            <button type="button" class="fm-video-editor-iconbtn" data-ve-reset data-fm-tooltip="Reset all edits"><i class="fas fa-rotate-left"></i></button>
            <button type="button" class="fm-video-editor-iconbtn" data-ve-close aria-label="${(globalThis.PlatformLanguage?.htmlText("video-editor","m_031b2e8c9c1d7f","Close editor") ?? "Close editor")}"><i class="fas fa-times"></i></button>
          </div>
        </div>
        <div class="fm-video-editor-stage" data-ve-stage>
          <div class="fm-video-editor-frame" data-ve-frame>
            <canvas data-ve-canvas></canvas>
            <div class="fm-video-editor-overlay" data-ve-overlay></div>
          </div>
          <div class="fm-video-editor-loading" data-ve-loading><i class="fas fa-circle-notch fa-spin"></i>${(globalThis.PlatformLanguage?.htmlText("video-editor","m_9436da07c68314"," Loading video…") ?? " Loading video…")}</div>
        </div>
        <div class="fm-video-editor-panel">
          <div class="fm-video-editor-subbar" data-ve-subbar hidden></div>
          <div class="fm-video-editor-tools">
            <button type="button" class="fm-video-editor-tool" data-ve-tool="crop"><i class="fas fa-crop-simple"></i><span>${(globalThis.PlatformLanguage?.htmlText("video-editor","m_6d84414c70b27c","Crop") ?? "Crop")}</span></button>
            <button type="button" class="fm-video-editor-tool" data-ve-rotate><i class="fas fa-rotate-right"></i><span>${(globalThis.PlatformLanguage?.htmlText("video-editor","m_fc42f4452e070c","Rotate") ?? "Rotate")}</span></button>
            <button type="button" class="fm-video-editor-tool" data-ve-flip><i class="fas fa-left-right"></i><span>${(globalThis.PlatformLanguage?.htmlText("video-editor","m_a27e7d67c060b4","Flip") ?? "Flip")}</span></button>
            <button type="button" class="fm-video-editor-tool" data-ve-tool="speed"><i class="fas fa-gauge-high"></i><span data-ve-speed-label>1x</span></button>
            <button type="button" class="fm-video-editor-tool" data-ve-tool="volume"><i class="fas fa-volume-high" data-ve-volume-icon></i><span>${(globalThis.PlatformLanguage?.htmlText("video-editor","m_c28ec04f0667fb","Audio") ?? "Audio")}</span></button>
            <button type="button" class="fm-video-editor-tool" data-ve-add-text><i class="fas fa-font"></i><span>${(globalThis.PlatformLanguage?.htmlText("video-editor","m_124287f184b88b","Text") ?? "Text")}</span></button>
          </div>
          <div class="fm-video-editor-timeline">
            <button type="button" class="fm-video-editor-play" data-ve-play aria-label="${(globalThis.PlatformLanguage?.htmlText("video-editor","m_c997552a7cb8dd","Play or pause") ?? "Play or pause")}"><i class="fas fa-play"></i></button>
            <div class="fm-video-editor-time" data-ve-time>0:00 / 0:00</div>
            <div class="fm-video-editor-track" data-ve-track>
              <canvas data-ve-filmstrip></canvas>
              <div class="fm-video-editor-trim-shade" data-ve-shade-left></div>
              <div class="fm-video-editor-trim-shade" data-ve-shade-right></div>
              <div class="fm-video-editor-trim-window" data-ve-trim-window></div>
              <div class="fm-video-editor-trim-handle" data-ve-trim="start"></div>
              <div class="fm-video-editor-trim-handle" data-ve-trim="end"></div>
              <div class="fm-video-editor-playhead" data-ve-playhead></div>
            </div>
          </div>
          <div class="fm-video-editor-foot">
            <div class="fm-video-editor-hint" data-ve-hint>${(globalThis.PlatformLanguage?.htmlText("video-editor","m_8d18ba0d495cb2","Drag the white handles to trim. Add text, crop, rotate, or change speed, then save as a new clip.") ?? "Drag the white handles to trim. Add text, crop, rotate, or change speed, then save as a new clip.")}</div>
            <div class="fm-video-editor-foot-actions">
              <button type="button" class="fm-video-editor-btn" data-ve-cancel>${(globalThis.PlatformLanguage?.htmlText("video-editor","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button>
              <button type="button" class="fm-video-editor-btn primary" data-ve-save><i class="fas fa-floppy-disk"></i> ${String(escapeHtml(this.saveLabel))}</button>
            </div>
          </div>
        </div>`;
      document.body.appendChild(this.el);

      this.canvas = this.el.querySelector('[data-ve-canvas]');
      this.ctx = this.canvas.getContext('2d');
      this.overlay = this.el.querySelector('[data-ve-overlay]');
      this.subbar = this.el.querySelector('[data-ve-subbar]');

      this.el.querySelector('[data-ve-close]').addEventListener('click', () => this.requestClose());
      this.el.querySelector('[data-ve-cancel]').addEventListener('click', () => this.requestClose());
      this.el.querySelector('[data-ve-reset]').addEventListener('click', () => this.resetEdits());
      this.el.querySelector('[data-ve-save]').addEventListener('click', () => this.save());
      this.el.querySelector('[data-ve-play]').addEventListener('click', () => this.togglePlay());
      this.el.querySelector('[data-ve-rotate]').addEventListener('click', () => {
        this.state.rotation = (this.state.rotation + 90) % 360;
        this.state.crop = { x: 0, y: 0, w: 1, h: 1 };
        this.syncLayout();
      });
      this.el.querySelector('[data-ve-flip]').addEventListener('click', () => {
        this.state.flip = !this.state.flip;
      });
      this.el.querySelector('[data-ve-add-text]').addEventListener('click', () => this.addText());
      this.el.querySelectorAll('[data-ve-tool]').forEach((btn) => {
        btn.addEventListener('click', () => this.setTool(this.state.activeTool === btn.dataset.veTool ? '' : btn.dataset.veTool));
      });

      this.bindTimeline();

      this.keyHandler = (event) => {
        if (this.modalHandle && !this.modalHandle.isTop?.()) return;
        if (event.target?.closest?.('input,textarea,[contenteditable="true"]')) return;
        if (event.key === ' ') {
          event.preventDefault();
          this.togglePlay();
        } else if ((event.key === 'Delete' || event.key === 'Backspace') && this.state.selectedTextId) {
          event.preventDefault();
          this.removeText(this.state.selectedTextId);
        }
      };
      window.addEventListener('keydown', this.keyHandler);
      this.boundResize = () => this.syncLayout();
      window.addEventListener('resize', this.boundResize);

      this.modalHandle = root.Portal?.modals?.register?.(this.el, {
        id: 'video-editor',
        closeOnEscape: true,
        closeOnBackdrop: false,
        onClose: () => this.requestClose()
      }) || null;
    }

    /* ------------------------------------------------------------------ */
    /* Video loading + preview loop                                        */

    setLoadingMessage(html){
      const loading = this.el?.querySelector?.('[data-ve-loading]');
      if (loading) loading.innerHTML = html;
    }

    /* True when the URL can be scrubbed as a stream (server honours ranges).
     * Verified with a real seek rather than trusting `seekable`, because that
     * is the only signal that reflects what export will actually be able to do. */
    streamIsSeekable(){
      return new Promise((resolve) => {
        const probe = document.createElement('video');
        probe.preload = 'metadata';
        probe.muted = true;
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          probe.removeAttribute('src');
          probe.load();
          resolve(value);
        };
        const timer = setTimeout(() => finish(false), 8000);
        probe.addEventListener('error', () => {
          clearTimeout(timer);
          finish(false);
        }, { once: true });
        probe.addEventListener('loadedmetadata', () => {
          const duration = Number(probe.duration);
          if (!Number.isFinite(duration) || duration <= 0) {
            clearTimeout(timer);
            finish(false);
            return;
          }
          const target = Math.min(0.75, duration / 2);
          probe.addEventListener('seeked', () => {
            clearTimeout(timer);
            finish(Math.abs(probe.currentTime - target) < 0.35);
          }, { once: true });
          try { probe.currentTime = target; } catch (_) {
            clearTimeout(timer);
            finish(false);
          }
        }, { once: true });
        probe.src = this.src;
        probe.load();
      });
    }

    async prepareSource(){
      if (/^blob:|^data:/i.test(this.src)) return this.src;
      // Stream directly when the server supports ranges — buffering a large
      // clip into memory is only worth it when scrubbing would otherwise fail.
      if (await this.streamIsSeekable()) return this.src;
      if (this.destroyed) return '';
      this.setLoadingMessage('<i class="fas fa-circle-notch fa-spin"></i> Loading video…');
      try {
        const response = await fetch(this.src, { credentials: 'include' });
        if (!response.ok) throw new Error(`Could not download the video (${response.status})`);
        const total = Number(response.headers.get('content-length') || 0);
        let blob;
        if (response.body && total > 0) {
          const reader = response.body.getReader();
          const parts = [];
          let received = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (this.destroyed) {
              reader.cancel().catch(() => null);
              return '';
            }
            parts.push(value);
            received += value.length;
            this.setLoadingMessage(`<i class="fas fa-circle-notch fa-spin"></i> Loading video… ${Math.round((received / total) * 100)}%`);
          }
          blob = new Blob(parts, { type: response.headers.get('content-type') || 'video/mp4' });
        } else {
          blob = await response.blob();
        }
        this.objectUrl = URL.createObjectURL(blob);
        return this.objectUrl;
      } catch (_) {
        // Fall back to streaming straight from the URL. Trimming and export
        // may be limited if the server cannot serve ranges, but playback works.
        return this.src;
      }
    }

    async loadVideo(){
      const fail = () => {
        if (this.destroyed) return;
        this.setLoadingMessage('<i class="fas fa-triangle-exclamation"></i> Could not load this video.');
      };
      const playbackSrc = await this.prepareSource();
      if (this.destroyed) return;
      if (!playbackSrc) return fail();
      this.playbackSrc = playbackSrc;
      this.video = document.createElement('video');
      this.video.preload = 'auto';
      this.video.playsInline = true;
      this.video.muted = false;
      this.video.src = playbackSrc;
      this.video.addEventListener('error', fail);
      this.video.addEventListener('loadedmetadata', async () => {
        if (this.destroyed) return;
        let duration = Number(this.video.duration);
        if (!Number.isFinite(duration) || duration <= 0) {
          // MediaRecorder-produced WebM (including this editor's own output)
          // reports Infinity until forced to scan: seek far past the end.
          duration = await new Promise((resolve) => {
            const timer = setTimeout(() => resolve(NaN), 4000);
            const check = () => {
              const value = Number(this.video.duration);
              if (Number.isFinite(value) && value > 0) {
                clearTimeout(timer);
                this.video.removeEventListener('durationchange', check);
                resolve(value);
              }
            };
            this.video.addEventListener('durationchange', check);
            try { this.video.currentTime = 1e7; } catch (_) { clearTimeout(timer); resolve(NaN); }
          });
          if (this.destroyed) return;
        }
        if (!Number.isFinite(duration) || duration <= 0) return fail();
        this.state.duration = duration;
        this.state.trimEnd = duration;
        this.state.ready = true;
        this.el.querySelector('[data-ve-loading]')?.remove();
        this.video.currentTime = 0;
        this.syncLayout();
        this.startPreviewLoop();
        this.buildFilmstrip();
      });
      this.video.addEventListener('timeupdate', () => {
        if (this.state.exporting) return;
        const { start, end } = this.trimRange();
        if (this.video.currentTime >= end - 0.02) {
          this.video.pause();
          this.video.currentTime = start;
          this.updatePlayButton();
        }
      });
      this.video.addEventListener('play', () => this.updatePlayButton());
      this.video.addEventListener('pause', () => this.updatePlayButton());
      this.video.load();
    }

    startPreviewLoop(){
      const tick = () => {
        if (this.destroyed) return;
        if (!this.state.exporting) {
          this.drawFrame(this.ctx, this.canvas.width, this.canvas.height, this.video, { ignoreCrop: this.state.activeTool === 'crop' });
          this.updateTimelineIndicators();
        }
        this.previewFrame = requestAnimationFrame(tick);
      };
      this.previewFrame = requestAnimationFrame(tick);
    }

    drawFrame(ctx, outW, outH, videoEl = this.video, options = {}){
      if (!videoEl || videoEl.readyState < 2) return;
      const vw = videoEl.videoWidth;
      const vh = videoEl.videoHeight;
      if (!vw || !vh) return;
      const rotated = this.rotatedSize();
      const crop = options.ignoreCrop ? { x: 0, y: 0, w: 1, h: 1 } : this.state.crop;
      const cropX = crop.x * rotated.w;
      const cropY = crop.y * rotated.h;
      const cropW = Math.max(1, crop.w * rotated.w);
      const cropH = Math.max(1, crop.h * rotated.h);
      const scale = Math.min(outW / cropW, outH / cropH);

      ctx.save();
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, outW, outH);
      ctx.scale(scale, scale);
      ctx.translate(-cropX, -cropY);
      ctx.translate(rotated.w / 2, rotated.h / 2);
      ctx.rotate((this.state.rotation * Math.PI) / 180);
      if (this.state.flip) ctx.scale(-1, 1);
      ctx.drawImage(videoEl, -vw / 2, -vh / 2, vw, vh);
      ctx.restore();

      if (options.ignoreCrop) return;
      this.state.texts.forEach((text) => {
        const fontSize = Math.max(10, text.size * outH);
        ctx.save();
        ctx.font = `900 ${fontSize}px 'Inter','Segoe UI',Arial,sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(2, fontSize * 0.12);
        ctx.strokeStyle = 'rgba(0,0,0,.55)';
        const x = text.x * outW;
        const y = text.y * outH;
        ctx.strokeText(text.text, x, y);
        ctx.fillStyle = text.color;
        ctx.fillText(text.text, x, y);
        ctx.restore();
      });
    }

    syncLayout(){
      if (!this.state.ready || this.destroyed) return;
      // While the crop tool is active the canvas previews the FULL rotated
      // frame (so the crop window can be dragged outward again); otherwise it
      // previews the final cropped output.
      const cropping = this.state.activeTool === 'crop';
      const out = cropping ? (() => {
        const rotated = this.rotatedSize();
        const largest = Math.max(rotated.w, rotated.h);
        const scale = largest > MAX_OUTPUT_DIMENSION ? MAX_OUTPUT_DIMENSION / largest : 1;
        return { w: evenDimension(rotated.w * scale), h: evenDimension(rotated.h * scale) };
      })() : this.outputSize();
      if (this.canvas.width !== out.w) this.canvas.width = out.w;
      if (this.canvas.height !== out.h) this.canvas.height = out.h;
      const stage = this.el.querySelector('[data-ve-stage]');
      const stageRect = stage.getBoundingClientRect();
      const maxW = Math.max(120, stageRect.width - 36);
      const maxH = Math.max(120, stageRect.height - 36);
      const scale = Math.min(maxW / out.w, maxH / out.h, 1.6);
      this.displayW = Math.round(out.w * scale);
      this.displayH = Math.round(out.h * scale);
      this.canvas.style.width = `${this.displayW}px`;
      this.canvas.style.height = `${this.displayH}px`;
      this.renderTextHandles();
      this.renderCropOverlay();
    }

    updatePlayButton(){
      const icon = this.el.querySelector('[data-ve-play] i');
      if (icon) icon.className = `fas ${this.video && !this.video.paused ? 'fa-pause' : 'fa-play'}`;
    }

    togglePlay(){
      if (!this.state.ready || this.state.exporting) return;
      if (this.video.paused) {
        const { start, end } = this.trimRange();
        if (this.video.currentTime < start || this.video.currentTime >= end - 0.05) this.video.currentTime = start;
        this.video.playbackRate = this.state.speed;
        this.video.muted = this.state.muted;
        this.video.volume = this.state.volume;
        this.video.play().catch(() => null);
      } else {
        this.video.pause();
      }
    }

    /* ------------------------------------------------------------------ */
    /* Timeline + trim                                                     */

    bindTimeline(){
      const track = this.el.querySelector('[data-ve-track]');
      const timeAt = (clientX) => {
        const rect = track.getBoundingClientRect();
        return clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1) * this.state.duration;
      };
      let dragging = '';
      const onMove = (event) => {
        if (!dragging) return;
        const time = timeAt(event.clientX);
        if (dragging === 'start') {
          this.state.trimStart = clamp(time, 0, this.trimRange().end - 0.1);
          if (this.video.currentTime < this.state.trimStart) this.video.currentTime = this.state.trimStart;
        } else if (dragging === 'end') {
          this.state.trimEnd = clamp(time, this.trimRange().start + 0.1, this.state.duration);
          if (this.video.currentTime > this.state.trimEnd) this.video.currentTime = this.state.trimEnd - 0.05;
        } else if (dragging === 'seek') {
          const { start, end } = this.trimRange();
          this.video.currentTime = clamp(time, start, end);
        }
        this.updateTimelineIndicators(true);
      };
      const onUp = () => { dragging = ''; };
      track.addEventListener('pointerdown', (event) => {
        if (!this.state.ready || this.state.exporting) return;
        const handle = event.target.closest?.('[data-ve-trim]');
        dragging = handle ? handle.dataset.veTrim : 'seek';
        // Capture is a nicety for dragging; never let it block the seek.
        try { track.setPointerCapture?.(event.pointerId); } catch (_) {}
        onMove(event);
      });
      track.addEventListener('pointermove', onMove);
      track.addEventListener('pointerup', onUp);
      track.addEventListener('pointercancel', onUp);
    }

    updateTimelineIndicators(force = false){
      if (!this.state.ready) return;
      const now = performance.now();
      if (!force && this.lastIndicatorAt && now - this.lastIndicatorAt < 40) return;
      this.lastIndicatorAt = now;
      const duration = Math.max(0.01, this.state.duration);
      const { start, end, length } = this.trimRange();
      const startPct = (start / duration) * 100;
      const endPct = (end / duration) * 100;
      const playPct = clamp((this.video.currentTime / duration) * 100, 0, 100);
      const set = (selector, styles) => {
        const node = this.el.querySelector(selector);
        if (node) Object.assign(node.style, styles);
      };
      set('[data-ve-shade-left]', { left: 0, width: `${startPct}%` });
      set('[data-ve-shade-right]', { right: 0, left: 'auto', width: `${100 - endPct}%` });
      set('[data-ve-trim-window]', { left: `${startPct}%`, width: `${endPct - startPct}%` });
      set('[data-ve-trim="start"]', { left: `${startPct}%` });
      set('[data-ve-trim="end"]', { left: `${endPct}%` });
      set('[data-ve-playhead]', { left: `${playPct}%` });
      const time = this.el.querySelector('[data-ve-time]');
      if (time) time.textContent = `${formatPrecise(Math.max(0, this.video.currentTime - start))} / ${formatPrecise(length / Math.max(0.1, this.state.speed))}`;
    }

    async buildFilmstrip(){
      const strip = this.el.querySelector('[data-ve-filmstrip]');
      const track = this.el.querySelector('[data-ve-track]');
      if (!strip || !track || !this.state.duration) return;
      const rect = track.getBoundingClientRect();
      const width = Math.max(240, Math.round(rect.width));
      const height = 52;
      strip.width = width;
      strip.height = height;
      const ctx = strip.getContext('2d');
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(0, 0, width, height);

      const sampler = document.createElement('video');
      sampler.preload = 'auto';
      sampler.muted = true;
      sampler.playsInline = true;
      sampler.src = this.playbackSrc || this.src;
      await new Promise((resolve) => {
        sampler.addEventListener('loadeddata', resolve, { once: true });
        sampler.addEventListener('error', resolve, { once: true });
        sampler.load();
      });
      if (!sampler.videoWidth || this.destroyed) return;
      const aspect = sampler.videoWidth / Math.max(1, sampler.videoHeight);
      const thumbW = Math.max(24, Math.round(height * aspect));
      const count = Math.ceil(width / thumbW);
      for (let i = 0; i < count; i += 1) {
        if (this.destroyed) return;
        const time = ((i + 0.5) / count) * this.state.duration;
        const drawn = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), 1200);
          sampler.addEventListener('seeked', () => {
            clearTimeout(timer);
            resolve(true);
          }, { once: true });
          try { sampler.currentTime = clamp(time, 0, Math.max(0, this.state.duration - 0.05)); } catch (_) {
            clearTimeout(timer);
            resolve(false);
          }
        });
        if (drawn) {
          try { ctx.drawImage(sampler, i * thumbW, 0, thumbW, height); } catch (_) { /* tainted or decode issue */ }
        }
      }
      sampler.removeAttribute('src');
      sampler.load();
    }

    /* ------------------------------------------------------------------ */
    /* Tool sub-bars                                                       */

    setTool(tool){
      this.state.activeTool = tool || '';
      this.el.querySelectorAll('[data-ve-tool]').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.veTool === this.state.activeTool);
      });
      this.renderSubbar();
      this.syncLayout();
    }

    renderSubbar(){
      const bar = this.subbar;
      const tool = this.state.activeTool;
      if (!tool && !this.state.selectedTextId) {
        bar.hidden = true;
        bar.innerHTML = '';
        return;
      }
      bar.hidden = false;
      if (this.state.selectedTextId && !tool) {
        this.renderTextSubbar();
        return;
      }
      if (tool === 'crop') {
        bar.innerHTML = CROP_PRESETS.map((preset) => `<button type="button" class="fm-video-editor-chip${this.state.cropPreset === preset.id ? ' active' : ''}" data-ve-crop-preset="${preset.id}">${preset.label}</button>`).join('');
        bar.querySelectorAll('[data-ve-crop-preset]').forEach((chip) => {
          chip.addEventListener('click', () => this.applyCropPreset(chip.dataset.veCropPreset));
        });
      } else if (tool === 'speed') {
        bar.innerHTML = SPEED_STEPS.map((step) => `<button type="button" class="fm-video-editor-chip${this.state.speed === step ? ' active' : ''}" data-ve-speed="${step}">${step}x</button>`).join('');
        bar.querySelectorAll('[data-ve-speed]').forEach((chip) => {
          chip.addEventListener('click', () => {
            this.state.speed = Number(chip.dataset.veSpeed) || 1;
            this.video.playbackRate = this.state.speed;
            const label = this.el.querySelector('[data-ve-speed-label]');
            if (label) label.textContent = `${this.state.speed}x`;
            this.renderSubbar();
          });
        });
      } else if (tool === 'volume') {
        bar.innerHTML = `
          <button type="button" class="fm-video-editor-chip${String(this.state.muted ? ' active' : '')}" data-ve-mute><i class="fas fa-volume-xmark"></i> ${String(this.state.muted ? 'Unmute' : 'Mute')}</button>
          <label>${(globalThis.PlatformLanguage?.htmlText("video-editor","m_5dcf36afbc163c","Volume ") ?? "Volume ")}<input type="range" min="0" max="1" step="0.05" value="${String(this.state.volume)}" data-ve-volume ${String(this.state.muted ? 'disabled' : '')}></label>`;
        bar.querySelector('[data-ve-mute]').addEventListener('click', () => {
          this.state.muted = !this.state.muted;
          this.video.muted = this.state.muted;
          this.updateVolumeIcon();
          this.renderSubbar();
        });
        bar.querySelector('[data-ve-volume]').addEventListener('input', (event) => {
          this.state.volume = clamp(Number(event.target.value) || 0, 0, 1);
          this.video.volume = this.state.volume;
          this.updateVolumeIcon();
        });
      } else {
        bar.hidden = true;
        bar.innerHTML = '';
      }
    }

    updateVolumeIcon(){
      const icon = this.el.querySelector('[data-ve-volume-icon]');
      if (!icon) return;
      icon.className = `fas ${this.state.muted || this.state.volume <= 0 ? 'fa-volume-xmark' : (this.state.volume < 0.55 ? 'fa-volume-low' : 'fa-volume-high')}`;
    }

    /* ------------------------------------------------------------------ */
    /* Crop                                                                */

    applyCropPreset(presetId){
      const preset = CROP_PRESETS.find((item) => item.id === presetId) || CROP_PRESETS[0];
      this.state.cropPreset = preset.id;
      const rotated = this.rotatedSize();
      if (preset.ratio === -1 || preset.id === 'original') {
        this.state.crop = { x: 0, y: 0, w: 1, h: 1 };
      } else if (preset.ratio > 0) {
        const frameRatio = rotated.w / rotated.h;
        let w = 1;
        let h = 1;
        if (preset.ratio > frameRatio) h = frameRatio / preset.ratio;
        else w = preset.ratio / frameRatio;
        this.state.crop = { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
      }
      this.syncLayout();
      this.renderSubbar();
    }

    renderCropOverlay(){
      this.overlay.querySelector('.fm-video-editor-crop')?.remove();
      if (this.state.activeTool !== 'crop' || !this.state.ready) return;
      // While cropping, the canvas shows the full rotated frame so the user
      // can pull the window outward; the crop rect is drawn on top.
      const box = document.createElement('div');
      box.className = 'fm-video-editor-crop';
      box.innerHTML = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((dir) => `<div class="fm-video-editor-crop-handle" data-crop-handle="${dir}"></div>`).join('');
      this.overlay.appendChild(box);

      const displayRect = () => ({ w: this.displayW || 1, h: this.displayH || 1 });
      // The canvas shows the full rotated frame while cropping, so the crop
      // rect maps directly from normalized rotated-frame coordinates.
      const place = () => {
        const { w: dw, h: dh } = displayRect();
        const crop = this.state.crop;
        box.style.left = `${crop.x * dw}px`;
        box.style.top = `${crop.y * dh}px`;
        box.style.width = `${crop.w * dw}px`;
        box.style.height = `${crop.h * dh}px`;
      };
      place();
      this.placeCropBox = place;

      let drag = null;
      const ratioLock = () => {
        const preset = CROP_PRESETS.find((item) => item.id === this.state.cropPreset);
        return preset && preset.ratio > 0 ? preset.ratio : 0;
      };
      const onDown = (event) => {
        const handle = event.target.closest?.('[data-crop-handle]');
        drag = {
          mode: handle ? handle.dataset.cropHandle : 'move',
          startX: event.clientX,
          startY: event.clientY,
          crop: { ...this.state.crop }
        };
        box.setPointerCapture?.(event.pointerId);
        event.preventDefault();
      };
      const onMove = (event) => {
        if (!drag) return;
        const { w: dw, h: dh } = displayRect();
        const dx = (event.clientX - drag.startX) / Math.max(1, dw);
        const dy = (event.clientY - drag.startY) / Math.max(1, dh);
        const next = { ...drag.crop };
        const minSize = 0.08;
        if (drag.mode === 'move') {
          next.x = clamp(drag.crop.x + dx, 0, 1 - next.w);
          next.y = clamp(drag.crop.y + dy, 0, 1 - next.h);
        } else {
          if (drag.mode.includes('w')) {
            const newX = clamp(drag.crop.x + dx, 0, drag.crop.x + drag.crop.w - minSize);
            next.w = drag.crop.w + (drag.crop.x - newX);
            next.x = newX;
          }
          if (drag.mode.includes('e')) next.w = clamp(drag.crop.w + dx, minSize, 1 - drag.crop.x);
          if (drag.mode.includes('n')) {
            const newY = clamp(drag.crop.y + dy, 0, drag.crop.y + drag.crop.h - minSize);
            next.h = drag.crop.h + (drag.crop.y - newY);
            next.y = newY;
          }
          if (drag.mode.includes('s')) next.h = clamp(drag.crop.h + dy, minSize, 1 - drag.crop.y);
          const lock = ratioLock();
          if (lock > 0) {
            const rotated = this.rotatedSize();
            const frameRatio = rotated.w / rotated.h;
            next.h = clamp((next.w * frameRatio) / lock, minSize, 1 - next.y);
            next.w = (next.h * lock) / frameRatio;
          }
          this.state.cropPreset = lock > 0 ? this.state.cropPreset : 'free';
        }
        this.state.crop = next;
        // Reposition only — rebuilding the overlay mid-drag would drop
        // pointer capture.
        this.placeCropBox?.();
      };
      const onUp = () => { drag = null; };
      box.addEventListener('pointerdown', onDown);
      box.addEventListener('pointermove', onMove);
      box.addEventListener('pointerup', onUp);
      box.addEventListener('pointercancel', onUp);
    }

    /* ------------------------------------------------------------------ */
    /* Text overlays                                                       */

    addText(){
      const text = {
        id: uid('vet'),
        text: 'Your text',
        x: 0.5,
        y: 0.82,
        size: 0.07,
        color: TEXT_COLORS[0]
      };
      this.state.texts.push(text);
      this.state.selectedTextId = text.id;
      this.setTool('');
      this.renderTextHandles();
      this.renderTextSubbar(true);
    }

    removeText(id){
      this.state.texts = this.state.texts.filter((item) => item.id !== id);
      if (this.state.selectedTextId === id) this.state.selectedTextId = '';
      this.renderTextHandles();
      this.renderSubbar();
    }

    selectedText(){
      return this.state.texts.find((item) => item.id === this.state.selectedTextId) || null;
    }

    renderTextSubbar(focusInput = false){
      const text = this.selectedText();
      const bar = this.subbar;
      if (!text) {
        this.renderSubbar();
        return;
      }
      bar.hidden = false;
      bar.innerHTML = `
        <input type="text" class="fm-video-editor-text-input" data-ve-text-value value="${String(escapeHtml(text.text))}" maxlength="120" placeholder="${(globalThis.PlatformLanguage?.htmlText("video-editor","m_26c21323be63c8","Overlay text") ?? "Overlay text")}">
        ${String(TEXT_COLORS.map((color) => `<button type="button" class="fm-video-editor-swatch${text.color === color ? ' active' : ''}" data-ve-text-color="${color}" style="background:${color}"></button>`).join(''))}
        <label>${(globalThis.PlatformLanguage?.htmlText("video-editor","m_1de443df83a86d","Size ") ?? "Size ")}<input type="range" min="0.03" max="0.16" step="0.005" value="${String(text.size)}" data-ve-text-size></label>
        <button type="button" class="fm-video-editor-chip" data-ve-text-delete><i class="fas fa-trash"></i>${(globalThis.PlatformLanguage?.htmlText("video-editor","m_09a65903b3217c"," Remove") ?? " Remove")}</button>`;
      const input = bar.querySelector('[data-ve-text-value]');
      input.addEventListener('input', () => {
        text.text = input.value;
        this.renderTextHandles();
      });
      bar.querySelectorAll('[data-ve-text-color]').forEach((swatch) => {
        swatch.addEventListener('click', () => {
          text.color = swatch.dataset.veTextColor;
          this.renderTextSubbar();
        });
      });
      bar.querySelector('[data-ve-text-size]').addEventListener('input', (event) => {
        text.size = clamp(Number(event.target.value) || text.size, 0.02, 0.3);
        this.renderTextHandles();
      });
      bar.querySelector('[data-ve-text-delete]').addEventListener('click', () => this.removeText(text.id));
      if (focusInput) {
        input.focus();
        input.select();
      }
    }

    renderTextHandles(){
      this.overlay.querySelectorAll('.fm-video-editor-text-handle').forEach((node) => node.remove());
      if (!this.state.ready || this.state.activeTool === 'crop') return;
      const dw = this.displayW || 1;
      const dh = this.displayH || 1;
      this.state.texts.forEach((text) => {
        const handle = document.createElement('div');
        handle.className = `fm-video-editor-text-handle${text.id === this.state.selectedTextId ? ' selected' : ''}`;
        const fontPx = Math.max(8, text.size * dh);
        handle.style.left = `${text.x * dw}px`;
        handle.style.top = `${text.y * dh}px`;
        handle.style.width = `${Math.max(34, text.text.length * fontPx * 0.62)}px`;
        handle.style.height = `${fontPx * 1.5}px`;
        this.overlay.appendChild(handle);

        let drag = null;
        handle.addEventListener('pointerdown', (event) => {
          drag = { startX: event.clientX, startY: event.clientY, x: text.x, y: text.y, moved: false };
          handle.setPointerCapture?.(event.pointerId);
          event.preventDefault();
        });
        handle.addEventListener('pointermove', (event) => {
          if (!drag) return;
          const dx = (event.clientX - drag.startX) / dw;
          const dy = (event.clientY - drag.startY) / dh;
          if (Math.abs(dx) > 0.004 || Math.abs(dy) > 0.004) drag.moved = true;
          text.x = clamp(drag.x + dx, 0.02, 0.98);
          text.y = clamp(drag.y + dy, 0.03, 0.97);
          handle.style.left = `${text.x * dw}px`;
          handle.style.top = `${text.y * dh}px`;
        });
        const finish = () => {
          const wasDrag = drag?.moved;
          drag = null;
          if (!wasDrag) {
            this.state.selectedTextId = text.id;
            this.setTool('');
            this.renderTextHandles();
            this.renderTextSubbar(true);
          }
        };
        handle.addEventListener('pointerup', finish);
        handle.addEventListener('pointercancel', () => { drag = null; });
      });
    }

    /* ------------------------------------------------------------------ */
    /* Reset / close                                                       */

    resetEdits(){
      Object.assign(this.state, {
        trimStart: 0,
        trimEnd: this.state.duration,
        rotation: 0,
        flip: false,
        speed: 1,
        muted: false,
        volume: 1,
        crop: { x: 0, y: 0, w: 1, h: 1 },
        cropPreset: 'free',
        texts: [],
        selectedTextId: ''
      });
      if (this.video) {
        this.video.playbackRate = 1;
        this.video.muted = false;
        this.video.volume = 1;
      }
      const label = this.el.querySelector('[data-ve-speed-label]');
      if (label) label.textContent = '1x';
      this.updateVolumeIcon();
      this.setTool('');
      this.syncLayout();
      this.updateTimelineIndicators(true);
    }

    async requestClose(){
      if (this.state.exporting) {
        this.cancelExport();
        return;
      }
      if (this.hasEdits() && !this.state.saving) {
        const confirmed = await (root.PlatformUI?.confirm?.((globalThis.PlatformLanguage?.text("video-editor","m_86c413b5376e52","Discard your video edits?") ?? "Discard your video edits?"), {
          title: (globalThis.PlatformLanguage?.text("video-editor","m_ff4b34deff3e0e","Discard edits") ?? "Discard edits"),
          okLabel: 'Discard',
          danger: true
        }) ?? Promise.resolve(root.confirm((globalThis.PlatformLanguage?.text("video-editor","m_86c413b5376e52","Discard your video edits?") ?? "Discard your video edits?"))));
        if (!confirmed) return;
      }
      this.close();
    }

    close(){
      if (this.destroyed) return;
      this.destroyed = true;
      cancelAnimationFrame(this.previewFrame);
      this.cancelExport();
      this.modalHandle?.unregister?.();
      this.modalHandle = null;
      window.removeEventListener('keydown', this.keyHandler);
      window.removeEventListener('resize', this.boundResize);
      try {
        this.video?.pause?.();
        this.video?.removeAttribute?.('src');
        this.video?.load?.();
      } catch (_) {}
      if (this.objectUrl) {
        URL.revokeObjectURL(this.objectUrl);
        this.objectUrl = '';
      }
      this.el?.remove();
      if (this.onClose) this.onClose();
    }

    /* ------------------------------------------------------------------ */
    /* Export                                                              */

    cancelExport(){
      if (this.exportAbort) {
        this.exportAbort();
        this.exportAbort = null;
      }
    }

    showExportOverlay(){
      this.exportOverlay = document.createElement('div');
      this.exportOverlay.className = 'fm-video-editor-export';
      this.exportOverlay.innerHTML = `
        <i class="fas fa-clapperboard" style="font-size:26px;color:#94a3b8"></i>
        <strong data-ve-export-label>${(globalThis.PlatformLanguage?.htmlText("video-editor","m_1e73e3d186f159","Rendering video…") ?? "Rendering video…")}</strong>
        <div class="fm-video-editor-progress"><i data-ve-export-bar></i></div>
        <span data-ve-export-detail>${(globalThis.PlatformLanguage?.htmlText("video-editor","m_bc7e11e4421412","This happens right in your browser.") ?? "This happens right in your browser.")}</span>
        <button type="button" class="fm-video-editor-btn" data-ve-export-cancel>${(globalThis.PlatformLanguage?.htmlText("video-editor","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button>`;
      this.el.appendChild(this.exportOverlay);
      this.exportOverlay.querySelector('[data-ve-export-cancel]').addEventListener('click', () => this.cancelExport());
    }

    setExportProgress(fraction, label){
      const bar = this.exportOverlay?.querySelector('[data-ve-export-bar]');
      if (bar) bar.style.width = `${Math.round(clamp(fraction, 0, 1) * 100)}%`;
      if (label) {
        const node = this.exportOverlay?.querySelector('[data-ve-export-label]');
        if (node) node.textContent = label;
      }
    }

    async exportVideo(forceMimeType = ''){
      const mimeType = cleanText(forceMimeType) || pickRecorderMimeType();
      if (!mimeType) throw new Error('Video export is not supported in this browser.');
      const { start, end, length } = this.trimRange();
      const out = this.outputSize();

      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = out.w;
      exportCanvas.height = out.h;
      const exportCtx = exportCanvas.getContext('2d');

      const exportVideo = document.createElement('video');
      exportVideo.preload = 'auto';
      exportVideo.playsInline = true;
      exportVideo.src = this.playbackSrc || this.src;
      await new Promise((resolve, reject) => {
        exportVideo.addEventListener('loadeddata', resolve, { once: true });
        exportVideo.addEventListener('error', () => reject(new Error('Could not load the video for export.')), { once: true });
        exportVideo.load();
      });
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000);
        exportVideo.addEventListener('seeked', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
        exportVideo.currentTime = start;
      });
      if (start > 0.05 && exportVideo.currentTime < start - 0.5) {
        throw new Error('This video could not be scrubbed for export. Try re-uploading it.');
      }
      exportVideo.playbackRate = this.state.speed;

      // Paint before capturing: auto-capture streams only emit on change, and
      // some Chrome builds never deliver frames for a canvas that was blank
      // when captureStream was called.
      this.drawFrame(exportCtx, out.w, out.h, exportVideo);
      // Auto-capture at EXPORT_FPS. captureStream(0)+requestFrame-only proved
      // unreliable (audio-only files on some machines); with auto capture the
      // interval-driven draws below keep frames flowing even when the tab is
      // backgrounded, and requestFrame() is called as a forcing hint on top.
      const stream = exportCanvas.captureStream(EXPORT_FPS);
      const canvasTrack = stream.getVideoTracks()[0];
      const tracks = [...stream.getVideoTracks()];
      let audioCtx = null;
      if (!this.state.muted && this.state.volume > 0) {
        try {
          audioCtx = new (root.AudioContext || root.webkitAudioContext)();
          const source = audioCtx.createMediaElementSource(exportVideo);
          const gain = audioCtx.createGain();
          gain.gain.value = this.state.volume;
          const destination = audioCtx.createMediaStreamDestination();
          source.connect(gain);
          gain.connect(destination);
          tracks.push(...destination.stream.getAudioTracks());
        } catch (_) {
          audioCtx = null;
        }
      } else {
        exportVideo.muted = true;
      }

      const recorder = new root.MediaRecorder(new MediaStream(tracks), {
        mimeType,
        videoBitsPerSecond: 8_000_000
      });
      const chunks = [];
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data && event.data.size) chunks.push(event.data);
      });

      return new Promise((resolve, reject) => {
        let finished = false;
        let ticker = null;
        const cleanup = () => {
          this.exportAbort = null;
          ticker?.stop();
          ticker = null;
          try { exportVideo.pause(); } catch (_) {}
          exportVideo.removeAttribute('src');
          exportVideo.load();
          stream.getTracks().forEach((track) => track.stop());
          audioCtx?.close?.().catch?.(() => null);
        };
        const finish = (error) => {
          if (finished) return;
          finished = true;
          if (error) {
            try { recorder.stop(); } catch (_) {}
            cleanup();
            reject(error);
            return;
          }
          recorder.addEventListener('stop', () => {
            cleanup();
            const blob = new Blob(chunks, { type: recorder.mimeType || mimeType });
            if (!blob.size) {
              reject(new Error('Export produced an empty video.'));
              return;
            }
            resolve({ blob, mimeType: recorder.mimeType || mimeType, width: out.w, height: out.h, duration: length / this.state.speed });
          }, { once: true });
          try { recorder.stop(); } catch (stopError) { cleanup(); reject(stopError); }
        };
        this.exportAbort = () => finish(new Error('Export cancelled.'));

        const drawExportFrame = () => {
          if (finished) return;
          this.drawFrame(exportCtx, out.w, out.h, exportVideo);
          try { canvasTrack.requestFrame?.(); } catch (_) {}
          this.setExportProgress(clamp((exportVideo.currentTime - start) / length, 0, 0.98));
          if (exportVideo.currentTime >= end - 0.03 || exportVideo.ended) {
            this.setExportProgress(1);
            finish();
          }
        };

        // Start recording only once playback is actually running — starting
        // earlier records leading silence/black and inflates the duration.
        exportVideo.play().then(() => {
          audioCtx?.resume?.().catch?.(() => null);
          drawExportFrame();
          recorder.start(250);
          ticker = createExportTicker(Math.round(1000 / EXPORT_FPS), drawExportFrame);
        }).catch((error) => finish(error || new Error('Could not start export playback.')));

        // Safety net: give up if playback stalls well past the expected time.
        const expectedMs = (length / Math.max(0.1, this.state.speed)) * 1000;
        setTimeout(() => finish(new Error('Export timed out.')), expectedMs + 30000);
      });
    }

    async save(){
      if (!this.state.ready || this.state.exporting || this.state.saving) return;
      if (!this.onSave) {
        await (root.PlatformUI?.alert?.((globalThis.PlatformLanguage?.text("video-editor","m_168d40a0d47a96","Saving is not available here.") ?? "Saving is not available here.")) || Promise.resolve());
        return;
      }
      this.video.pause();
      this.state.exporting = true;
      this.showExportOverlay();
      try {
        let result = await this.exportVideo();
        // Verify the file really has a video track; if the preferred (mp4)
        // recording came back audio-only or undecodable, re-render as WebM.
        let check = await probeExportedBlob(result.blob);
        if (!check.ok) {
          const webmMime = pickWebmMimeType();
          if (webmMime && !cleanText(result.mimeType).toLowerCase().includes('webm')) {
            this.setExportProgress(0, 'Retrying export…');
            result = await this.exportVideo(webmMime);
            check = await probeExportedBlob(result.blob);
          }
          if (!check.ok) throw new Error('The exported file had no video. Please try again, or try a different browser.');
        }
        this.state.saving = true;
        this.setExportProgress(1, 'Saving video…');
        const ext = extensionForMime(result.mimeType);
        const file = new File([result.blob], `${safeFileBase(this.fileName)} (edited).${ext}`, { type: result.mimeType.split(';')[0] });
        await this.onSave(file, {
          duration: result.duration,
          width: result.width,
          height: result.height,
          mimeType: result.mimeType,
          edits: {
            trim: this.trimRange(),
            rotation: this.state.rotation,
            flip: this.state.flip,
            speed: this.state.speed,
            muted: this.state.muted,
            volume: this.state.volume,
            crop: { ...this.state.crop },
            textCount: this.state.texts.length
          }
        });
        this.close();
      } catch (error) {
        this.state.exporting = false;
        this.state.saving = false;
        this.exportOverlay?.remove();
        this.exportOverlay = null;
        if (cleanTextErrorIsCancel(error)) return;
        await (root.PlatformUI?.alert?.(error?.message || 'Could not export this video.', { title: (globalThis.PlatformLanguage?.text("video-editor","m_499773c0da7033","Export failed") ?? "Export failed") }) || Promise.resolve(alert(error?.message || 'Could not export this video.')));
      }
    }
  }

  function cleanTextErrorIsCancel(error){
    return /cancelled/i.test(cleanText(error?.message));
  }

  /* Drives the export frame loop. Browsers clamp setInterval/rAF to ~1Hz in
   * background tabs, which would silently render a 1-frame, near-black clip if
   * the user switches tabs mid-export. Worker timers are not throttled, so the
   * export keeps running at full rate; setInterval is only the fallback. */
  function createExportTicker(intervalMs, onTick){
    try {
      const source = 'let id=null;onmessage=(e)=>{const d=e.data||{};if(d.stop){clearInterval(id);id=null;close();return;}clearInterval(id);id=setInterval(()=>postMessage(1),d.interval||33);};';
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      const worker = new root.Worker(url);
      URL.revokeObjectURL(url);
      worker.onmessage = () => onTick();
      worker.postMessage({ interval: intervalMs });
      return {
        stop(){
          try {
            worker.postMessage({ stop: true });
            worker.terminate();
          } catch (_) {}
        }
      };
    } catch (_) {
      const id = setInterval(onTick, intervalMs);
      return { stop(){ clearInterval(id); } };
    }
  }

  function pickWebmMimeType(){
    if (typeof root.MediaRecorder === 'undefined') return '';
    return ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((type) => {
      try { return root.MediaRecorder.isTypeSupported(type); } catch (_) { return false; }
    }) || '';
  }

  /* Decode the exported blob and confirm it actually contains video frames.
   * MediaRecorder can silently drop the video track (frame delivery flakiness)
   * and produce an audio-only file — never let that reach the server.
   * Resolves { ok, hasVideo }; ok=false only on a definitive negative. */
  function probeExportedBlob(blob){
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const probe = document.createElement('video');
      probe.preload = 'metadata';
      probe.muted = true;
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        URL.revokeObjectURL(url);
        probe.removeAttribute('src');
        probe.load();
        resolve(result);
      };
      const timer = setTimeout(() => finish({ ok: true, hasVideo: true, timedOut: true }), 6000);
      probe.addEventListener('error', () => {
        clearTimeout(timer);
        finish({ ok: false, hasVideo: false });
      });
      probe.addEventListener('loadedmetadata', () => {
        clearTimeout(timer);
        finish({ ok: probe.videoWidth > 0 && probe.videoHeight > 0, hasVideo: probe.videoWidth > 0 });
      });
      probe.src = url;
      probe.load();
    });
  }

  function isSupported(){
    return typeof root.MediaRecorder !== 'undefined'
      && typeof document.createElement('canvas').captureStream === 'function'
      && !!pickRecorderMimeType();
  }

  function open(options = {}){
    if (!cleanText(options.src)) return null;
    if (!isSupported()) {
      root.PlatformUI?.alert?.((globalThis.PlatformLanguage?.text("video-editor","m_a722da44f0411e","Video editing is not supported in this browser.") ?? "Video editing is not supported in this browser."), { title: (globalThis.PlatformLanguage?.text("video-editor","m_afc766e06d0a79","Not supported") ?? "Not supported") });
      return null;
    }
    return new VideoEditor(options);
  }

  root.FirstMateVideoEditor = {
    open,
    isSupported,
    VideoEditor
  };
})();
