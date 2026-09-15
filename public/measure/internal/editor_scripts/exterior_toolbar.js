/* Reuse controls and handlers inside the wrapping 3D toolbar. */
window.mountExteriorToolbar=function(){
 const parent=document.querySelector('#three-container .enh-control-panel');if(!parent)return;const existing=document.getElementById('exterior-toolbar');if(existing){parent.appendChild(existing);return;}if(!document.getElementById('wall-layer-visibility'))return;
 const style=document.createElement('style');style.textContent=`#exterior-toolbar{display:none;flex:0 0 auto;align-items:center;gap:10px;flex-wrap:wrap;padding:7px 10px;background:#202830;color:#edf0f3;border-bottom:1px solid #53606a;font:12px system-ui;position:relative;z-index:50}.wall-mode-active #exterior-toolbar{display:contents}#exterior-toolbar .exterior-toolbar-group{display:flex;align-items:center;gap:5px;flex-wrap:wrap}#exterior-toolbar button{height:32px;padding:4px 9px;border:1px solid #63717d;border-radius:5px;background:#303b45;color:inherit;cursor:pointer;font:inherit}#exterior-toolbar button[aria-pressed=true]{color:#ffd84d;border-color:#ffd84d;background:#4d4525}#exterior-toolbar button:disabled{opacity:.45;cursor:default}#exterior-toolbar button[data-layer-icon]{width:34px;padding:5px}#exterior-toolbar svg{width:22px;height:22px;display:block}#exterior-toolbar input{width:68px;background:#15191d;color:white;border:1px solid #63717d;border-radius:4px;padding:5px}#exterior-toolbar label{display:flex;align-items:center;gap:5px;margin:0}#exterior-toolbar [hidden]{display:none!important}#exterior-toolbar #ground-status{margin:0;font-size:11px;max-width:260px}#exterior-toolbar #wall-layer-visibility{position:static!important;padding:0!important;background:none!important;overflow:visible!important;margin:0}#exterior-toolbar .exterior-toolbar-group+.exterior-toolbar-group{border-left:1px solid #53606a;padding-left:10px}
 #three-container .enh-control-panel{right:140px;max-width:calc(100% - 148px);box-sizing:border-box;flex-wrap:wrap;gap:6px;padding:6px;align-content:flex-start}
 #three-container .enh-control-panel>*{flex-shrink:0}
 .wall-mode-active #btnTogglePitch,.wall-mode-active #tile-y-controls,.wall-mode-active .enh-control-panel>.enh-separator{display:none!important}
 #exterior-toolbar .exterior-toolbar-group{gap:4px;max-width:100%;border:0;padding:0}
 #exterior-toolbar button{height:28px;padding:3px 6px;white-space:nowrap}
 #exterior-toolbar svg{width:18px;height:18px}
 #exterior-toolbar button[data-layer-icon]{width:28px;padding:4px}
 #exterior-toolbar select{max-width:125px;height:28px;background:#303b45;color:#fff;border:1px solid #63717d;border-radius:5px;font:11px system-ui}
 #exterior-toolbar [aria-label="Rebuild building"]{position:relative} #exterior-toolbar #wall-soffit-menu{position:absolute;top:calc(100% + 7px);left:0;padding:6px;background:#222b33;border:1px solid #53616d;border-radius:9px;box-shadow:0 10px 28px #0006;z-index:100;width:228px;box-sizing:border-box} #exterior-toolbar #wall-soffit-menu[hidden]{display:none} #exterior-toolbar #wall-rebuild{border-radius:5px 0 0 5px;margin-right:-5px} #exterior-toolbar #wall-auto{border-radius:0 5px 5px 0}
 #exterior-toolbar #wall-soffit-menu .soffit-title{padding:8px 10px 10px;color:#aebac5;font:600 11px system-ui;letter-spacing:.04em;text-transform:uppercase}
 #exterior-toolbar #wall-soffit-menu .soffit-options{display:grid;gap:3px}
 #exterior-toolbar #wall-soffit-menu button{display:grid;grid-template-columns:16px 1fr auto;align-items:center;gap:8px;width:100%;height:36px;padding:0 10px;border:0;border-radius:5px;background:transparent;text-align:left;color:#edf0f3;font:13px system-ui;white-space:nowrap}
 #exterior-toolbar #wall-soffit-menu button:before{content:'';width:16px;text-align:center}
 #exterior-toolbar #wall-soffit-menu button small{color:#9fadb9;font-size:11px;font-variant-numeric:tabular-nums}
 #exterior-toolbar #wall-soffit-menu button:hover{background:#35424d}
 #exterior-toolbar #wall-soffit-menu button:focus-visible{outline:2px solid #e7ad52;outline-offset:-2px}
 #exterior-toolbar #wall-soffit-menu button[aria-pressed=true]{background:#3b3a2d;color:#ffe0a1}
 #exterior-toolbar #wall-soffit-menu button[aria-pressed=true]:before{content:'\\2713';color:#ffd078}
 #exterior-toolbar .exterior-grade-sources{display:flex;border:1px solid #63717d;border-radius:14px;overflow:hidden;padding:2px;background:#15191d}
 #exterior-toolbar .exterior-grade-sources button{border:0;border-radius:12px;font-size:10px;height:24px}
 #exterior-toolbar .exterior-grade-sources button[aria-pressed=true]{background:#eee;color:#222}
 #exterior-toolbar #ground-flat-control{font-size:10px}#exterior-toolbar input{width:52px;padding:3px}
 `;document.head.appendChild(style);
 const bar=document.createElement('div');bar.id='exterior-toolbar';bar.setAttribute('role','toolbar');bar.setAttribute('aria-label','Exterior building controls');parent.appendChild(bar);
 const group=label=>{const g=document.createElement('div');g.className='exterior-toolbar-group';g.setAttribute('role','group');g.setAttribute('aria-label',label);bar.appendChild(g);return g;},move=(id,g)=>{const el=document.getElementById(id);if(el)g.appendChild(el);return el;};
 const visibility=group('Visible building layers');move('wall-layer-visibility',visibility);
 const icons={'wall-roof-visibility':['Roof','M3 12 12 4l9 8M5 11v8h14v-8'], 'wall-visible':['Walls','M4 5h16v15H4zM4 10h16M4 15h16M9 5v5m6 0v5m-6 0v5'],'base-visible':['Base','M3 13 12 8l9 5-9 5zM3 17l9 5 9-5'],'ground-visible':['Grade','M3 17 9 14l5 1 7-8M3 21h18']};
 for(const [id,[label,path]]of Object.entries(icons)){const b=document.getElementById(id);if(!b)continue;b.dataset.layerIcon=label;b.title='Toggle '+label.toLowerCase();b.setAttribute('aria-label',label);b.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+path+'"/></svg>';}
 const build=group('Rebuild building');const roof=move('wall-rebuild',build);if(roof)roof.textContent='From Roof';const dropdown=move('wall-auto',build);if(dropdown){dropdown.textContent='▾';dropdown.title='Choose soffit setback';dropdown.setAttribute('aria-label','Choose soffit setback');}move('wall-soffit-menu',build);move('wall-merge-all',build);move('wall-auto-trim',build);const base=move('base-rebuild-grade',build);if(base)base.textContent='To ground';
 const display=group('Display options');
 const icon=(id,label,path)=>{const b=move(id,display);if(!b)return;b.title=label;b.setAttribute('aria-label',label);b.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="'+path+'"/></svg>';};
 const surfaceMode=move('wall-translucency-toggle',display);if(surfaceMode)surfaceMode.title='Cycle translucent, opaque and textured surfaces';
 icon('wall-centers-toggle','Face centers (walls and base)','M4 4h16v16H4z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0');
 icon('wall-feature-dimensions','Feature dimensions','M4 8V4h16v4M4 6h16M8 20H4V10h4M6 10v10M12 12h8v8h-8z');
 icon('wall-gap-toggle','Highlight open edges','M3 5h7m4 0h7M3 5v14h18V5');
 const lengths=document.getElementById('wall-lengths-toggle');if(lengths){const label=lengths.parentElement;move('wall-lengths-toggle',display);label.remove();lengths.title='Line lengths';}
 const grading=group('Grading');const heading=document.createElement('span');heading.textContent='Grade';grading.appendChild(heading);const old=document.getElementById('ground-dsm')?.parentElement?.parentElement?.parentElement;const sources=document.createElement('div');sources.className='exterior-grade-sources';sources.setAttribute('role','group');sources.setAttribute('aria-label','Grade data source');grading.appendChild(sources);for(const id of ['ground-dsm','ground-usgs','ground-flat'])move(id,sources);move('ground-flat-control',grading);move('ground-status',document.getElementById('wall-panel'));if(old&&old!==bar&&!old.querySelector('button,input,select'))old.remove();
 bar.addEventListener('wheel',e=>e.stopPropagation(),{passive:true});
};
