/* public/libraries/apps/tutorial/app.js
 * Restores the tutorial overlay engine (lightweight + modular)
 * Starts if cfg.showTutorial === true
 */
(function(){
  if (!window.Portal) return;

  const cfg = window.Portal.cfg || {};
  const { injectCSS } = window.Portal.util;

  const css = `
    .tut-svg{position:fixed; inset:0; width:100%; height:100%; z-index:99990; pointer-events:none}
    .tut-path{fill:rgba(0,0,0,0.60); fill-rule:evenodd; pointer-events:auto}
    .tut-tt{
      position:fixed; z-index:99999;
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
    @keyframes tutFade{from{opacity:0; transform:translateY(6px)}to{opacity:1; transform:translateY(0)}}
  `;

  const Tutorial = {
    svg:null, path:null, tooltips:[], targets:[],
    init(){
      if (this.svg) return;
      injectCSS('tutorial', css);

      this.svg = document.createElementNS("http://www.w3.org/2000/svg","svg");
      this.svg.classList.add('tut-svg');
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

      const url = new URL(window.location.href);
      if (url.searchParams.has('tutorial')){
        url.searchParams.delete('tutorial');
        window.history.replaceState({}, document.title, url.toString());
      }
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
      tt.className = 'tut-tt';
      tt.innerHTML = `
        <i class="fas fa-times tut-x" data-fm-tooltip="Close"></i>
        <strong>${data.title || ''}</strong>
        <div>${data.text || ''}</div>
        <div class="tut-arrow"></div>
      `;
      document.body.appendChild(tt);
      this.tooltips.push(tt);

      tt.querySelector('.tut-x').addEventListener('click', ()=>this.end());

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

  // Public API
  window.Portal.modules = window.Portal.modules || {};
  window.Portal.modules.tutorial = Tutorial;

  // Auto-start flow (simple version)
  document.addEventListener('DOMContentLoaded', ()=>{
    if (!cfg.showTutorial) return;

    // highlight New Request button
    Tutorial.highlight([{
      selector: '#btnNewReq',
      title: 'Welcome!',
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
          title: 'Step 1: Address',
          text: 'Start typing the property address here.',
          pos: 'bottom'
        }]);
      }, 350);
    };
    btn.addEventListener('click', step2);
  });
})();
