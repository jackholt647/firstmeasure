/* Reuse controls and handlers across the main header and 3D display toolbar. */
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
 #exterior-toolbar .exterior-measurements{display:flex;align-items:center;gap:5px}
 #exterior-toolbar #wall-lengths-toggle{display:inline-flex;flex-wrap:nowrap;gap:0;border:1px solid #63717d;border-radius:5px;overflow:hidden;background:#26313a}
 #exterior-toolbar #wall-lengths-toggle button{height:26px;min-width:0;margin:0;padding:3px 7px;border:0;border-radius:0;background:transparent;font:11px system-ui;color:#dce3e9}
 #exterior-toolbar #wall-lengths-toggle button+button{border-left:1px solid #53616d}
 #exterior-toolbar #wall-lengths-toggle button:hover{background:#3b4854}
 #exterior-toolbar #wall-lengths-toggle button[aria-pressed=true]{background:#4d4525;color:#ffd84d}
 #exterior-toolbar #wall-lengths-toggle button:focus-visible{outline:2px solid #ffd84d;outline-offset:-2px}
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
 const main=document.createElement('div');main.id='exterior-main-toolbar';main.setAttribute('role','group');main.setAttribute('aria-label','Wall building actions');(document.getElementById('global-toolbar')||parent).appendChild(main);
 // Keep the existing right-hand action section in place. Only the left
 // sections move into a wrapping container while wall mode is active.
 const header=document.getElementById('global-toolbar'),left=document.createElement('div');left.id='wall-header-left';
 const sections=[...(header?.querySelectorAll('.toolbar-row')||[])].map(section=>({section,parent:section.parentElement,next:section.nextSibling}));
 const actions=header?.querySelector('.toolbar-row-secondary>.toolbar-section-right'),actionParent=actions?.parentElement,actionNext=actions?.nextSibling;actions?.classList.add('wall-header-actions');
 header?.appendChild(left);
 window.updateExteriorHeaderLayout=()=>{const active=document.body.classList.contains('wall-mode-active');for(const item of sections){if(active)left.appendChild(item.section);else if(item.section.parentElement!==item.parent)item.parent.insertBefore(item.section,item.next);}if(active){left.appendChild(main);if(actions)header.appendChild(actions);}else{header?.appendChild(main);if(actions&&actions.parentElement!==actionParent)actionParent.insertBefore(actions,actionNext);}};
 window.updateExteriorHeaderLayout();
 const build=group('Rebuild building');main.appendChild(build);const roof=move('wall-rebuild',build);if(roof)roof.textContent='From Roof';const dropdown=move('wall-auto',build);if(dropdown){dropdown.textContent='▾';dropdown.title='Choose soffit setback';dropdown.setAttribute('aria-label','Choose soffit setback');}move('wall-soffit-menu',build);move('wall-resoffit-control',build);move('wall-merge-all',build);const base=move('base-rebuild-grade',build);if(base)base.textContent='Reground';
 const display=group('Display options');
 const icon=(id,label,path)=>{const b=move(id,display);if(!b)return;b.title=label;b.setAttribute('aria-label',label);b.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="'+path+'"/></svg>';};
 const surfaceMode=move('wall-translucency-toggle',display);if(surfaceMode)surfaceMode.title='Cycle translucent, opaque and textured surfaces';
 icon('wall-centers-toggle','Face centers (walls and base)','M4 4h16v16H4z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0');
 icon('wall-line-centers-toggle','Line centers: show and snap to midpoints','M3 12h6m6 0h6M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0');
 icon('wall-feature-dimensions','Feature dimensions','M4 8V4h16v4M4 6h16M8 20H4V10h4M6 10v10M12 12h8v8h-8z');
 icon('wall-gap-toggle','Highlight open edges','M3 5h7m4 0h7M3 5v14h18V5');
 const lengths=document.getElementById('wall-lengths-toggle');if(lengths){const label=lengths.parentElement;label.textContent='';label.className='exterior-measurements';label.title='Measurements';label.innerHTML='<i class="fas fa-ruler" aria-hidden="true"></i>';label.appendChild(lengths);display.appendChild(label);lengths.title='Measurements';}
 const grading=group('Grading');main.appendChild(grading);const heading=document.createElement('span');heading.textContent='Grade';grading.appendChild(heading);const old=document.getElementById('ground-dsm')?.parentElement?.parentElement?.parentElement;const sources=document.createElement('div');sources.className='exterior-grade-sources';sources.setAttribute('role','group');sources.setAttribute('aria-label','Grade data source');grading.appendChild(sources);for(const id of ['ground-dsm','ground-usgs','ground-flat'])move(id,sources);const elevation=move('ground-flat-control',document.querySelector('#wall-advanced>div')||grading);if(elevation){elevation.firstChild.textContent='Flat grade elevation (m)';elevation.title='Manual override for the ground reference elevation. Normally taken from the current grade.';elevation.querySelector('input').style.width='88px';}move('ground-status',document.getElementById('exterior-debug-general')||document.getElementById('wall-panel'));if(old&&old!==bar&&!old.querySelector('button,input,select'))old.remove();
 move('wall-advanced',main);
 const headerIcons={'wall-rebuild':'home','wall-merge-all':'object-group','base-rebuild-grade':'level-down-alt'};
 for(const [id,name]of Object.entries(headerIcons)){const button=document.getElementById(id);if(button){const label=button.textContent;button.innerHTML='<i class="fas fa-'+name+'" aria-hidden="true"></i><span>'+label+'</span>';}}
 const gear=document.querySelector('#wall-advanced>summary');if(gear)gear.innerHTML='<i class="fas fa-cog" aria-hidden="true"></i>';
 main.querySelectorAll('button').forEach(b=>b.classList.add('toolbar-btn'));
 const headerStyle=document.createElement('style');headerStyle.textContent=`
 .wall-mode-active #global-toolbar [data-roof-only],.wall-mode-active #toolbar-mode-shell,.wall-mode-active #layer-controls-group{display:none!important}
 .wall-mode-active #global-toolbar .controls-group:has(>[data-roof-only]):not(:has(>button:not([data-roof-only]))):not(:has(>input)){display:none!important}
 .wall-mode-active #global-toolbar,.wall-mode-active #global-toolbar.toolbar-split{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:none;grid-template-rows:auto;align-items:start;gap:12px;padding:6px 12px;min-height:44px}
 #wall-header-left{display:none}.wall-mode-active #wall-header-left{display:flex;grid-column:1;grid-row:1;align-items:center;flex-wrap:wrap;gap:8px;min-width:0}
 .wall-mode-active #global-toolbar .toolbar-row,.wall-mode-active #global-toolbar .toolbar-section-left{display:contents}
 .wall-mode-active #global-toolbar .toolbar-row-primary>.toolbar-section-right{display:none}
 .wall-mode-active #global-toolbar .wall-header-actions{display:flex;grid-column:2;grid-row:1;justify-self:end;justify-content:flex-end;margin-left:auto}
 .wall-mode-active #global-toolbar #toolbar-action-group{padding-right:0}
 .wall-mode-active #global-toolbar .controls-group{margin:0!important;gap:5px;padding-right:8px;flex:none}
 #exterior-main-toolbar{display:none}.wall-mode-active #exterior-main-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;border-left:1px solid #cbd0d7;padding-left:12px;font:12px system-ui;color:#202124}
 #exterior-main-toolbar .exterior-toolbar-group{display:flex;align-items:center;gap:5px;position:relative;flex-wrap:wrap}
 #exterior-main-toolbar button,#exterior-main-toolbar #roof-trim-control button{display:inline-flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;height:34px;min-height:34px;padding:6px 10px;border:1px solid #ccc;border-radius:4px;background:#fff;color:#202124;font:600 12px system-ui;cursor:pointer;white-space:nowrap}
 #exterior-main-toolbar button:hover,#exterior-main-toolbar #roof-trim-control button:hover{background:#f0f2f5}
 #exterior-main-toolbar button[aria-pressed=true],#exterior-main-toolbar #roof-trim-control button[aria-pressed=true]{background:#e8f0fe;color:#1a73e8;border-color:#1a73e8}
 #exterior-main-toolbar button:disabled{opacity:.45;cursor:default}
 #exterior-main-toolbar #wall-rebuild{border-radius:4px 0 0 4px;margin-right:-6px}#exterior-main-toolbar #wall-auto{border-radius:0 4px 4px 0}
 #exterior-main-toolbar #wall-soffit-menu{position:absolute;top:calc(100% + 6px);left:0;width:220px;padding:6px;background:#fff;border:1px solid #ccd2d9;border-radius:5px;box-shadow:0 5px 18px #0002;z-index:3000}
 #exterior-main-toolbar [hidden]{display:none!important}#exterior-main-toolbar .soffit-title{padding:5px;font-weight:600}#exterior-main-toolbar .soffit-options{display:grid;gap:3px}
 #exterior-main-toolbar .soffit-options button{display:flex;justify-content:space-between;align-items:center;border:0;text-align:left}#exterior-main-toolbar .soffit-options small{color:#77808c}
 #exterior-main-toolbar .exterior-grade-sources{display:flex;gap:0;border:1px solid #ccc;border-radius:4px;overflow:hidden;background:#fff;padding:0}
 #exterior-main-toolbar .exterior-grade-sources button{height:34px;min-height:34px;border:0;border-radius:0;padding:6px 8px;font-size:10px;background:#fff;box-shadow:none}
 #exterior-main-toolbar .exterior-grade-sources button+button{border-left:1px solid #eee}
 #exterior-main-toolbar .exterior-grade-sources button:hover{background:#eee}
 #exterior-main-toolbar .exterior-grade-sources button[aria-pressed=true]{background:#e8f0fe;color:#1a73e8;box-shadow:none}
 #exterior-main-toolbar #wall-advanced{color:#394150}
 #exterior-main-toolbar #wall-advanced>summary{display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:36px;height:34px;padding:0;border:1px solid #ccc;border-radius:4px;background:#fff;color:#202124;font-size:12px}
 #exterior-main-toolbar #wall-advanced>summary:hover{background:#f0f2f5}#exterior-main-toolbar #wall-advanced[open]>summary{background:#e8f0fe;color:#1a73e8;border-color:#1a73e8}
 #exterior-main-toolbar #wall-advanced>div{top:calc(100% + 6px);background:#fff;border-color:#ccd2d9;box-shadow:0 5px 18px #0002;z-index:3000}
 #exterior-main-toolbar #wall-advanced label{gap:8px;white-space:normal}#exterior-main-toolbar #wall-advanced input{width:auto;padding:0}#exterior-main-toolbar #wall-advanced p{color:#667085;line-height:1.5}
 #exterior-main-toolbar label{display:flex;align-items:center;gap:4px;margin:0}#exterior-main-toolbar input{width:58px;border:1px solid #ccc;border-radius:4px;background:#fff;color:#444;padding:4px}
 #exterior-main-toolbar #roof-trim-options{width:max-content;max-width:calc(100vw - 28px);box-sizing:border-box;background:#fff;color:#394150;border-color:#ccd2d9;box-shadow:0 5px 18px #0002;left:0;right:auto;padding:8px}
 #exterior-main-toolbar #roof-trim-options .trim-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:4px 0}
 #exterior-main-toolbar #roof-trim-options .trim-row+.trim-row{border-top:1px solid #dfe3e8;padding-top:8px;margin-top:4px}
 #exterior-main-toolbar #roof-trim-options .trim-row>strong{width:38px;color:#202124}
 #exterior-main-toolbar #roof-trim-options label{margin:0;gap:4px;white-space:nowrap}
 #exterior-main-toolbar #roof-trim-options input,#exterior-main-toolbar #roof-trim-options select{background:#fff;color:#444;border:1px solid #ccc;border-radius:4px;padding:4px;width:62px}
 #exterior-main-toolbar #roof-trim-options select{width:80px}#exterior-main-toolbar #roof-trim-options input[type=color]{width:28px;height:28px;padding:2px}
 #exterior-main-toolbar #roof-trim-count{font-size:11px;color:#667085}
 #exterior-main-toolbar .trim-material-section{border-top:1px solid #dfe3e8;margin-top:4px;padding-top:8px;max-width:640px}
 #exterior-main-toolbar .trim-material-heading{display:flex;align-items:center;gap:6px;margin-bottom:6px}#exterior-main-toolbar .trim-material-heading>strong{margin-right:auto}
 #exterior-main-toolbar #trim-material-grid{display:flex;flex-wrap:wrap;gap:5px}#exterior-main-toolbar #trim-material-grid button{font-weight:400;height:28px;min-height:28px;padding:4px 7px}
 #exterior-main-toolbar #trim-material-grid button:before{content:'';width:10px;height:10px;border:1px solid #0002;border-radius:2px;background:var(--material-color)}
 #wall-resoffit-control{position:relative}#wall-resoffit-menu[hidden]{display:none!important}
 #wall-resoffit-menu{position:absolute;top:calc(100% + 6px);left:0;width:270px;box-sizing:border-box;padding:10px;background:#fff;color:#394150;border:1px solid #ccd2d9;border-radius:6px;box-shadow:0 5px 18px #0002;z-index:3000}
 #wall-resoffit-menu p{margin:0 0 8px;line-height:1.4;font-weight:400}#wall-resoffit-menu label{justify-content:space-between;margin:8px 0}#wall-resoffit-presets{display:flex;gap:3px;flex-wrap:wrap;margin:8px 0}#wall-resoffit-presets button{padding:4px 7px;height:28px;min-height:28px}
 #wall-resoffit[aria-pressed=true]{color:#b44323!important;border-color:#ef633c!important;background:#fff0e9!important}
 #wall-auto-trim{display:none!important}
 `;document.head.appendChild(headerStyle);
 bar.addEventListener('wheel',e=>e.stopPropagation(),{passive:true});
};
