/* public/libraries/apps/tutorial/app.js
 * Restores the tutorial overlay engine (lightweight + modular)
 * Starts if cfg.showTutorial === true
 * run(steps, { onEnd }) plays a step-by-step tutorial (first-open tab tutorials,
 * docs/architecture/project-tab-guides.md). The overlay sits above the project
 * window and is left out of session replays (data-fmr-ignore).
 */
(function(){
  if (!window.Portal) return;

  const cfg = window.Portal.cfg || {};
  const { injectCSS } = window.Portal.util;

  const css = `
    .tut-svg{position:fixed; inset:0; width:100%; height:100%; z-index:2147483300; pointer-events:none}
    .tut-path{fill:rgba(0,0,0,0.60); fill-rule:evenodd; pointer-events:auto}
    .tut-tt{
      position:fixed; z-index:2147483400;
      background:#fff;
      border-radius:14px;
      box-shadow:0 18px 55px rgba(0,0,0,0.45);
      padding:12px 14px;
      max-width:260px;
      font-size:13px;
      font-weight:850;
      color:#333;
      animation:tutFade .18s ease-out;
    }
    .tut-tt strong{display:block; color:#d93025; font-weight:1000; margin-bottom:6px; font-size:14px}
    .tut-x{position:absolute; top:8px; right:10px; cursor:pointer; color:#aaa}
    .tut-x:hover{color:#333}
    .tut-arrow{position:absolute; width:0; height:0; border:8px solid transparent}
    .tut-arrow-left{border-right-color:#fff; left:-16px; top:15px}
    .tut-arrow-right{border-left-color:#fff; right:-16px; top:15px}
    .tut-arrow-top{border-bottom-color:#fff; top:-16px; left:50%; transform:translateX(-50%)}
    .tut-arrow-bottom{border-top-color:#fff; bottom:-16px; left:50%; transform:translateX(-50%)}
    .tut-tt.tut-step{max-width:min(300px,calc(100vw - 20px)); font-weight:600; line-height:1.45; padding:14px 16px 12px}
    .tut-tt.tut-step strong{padding-right:18px}
    .tut-nav{display:flex; align-items:center; gap:8px; margin-top:12px}
    .tut-count{margin-right:auto; color:#888; font-size:11px; font-weight:700}
    .tut-nav button{height:30px; border-radius:8px; border:1px solid #d0d5dd; background:#fff; color:#344054; padding:0 12px; font:inherit; font-size:12px; font-weight:800; cursor:pointer}
    .tut-nav button.tut-next{border-color:var(--primary,#d93025); background:var(--primary,#d93025); color:#fff}
    .tut-nav button:focus-visible,.tut-x:focus-visible{outline:2px solid var(--primary,#d93025); outline-offset:2px}
    @keyframes tutFade{from{opacity:0; transform:translateY(6px)}to{opacity:1; transform:translateY(0)}}
  `;

  const Tutorial = {
    svg:null, path:null, tooltips:[], targets:[],
    init(){
      if (this.svg) return;
      injectCSS('tutorial', css);

      this.svg = document.createElementNS("http://www.w3.org/2000/svg","svg");
      this.svg.classList.add('tut-svg');
      this.svg.setAttribute('data-fmr-ignore', '');
      this.path = document.createElementNS("http://www.w3.org/2000/svg","path");
      this.path.classList.add('tut-path');
      this.svg.appendChild(this.path);
      document.body.appendChild(this.svg);

      window.addEventListener('resize', ()=>this.redraw());
    },
    clear(){
      this.tooltips.forEach(t=>t.remove());
      this.tooltips = [];
      this.targets = [];
      if (this.svg) this.svg.style.display = 'none';
    },
    end(){
      this.clear();
      this.svg?.remove();
      this.svg = null;
      this.path = null;
      this.step = null;
      if (this.keydown) document.removeEventListener('keydown', this.keydown, true);
      this.keydown = null;

      if (window.Portal?.navigation?.read?.().tutorial) window.Portal.navigation.replace({ tutorial:null }, { source:'tutorial-end' });
    },
    highlight(targets){
      this.init();
      this.clear();
      this.targets = targets || [];
      if (this.svg){
        this.svg.style.display = 'block';
        this.redraw();
      }
    },
    roundedRectPath(x,y,w,h,r){
      const rr = Math.min(r, w/2, h/2);
      return `
        M ${x+rr},${y}
        h ${w-2*rr}
        a ${rr},${rr} 0 0 1 ${rr},${rr}
        v ${h-2*rr}
        a ${rr},${rr} 0 0 1 -${rr},${rr}
        h -${w-2*rr}
        a ${rr},${rr} 0 0 1 -${rr},-${rr}
        v -${h-2*rr}
        a ${rr},${rr} 0 0 1 ${rr},-${rr}
        z
      `;
    },
    redraw(){
      if (!this.targets.length || !this.path) return;

      this.tooltips.forEach(t=>t.remove());
      this.tooltips = [];

      const W = window.innerWidth, H = window.innerHeight;
      let d = `M 0 0 H ${W} V ${H} H 0 Z`;

      for (const t of this.targets){
        const el = document.querySelector(t.selector);
        if (!el || el.offsetParent === null) continue;

        const r = el.getBoundingClientRect();
        const br = parseFloat(getComputedStyle(el).borderTopLeftRadius || '0') || 0;

        d += br > 0 ? this.roundedRectPath(r.left, r.top, r.width, r.height, br)
                    : ` M ${r.left} ${r.top} H ${r.right} V ${r.bottom} H ${r.left} Z`;

        this.tooltip(r, t);
      }
      this.path.setAttribute('d', d);
    },
    tooltip(rect, data){
      const tt = document.createElement('div');
      const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
      const step = this.step;
      const closeLabel = globalThis.PlatformLanguage?.text("tutorial","tut_close","Close") ?? "Close";
      tt.className = step ? 'tut-tt tut-step' : 'tut-tt';
      tt.setAttribute('data-fmr-ignore', '');
      if (step) {
        tt.setAttribute('role', 'dialog');
        tt.setAttribute('aria-label', String(data.title || ''));
      }
      const count = step && step.total > 1 ? ((v0, v1) => globalThis.PlatformLanguage?.text("tutorial","tut_step_count",`${v0} of ${v1}`,{v0,v1}) ?? `${v0} of ${v1}`)(step.position, step.total) : '';
      const nextLabel = step && step.position < step.total ? (globalThis.PlatformLanguage?.text("tutorial","tut_next","Next") ?? "Next") : (globalThis.PlatformLanguage?.text("tutorial","tut_done","Done") ?? "Done");
      const backLabel = globalThis.PlatformLanguage?.text("tutorial","tut_back","Back") ?? "Back";
      const nav = step ? `<div class="tut-nav"><span class="tut-count">${escape(count)}</span>${step.position > 1 ? `<button type="button" class="tut-back">${escape(backLabel)}</button>` : ''}<button type="button" class="tut-next">${escape(nextLabel)}</button></div>` : '';
      tt.innerHTML = `
        <i class="fas fa-times tut-x" data-fm-tooltip="${escape(closeLabel)}"${step ? ` role="button" tabindex="0" aria-label="${escape(closeLabel)}"` : ''}></i>
        <strong>${escape(data.title)}</strong>
        <div>${escape(data.text)}</div>
        ${nav}
        <div class="tut-arrow"></div>
      `;
      document.body.appendChild(tt);
      this.tooltips.push(tt);

      tt.querySelector('.tut-x').addEventListener('click', ()=> step ? step.close() : this.end());
      if (step) {
        tt.querySelector('.tut-next')?.addEventListener('click', () => step.next());
        tt.querySelector('.tut-back')?.addEventListener('click', () => step.back());
        if (step.focus) {
          step.focus = false;
          setTimeout(() => tt.querySelector('.tut-next')?.focus?.(), 0);
        }
      }

      // placement
      const ttr = tt.getBoundingClientRect();
      const arrow = tt.querySelector('.tut-arrow');
      const pos = data.pos || 'bottom';

      let top=0, left=0, cls='tut-arrow-top';
      if (pos === 'right'){
        left = rect.right + 15;
        top = rect.top + rect.height/2 - ttr.height/2;
        cls = 'tut-arrow-left';
      } else if (pos === 'left'){
        left = rect.left - ttr.width - 15;
        top = rect.top + rect.height/2 - ttr.height/2;
        cls = 'tut-arrow-right';
      } else if (pos === 'top'){
        left = rect.left + rect.width/2 - ttr.width/2;
        top = rect.top - ttr.height - 15;
        cls = 'tut-arrow-bottom';
      } else {
        left = rect.left + rect.width/2 - ttr.width/2;
        top = rect.bottom + 15;
        cls = 'tut-arrow-top';
      }

      left = Math.max(10, Math.min(left, window.innerWidth - ttr.width - 10));
      top  = Math.max(10, Math.min(top, window.innerHeight - ttr.height - 10));

      tt.style.left = left + 'px';
      tt.style.top = top + 'px';
      arrow.classList.add(cls);
    }
  };

  const visibleTarget = (selector) => {
    try {
      const el = document.querySelector(selector);
      return el && el.offsetParent !== null ? el : null;
    } catch (_) { return null; }
  };
  const waitForTarget = (selector, timeout = 1500) => new Promise((resolve) => {
    const started = Date.now();
    const poll = () => {
      const el = visibleTarget(selector);
      if (el || Date.now() - started >= timeout) return resolve(el);
      setTimeout(poll, 100);
    };
    poll();
  });

  /**
   * Plays steps one at a time: { selector, title, text, pos }. A step whose
   * target is not on screen is skipped. onEnd({ completed, shown }) runs once,
   * when the last step is done or the tutorial is closed.
   */
  Tutorial.run = function(steps = [], options = {}){
    this.active?.close?.();
    this.end();
    const list = (Array.isArray(steps) ? steps : []).filter((step) => step && step.selector);
    const run = { ended:false, shown:0 };
    const finish = (completed) => {
      if (run.ended) return;
      run.ended = true;
      if (this.active === handle) {
        this.active = null;
        this.end();
      }
      try { options.onEnd?.({ completed, shown: run.shown }); } catch (error) { console.warn('Tutorial end handler failed', error); }
    };
    const show = async (from, direction) => {
      for (let index = from; index >= 0 && index < list.length; index += direction) {
        const target = await waitForTarget(list[index].selector, direction > 0 ? 1500 : 0);
        if (run.ended) return;
        if (!target) continue;
        run.shown += 1;
        target.scrollIntoView?.({ block:'nearest', inline:'nearest' });
        this.step = {
          position: index + 1,
          total: list.length,
          focus: true,
          next: () => show(index + 1, 1),
          back: () => show(index - 1, -1),
          close: () => finish(false)
        };
        this.highlight([list[index]]);
        return;
      }
      // Past the last step: done. Nothing found going back keeps the current step.
      if (direction > 0) finish(run.shown > 0);
    };
    const handle = { close: () => finish(false), get ended(){ return run.ended; } };
    this.active = handle;
    this.keydown = (event) => {
      if (event.key === 'Escape' && this.step) { event.preventDefault(); event.stopPropagation(); this.step.close(); }
    };
    document.addEventListener('keydown', this.keydown, true);
    show(0, 1);
    return handle;
  };

  // Public API
  window.Portal.modules = window.Portal.modules || {};
  window.Portal.modules.tutorial = Tutorial;

  // Auto-start flow (simple version)
  document.addEventListener('DOMContentLoaded', ()=>{
    // The legacy first-request walkthrough needs its button; without it the overlay would only darken the page.
    if (!cfg.showTutorial || !document.getElementById('btnNewReq')) return;

    // highlight New Request button
    Tutorial.highlight([{
      selector: '#btnNewReq',
      title: (globalThis.PlatformLanguage?.text("tutorial","m_ebaa6f2e6577fa","Welcome!") ?? "Welcome!"),
      text: 'Click here to submit your first measurement request.',
      pos: 'right'
    }]);

    const btn = document.getElementById('btnNewReq');
    if (!btn) return;

    const step2 = ()=>{
      btn.removeEventListener('click', step2);
      Tutorial.clear();
      setTimeout(()=>{
        Tutorial.highlight([{
          selector: '#rAddress',
          title: (globalThis.PlatformLanguage?.text("tutorial","m_c4e0a116f64d8a","Step 1: Address") ?? "Step 1: Address"),
          text: 'Start typing the property address here.',
          pos: 'bottom'
        }]);
      }, 350);
    };
    btn.addEventListener('click', step2);
  });
})();
