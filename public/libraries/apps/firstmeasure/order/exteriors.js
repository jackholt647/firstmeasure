/* Flagged customer Full Structure ordering. State stays separate from the roof workflow. */
(function(){
  const P=window.Portal, esc=P.util.escapeHtml, views=['front','front-right','right','back-right','back','back-left','left','front-left'];
  let ctx=null,root=null,scope=null,page=0,quote=null,delivery='exteriors_standard',busy=false,error='',notes='',lastType='',lastCount=0,generation=0;
  const files=new Map();
  let photoWorkspace=null, referenceViewer=null, workspaceFilter='all', workspaceStep=false, closingViewer=false, workspaceSuspended=false;
  window.addEventListener?.('fm:modal:open',event=>{if(event.detail?.id==='request'){workspaceSuspended=event.detail.open===false;if(workspaceSuspended)removePhotoWorkspace();}});
  const photoKey=photo=>[...files].find(([,f])=>f.media_id===photo.media_id)?.[0];
  function closeReferenceViewer(){const viewer=referenceViewer;referenceViewer=null;closingViewer=true;try{viewer?.close();}finally{closingViewer=false;}}
  function removePhotoWorkspace(){closeReferenceViewer();photoWorkspace?.remove();photoWorkspace=null;document.getElementById('rOverlay')?.classList.remove('exteriors-photos');workspaceStep=false;}
  function referenceSource(f){return f.url||window.PlatformAPI?.media?.fileUrl?.(P.cfg.userOrgId||P.cfg.orgId,f.media_id)||'';}
  function referenceThumbnail(f){return f.thumbnail||referenceSource(f);}
  window.addEventListener?.('fm:media-renamed',event=>{
    const detail=event.detail||{},entry=[...files.values()].find(f=>f.media_id===detail.mediaId);
    if(entry&&detail.name){entry.name=detail.name;render();}
  });
  window.addEventListener?.('fm:media-markup-saved',event=>{
    const detail=event.detail||{},entry=[...files.values()].find(f=>f.media_id===detail.mediaId);
    if(entry&&window.PlatformAPI?.media?.markupThumbnailUrl){entry.thumbnail=window.PlatformAPI.media.markupThumbnailUrl(detail.orgId,detail.mediaId,640,detail.revision||Date.now());render();}
  });
  function assignmentLabel(key){return key.startsWith('tray:')?'Unassigned':`Structure ${Number(key.split(':')[0])+1} · ${key.includes(':additional')?'Extra reference':label(key.split(':')[1])}`;}
  function viewReference(key){
    const entry=files.get(key);if(!entry?.media_id||!window.FirstMateMarkup?.openPhotoViewer)return;
    closeReferenceViewer();selectedPhoto=key;render();
    const photos=[...files].filter(([,f])=>f.media_id).map(([,f])=>({id:f.media_id,media_id:f.media_id,src:referenceSource(f),name:f.name,label:f.name,content_type:f.file?.type||'image/jpeg'}));
    referenceViewer=window.FirstMateMarkup.openPhotoViewer({photos,index:photos.findIndex(p=>p.media_id===entry.media_id),project:{title:'Exterior reference photos'},boundsTarget:photoWorkspace?.querySelector('[data-reference-gallery]')||root?.querySelector('.ext-photo-grid'),embedded:!!photoWorkspace,projectLinkEnabled:false,
      onChange:({photo})=>{const key=photoKey(photo);if(key&&selectedPhoto!==key){selectedPhoto=key;render();}},
      onClose:()=>{referenceViewer=null;if(!closingViewer)renderPhotoWorkspace();}
    });
    for(const event of ['dragenter','dragover','dragleave','drop','dragend'])referenceViewer.el?.addEventListener(event,e=>photoWorkspace?.['on'+event]?.(e));
    return referenceViewer;
  }
  function renderPhotoWorkspace(){
    if(document.getElementById('rOverlay')?.classList.contains('mobile-order')){
      if(photoWorkspace||workspaceStep)removePhotoWorkspace();
      return;
    }
    const visible=active()&&page>0&&!root.hidden&&!workspaceSuspended;
    document.getElementById('rOverlay')?.classList.toggle('exteriors-photos',!!visible);
    if(!visible){if(workspaceStep){removePhotoWorkspace();ctx?.showMap?.();}return;}
    const entering=!workspaceStep;workspaceStep=true;
    if(entering){ctx.syncPhotoTabs?.();ctx.showPhotos?.();}
    const right=document.querySelector('#rOverlay .r-preview-panel[data-panel="photos"]');if(!right)return;
    if(!photoWorkspace?.isConnected){
      photoWorkspace=document.createElement('section');photoWorkspace.className='ext-workspace';photoWorkspace.setAttribute('aria-label','Exterior upload photos');
      photoWorkspace.innerHTML=`<div class="ext-workspace-gallery" data-reference-gallery></div><div class="ext-workspace-drop" hidden>Drop photos to upload</div><input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden data-workspace-picker>`;
      right.append(photoWorkspace);
      const input=photoWorkspace.querySelector('[data-workspace-picker]');
      photoWorkspace.addEventListener('click',e=>{if(e.target.closest('[data-unassigned-filter]')){workspaceFilter=workspaceFilter==='all'?'unassigned':'all';closeReferenceViewer();renderPhotoWorkspace();}});

      input.onchange=()=>{for(const file of Array.from(input.files))void upload(file,'tray:'+crypto.randomUUID());input.value='';};
      let depth=0;const clear=()=>{depth=0;photoWorkspace?.classList.remove('dragging');};
      photoWorkspace.ondragenter=e=>{if(!Array.from(e.dataTransfer?.types||[]).includes('Files'))return;e.preventDefault();depth++;photoWorkspace.classList.add('dragging');};
      photoWorkspace.ondragover=e=>{if(!Array.from(e.dataTransfer?.types||[]).includes('Files'))return;e.preventDefault();e.dataTransfer.dropEffect='copy';};
      photoWorkspace.ondragleave=e=>{if(--depth<=0||!photoWorkspace.contains(e.relatedTarget))clear();};
      photoWorkspace.ondrop=e=>{if(!Array.from(e.dataTransfer?.types||[]).includes('Files'))return;e.preventDefault();e.stopPropagation();clear();for(const file of Array.from(e.dataTransfer.files))void upload(file,'tray:'+crypto.randomUUID());};
      photoWorkspace.ondragend=clear;
      photoWorkspace.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{workspaceFilter=b.dataset.filter;closeReferenceViewer();renderPhotoWorkspace();});
    }
    photoWorkspace.classList.toggle('has-no-photos',files.size===0);
    const gallery=photoWorkspace.querySelector('[data-reference-gallery]');
    if(referenceViewer)return;
    const entries=[...files].filter(([key])=>workspaceFilter==='all'||key.startsWith('tray:'));
    if(!P.PhotoFeed?.mountProjectGallery){gallery.textContent='Loading Photos…';return;}
    const photos=entries.map(([key,f])=>({id:f.media_id||key,media_id:f.media_id,src:referenceSource(f),thumb:referenceThumbnail(f),label:f.name,name:f.name,tags:[assignmentLabel(key)],uploaded_at:f.uploaded_at||new Date().toISOString(),uploaded_by_name:P.cfg.userName||window.__APP?.userName||'You',content_type:f.file?.type||'image/jpeg'}));
    P.PhotoFeed.mountProjectGallery(gallery,{
      project:{id:'exterior-order',title:'Exterior uploads'},photos,title:'',emptyTitle:workspaceFilter==='unassigned'?'All photos assigned':'Drag photos here',emptyMessage:files.size?'Upload project media or adjust the search.':'Drop your photos here, or use Upload to choose files.',uploadLabel:'Upload',initialDensity:'loose',selectionEnabled:false,enableProjectLinks:false,projectLinkEnabled:false,
      renderDaySummary:()=>{const uploading=[...files.values()].filter(f=>f.uploading).length;return `<span>${files.size} photos</span><span>${files.size-unassigned().length} assigned</span><span data-upload-summary role="status" ${uploading?'':'hidden'}>Uploading ${uploading} photo${uploading===1?'':'s'}</span>`;},
      renderGroupUploaders:()=>`<button type="button" class="ext-tool" data-unassigned-filter aria-pressed="${workspaceFilter==='unassigned'}">${unassigned().length} unassigned${workspaceFilter==='unassigned'?' · Show all':''}</button>`,
      onUpload:()=>photoWorkspace.querySelector('[data-workspace-picker]').click(),
      onItemDragStart:({item,event})=>{const key=entries.find(([k,f])=>(f.media_id||k)===(item.photo.media_id||item.photo.id))?.[0];if(!key)return;selectedPhoto=key;event.dataTransfer.setData('application/x-exterior-reference',key);event.dataTransfer.effectAllowed='move';},
      onOpenItem:({item})=>{const key=entries.find(([,f])=>f.media_id?f.media_id===item.photo.media_id:referenceSource(f)===item.photo.src)?.[0];if(key){selectedPhoto=key;render();return viewReference(key);}},
      toolbarActions:[...(workspaceFilter==='unassigned'?[{id:'show-all',label:'Show all photos',showLabel:true,onClick:()=>{workspaceFilter='all';renderPhotoWorkspace();}}]:[]),{id:'upload-hint',label:'Drag photos here',showLabel:true,icon:'fa-cloud-arrow-up',onClick:()=>photoWorkspace.querySelector('[data-workspace-picker]').click()}]
    });

    const pending=entries.filter(([,f])=>f.error);
    if(pending.length){const status=document.createElement('div');status.className='ext-upload-status';status.setAttribute('role','status');status.innerHTML=pending.map(([key,f])=>`<p>${esc(f.name)}: ${f.uploading?'Uploading…':esc(f.error)} ${f.error?`<button type="button" class="ext-tool" data-retry-reference="${esc(key)}">Retry</button>`:''}</p>`).join('');gallery.prepend(status);status.querySelectorAll('[data-retry-reference]').forEach(b=>b.onclick=()=>send(files.get(b.dataset.retryReference)));}

  }
  let uploadsInFlight=0;const uploadWaiters=[];
  let selectedPhoto=null, structure=0, confirmedPins=null, pinSignature='', mapOpen=false;
  const pinsConfirmed=()=>!!ctx?.count && (ctx.locationConfirmed ?? confirmedPins===pinSignature);
  const reviewTestEnabled=()=>quote?.allow_incomplete_photo_review===true;
  const photosReviewable=()=> (ready()||reviewTestEnabled()) && !unassigned().length && !pending();
  const shared=new Map();
  function restoreShared(){for(const {node,home} of shared.values())if(home.isConnected)home.after(node);}
  function mountShared(id,slot,group=false){const node=document.getElementById(id);const target=root.querySelector(slot);if(!node||!target)return;const element=group?node.closest('.r-group'):node;if(!shared.has(id)||shared.get(id).node!==element){const home=document.createComment('shared '+id);element.before(home);shared.set(id,{node:element,home});}target.append(element);}

  function scopeIcon(value){
    const path=value==='roof'
      ? 'M9.5 4a2 2 0 0 0-1.6.8L1.4 14a1.25 1.25 0 0 0 1 2h19.2a1.25 1.25 0 0 0 1-2l-6.5-9.2a2 2 0 0 0-1.6-.8h-5ZM4 18a1.5 1.5 0 0 0 0 3h16a1.5 1.5 0 0 0 0-3H4Z'
      : 'M10.7 2.5a2 2 0 0 1 2.6 0l9 7.5a1.4 1.4 0 0 1-.9 2.5H20V20a2 2 0 0 1-2 2h-3v-6a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v6H6a2 2 0 0 1-2-2v-7.5H2.6a1.4 1.4 0 0 1-.9-2.5l9-7.5ZM6 11v3h3v-3H6Zm9 0v3h3v-3h-3Z';
    return `<svg class="ext-scope-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" fill-rule="evenodd" d="${path}"/></svg>`;
  }

  const pending=()=>[...files.values()].some(f=>f.uploading||f.error);
  const unassigned=()=>[...files.keys()].filter(k=>k.startsWith('tray:'));
  const canVisit=i=>!busy && (i===0 || (pinsConfirmed() && !!option() && (i===1 || photosReviewable())));
  function go(i){if(!canVisit(i))return;page=i;mapOpen=false;render();const scroller=root?.closest('.r-scroll');if(scroller)scroller.scrollTop=0;root?.querySelector('[aria-current="step"]')?.focus();}
  function assign(from,to){
    if(from===to){selectedPhoto=null;render();return;}
    const photo=files.get(from);if(!photo)return;
    const displaced=files.get(to);files.delete(from);files.set(to,photo);
    // Replacing a view never discards the previous photo: keep it in the tray.
    if(displaced)files.set('tray:'+crypto.randomUUID(),displaced);
    selectedPhoto=referenceViewer?to:unassigned()[0]||null;render();
  }
  function pick(key,multiple=false){const input=root.querySelector('[data-picker]');input.multiple=multiple;input.onchange=()=>{const picked=[...input.files];input.value='';for(const file of picked)void upload(file,key||'tray:'+crypto.randomUUID());};input.click();}

  const label=v=>v.split('-').map(s=>s[0].toUpperCase()+s.slice(1)).join(' ');
  const money=n=>'$'+Number(n).toFixed(2);
  const allowed=type=>P.capabilities?.value?.('firstmeasure.exteriors',false)===true && (type==='residential'||P.capabilities?.value?.('firstmeasure.exteriors_'+type,false)===true);
  const active=()=>scope==='full_house' && ctx && allowed(ctx.type) && !ctx.ordered;
  const closed=()=>ctx?.closed===true||quote?.ordering_closed===true;
  const option=()=>quote?.options.find(o=>o.key===delivery);
  const ready=()=>!!ctx?.count && Array.from({length:ctx.count},(_,i)=>views.every(v=>files.get(i+':'+v)?.media_id)).every(Boolean);
  const css=`
  .ext-order{margin:8px 0 14px;color:#344054;font-size:12px}.ext-order *{box-sizing:border-box}.ext-order [hidden]{display:none!important}
  .ext-choices{display:grid;grid-template-columns:1fr 1fr;gap:8px}.ext-choice,.ext-delivery{font:inherit;cursor:pointer;border:1px solid #d0d5dd;border-radius:12px;background:#fff;color:#344054;padding:14px;text-align:left;display:grid;gap:6px}
  .ext-choice strong{font-size:11px;font-weight:900}.ext-choice span,.ext-order p{font-size:12px;line-height:1.5;color:#667085}.ext-choice.selected,.ext-delivery.selected{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.06)}
  .ext-choices.compact .ext-choice{padding:8px 10px}.ext-choices.compact .ext-choice span{display:none}.ext-choices.compact strong{font-size:11px}
  .ext-order [data-reload]{border:0;background:none;color:var(--primary,#d93025);font:inherit;text-decoration:underline;cursor:pointer;padding:3px}.ext-pages{margin-top:14px}.ext-progress{display:flex;justify-content:space-between;gap:6px;font-size:10px;color:#667085;border-bottom:1px solid #eaecf0;padding-bottom:10px;margin-bottom:14px}.ext-progress strong{color:var(--primary,#d93025)}
  .ext-order h3{font-size:16px;margin:0 0 8px}.ext-deliveries{display:grid;gap:8px}.ext-delivery{grid-template-columns:1fr auto;align-items:center}.ext-delivery small{grid-column:1/-1;color:#667085}.ext-busy{padding:12px;background:#f8fafc;border-radius:10px;margin:12px 0}.ext-meter{height:5px;background:linear-gradient(90deg,#39a76c,#e8b751,#d93025);border-radius:6px;margin-top:9px;position:relative}.ext-meter i{position:absolute;top:-3px;height:11px;width:5px;border:1px solid white;background:#344054;border-radius:4px;left:var(--load)}
  .ext-notes{width:100%;min-height:80px;border:1px solid #d0d5dd;border-radius:10px;padding:10px;font:inherit;margin-top:6px}.ext-nav{display:flex;gap:8px;margin-top:14px;position:sticky;bottom:0;background:#fff;padding:10px 0 2px;z-index:4;border-top:1px solid #eaecf0}.ext-nav button{flex:1;border:1px solid #d0d5dd;border-radius:10px;padding:11px;font:inherit;font-weight:700;cursor:pointer;background:#fff;color:#344054}.ext-nav .primary{background:var(--primary,#d93025);color:#fff;border-color:transparent}.ext-order button:disabled{opacity:.5;cursor:not-allowed}.ext-error{color:#b42318!important}.ext-summary{padding:14px;background:#f8fafc;border:1px solid #e4e7ec;border-radius:12px;display:grid;gap:10px}.ext-summary div{display:flex;justify-content:space-between;gap:10px}.ext-summary strong{text-align:right}.ext-summary .total{border-top:1px solid #d0d5dd;padding-top:12px;font-size:17px}
  .r-overlay.exteriors-active #rStepReport,.r-overlay.exteriors-choose #rStepReport,.r-overlay.exteriors-active #rExpeditePanel{display:none!important}
  @media(max-width:720px){.r-overlay.mobile-order .ext-progress,.r-overlay.mobile-order .ext-nav{display:none}.r-overlay.mobile-order-location.exteriors-active .ext-order [data-pin-mount],.r-overlay.mobile-order-location.exteriors-active .ext-order [data-notes-mount],.r-overlay.mobile-order-location.exteriors-active .ext-order [data-cc-mount],.r-overlay.mobile-order-location.exteriors-active .ext-order .ext-delivery-heading,.r-overlay.mobile-order-location.exteriors-active .ext-order .r-expedite-panel,.r-overlay.mobile-order-location.exteriors-active .ext-order .ext-price-unit,.r-overlay.mobile-order-location.exteriors-active .ext-map-edit{display:none!important}.r-overlay.mobile-order-details.exteriors-active .ext-order [data-pin-mount],.r-overlay.mobile-order-details.exteriors-active .ext-order [data-confirm-mount],.r-overlay.mobile-order-details.exteriors-active .ext-map-edit{display:none!important}.r-overlay.mobile-order-photos.exteriors-active #rStepCustomer,.r-overlay.mobile-order-photos.exteriors-active #rStepAddress,.r-overlay.mobile-order-photos.exteriors-active #rStepType,.r-overlay.mobile-order-final.exteriors-active #rStepCustomer,.r-overlay.mobile-order-final.exteriors-active #rStepAddress,.r-overlay.mobile-order-final.exteriors-active #rStepType{display:none!important}}
  .ext-progress button{flex:1;border:0;border-bottom:2px solid transparent;background:none;padding:8px 2px;font:inherit;font-size:11px;cursor:pointer;color:#667085;min-height:38px}.ext-progress button[aria-current=step]{color:var(--primary,#d93025);border-color:currentColor;font-weight:700}.ext-progress{padding:0;gap:4px}
  .r-overlay.exteriors-active:not(.mobile-order) .r-left-bottom{display:flex}.r-overlay.exteriors-details:not(.mobile-order) #rStepCustomer,.r-overlay.exteriors-details:not(.mobile-order) #rStepAddress{display:none!important}
  .ext-toolbar{display:flex;align-items:center;gap:8px;margin:12px 0}.ext-tool{border:1px solid #d0d5dd;border-radius:9px;background:white;color:#344054;font:inherit;padding:9px 12px;cursor:pointer;min-height:38px}.ext-toolbar .ext-tool{flex:1}.ext-toolbar select{min-width:0;max-width:45%;font:inherit;padding:9px;border:1px solid #d0d5dd;border-radius:9px}
  .ext-toolbar .ext-drop-zone{display:flex;flex-direction:column;align-items:center;gap:6px;padding:18px 12px;border:2px dashed #98a2b3;border-radius:12px;background:#f8fafc;text-align:center}.ext-drop-zone>i{font-size:22px;color:var(--primary,#d93025)}.ext-drop-zone span,.ext-drop-zone small{color:#667085}.ext-drop-zone:hover,.ext-order.is-file-drag .ext-drop-zone{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.08)}.ext-order.is-file-drag .ext-photo-grid{outline:2px dashed var(--primary,#d93025);outline-offset:4px;border-radius:10px}
  .ext-photo-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}.ext-view{position:relative;min-width:0;min-height:82px;border:1px dashed #cbd5e1;border-radius:10px;background:#f8fafc;overflow:hidden}.ext-view>button{width:100%;height:100%;min-height:82px;padding:8px 3px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;border:0;background:none;color:#475467;font:inherit;font-size:11px;cursor:pointer}.ext-view .ext-plus{font-size:22px;line-height:1;color:var(--primary,#d93025)}.ext-view.done{border:1px solid #75b798}.ext-view.has-photo>button{justify-content:end;padding:0}.ext-view img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.ext-view .ext-caption{position:relative;z-index:1}.ext-view.has-photo .ext-caption{width:100%;padding:5px 2px;background:rgba(16,24,40,.78);color:white}.ext-view.selected{outline:2px solid var(--primary,#d93025);outline-offset:1px}.ext-view .ext-remove{position:absolute;right:3px;top:3px;z-index:2;width:32px;height:32px;min-height:0;padding:0;background:white;border-radius:50%;color:#344054;box-shadow:0 1px 4px #0003;font-size:17px}.ext-house{display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--primary,#d93025);font-size:9px;gap:3px}.ext-house svg{width:62px;height:48px;max-width:80%}.ext-street{margin:7px 0 12px;padding:5px;background:#eef1f5;border-radius:6px;text-align:center;letter-spacing:1px;font-size:9px;color:#667085}.ext-count{display:flex;justify-content:space-between;gap:8px;align-items:center;margin:8px 0;font-size:11px}.ext-count strong{color:var(--primary,#d93025)}
  .ext-tray{padding:10px;background:#f8fafc;border:1px solid #e4e7ec;border-radius:10px;margin:10px 0}.ext-tray p{margin:0 0 8px}.ext-thumbs{display:flex;gap:7px;overflow-x:auto;padding:3px 2px 6px}.ext-thumb{flex:0 0 72px;min-width:0}.ext-thumb>button:first-child{position:relative;width:72px;height:58px;padding:0;border:2px solid transparent;border-radius:8px;overflow:hidden;background:#e4e7ec;cursor:pointer}.ext-thumb.selected>button:first-child{border-color:var(--primary,#d93025)}.ext-thumb img{width:100%;height:100%;object-fit:cover}.ext-thumb small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px}.ext-thumb .ext-tool{padding:3px;min-height:28px;font-size:10px;width:100%;margin-top:3px}.ext-selection img{width:42px;height:42px;border-radius:6px;object-fit:cover;float:left;margin-right:8px}.ext-selection strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ext-selection{padding:9px;border-radius:9px;background:rgba(var(--primary-rgb,217,48,37),.07);line-height:1.5;margin:8px 0}.ext-selection .ext-tool{margin:5px 4px 0 0;padding:5px 8px;font-size:11px;min-height:32px}.ext-order details{margin-top:12px}.ext-order summary{cursor:pointer;padding:8px 0;font-weight:600}.ext-pin-confirm{display:flex;align-items:center;gap:8px;margin:12px 0;padding:12px;border:1px solid #d0d5dd;border-radius:10px;cursor:pointer}.ext-pin-confirm input{accent-color:var(--primary,#d93025);width:18px;height:18px;flex-shrink:0}.ext-map-return{display:none}
  .ext-choices[hidden]{display:none!important}
  .ext-choice-wrap{position:relative}.ext-choice-wrap .ext-choice{width:100%;height:100%;padding:12px 30px 12px 12px}.ext-choice-wrap>.ext-choice-info{position:absolute;right:7px;top:50%;transform:translateY(-50%);border:0;padding:0;cursor:pointer}.ext-choice strong{display:flex;align-items:center;gap:6px}.ext-scope-icon{width:14px;height:14px;flex-shrink:0;display:block}.r-order-select>.ext-scope-icon{position:absolute;left:9px;pointer-events:none}.ext-choice strong>i{font-size:11px}.ext-info{font:inherit;border:0;background:none;color:var(--primary,#d93025);cursor:pointer;padding:8px 0}.ext-delivery-heading{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:12px}.ext-delivery-heading h3{margin:0}.ext-price-unit{font-size:10px!important;margin:6px 0}.ext-order #rConfirm{margin:10px 0;cursor:pointer}.ext-map-edit{display:none}.ext-test-notice{padding:10px;border:1px solid #e6c778;border-radius:8px;background:#fffaeb;color:#754b0d!important}.ext-order [data-notes-mount] .r-group{margin-top:12px}.ext-order [data-cc-mount] .r-group{margin-top:12px}
  @media(max-width:720px){.ext-map-edit{display:block;width:100%;margin:8px 0}.ext-order #rConfirm{display:flex!important}.ext-choice strong,.ext-choices.compact strong{font-size:12px}.ext-choice-wrap .ext-choice{min-height:54px;padding:12px 30px 12px 12px}}
  @media(max-width:420px){.ext-order .r-expedite-options{grid-template-columns:1fr}.ext-order .r-expedite-btn{min-height:64px}}
  .ext-order button:focus-visible,.ext-order select:not(.r-order-select select):focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:3px}
  @media(max-width:720px){.r-overlay.exteriors-map .r-left{display:none!important}.r-overlay.exteriors-map .r-right{display:flex!important;width:100%;flex:1;min-height:0}.r-overlay.exteriors-map .ext-map-return{display:block;position:absolute;bottom:18px;left:50%;transform:translateX(-50%);z-index:200;border:0;border-radius:12px;padding:14px 22px;background:var(--primary,#d93025);color:#fff;font:inherit;font-weight:700;box-shadow:0 3px 16px #0003;white-space:nowrap}}
  `;
  P.util.injectCSS('exterior-order',css);
  P.util.injectCSS('exterior-photo-workspace',`
    .r-overlay.exteriors-photos .r-preview-panel[data-panel=photos]{overflow:hidden}
    .ext-workspace{position:absolute;inset:0;display:flex;flex-direction:column;gap:16px;padding:24px;background:#f8fafc;color:#344054;min-height:0;z-index:10;font-size:13px}
    .ext-workspace *{box-sizing:border-box}.ext-workspace [hidden]{display:none!important}
    .ext-workspace header{display:flex;justify-content:space-between;align-items:center;gap:16px}.ext-workspace h2{margin:0;font-size:22px}.ext-workspace p{margin:6px 0 0;color:#667085;line-height:1.5}
    .ext-workspace-assignment{display:flex;align-items:center;gap:12px;background:#fff;border:1px solid #e4e7ec;border-radius:12px;padding:12px}.ext-workspace-assignment>div{flex:1;min-width:0}.ext-workspace-assignment strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ext-workspace-assignment small{display:block;color:#667085;margin-top:5px}.ext-workspace-assignment label{display:grid;gap:4px;font-size:11px}.ext-workspace select{font:inherit;border:1px solid #d0d5dd;border-radius:8px;padding:8px;background:white;color:#344054;max-width:100%}
    .ext-workspace-filters{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.ext-reference-status{margin-left:auto;display:flex;align-items:center;gap:14px;flex-wrap:wrap;color:#667085}.ext-reference-status [data-upload-summary]{color:var(--primary,#d93025);font-weight:600}.ext-workspace [aria-pressed=true]{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.06)}
    .ext-workspace.has-no-photos .pf-empty{border:2px dashed #98a2b3;border-radius:12px;padding:48px 24px;margin:20px 0;max-width:none;min-height:240px;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#fff}
    .ext-workspace-gallery{position:relative;flex:1;min-height:0;overflow:auto}.ext-workspace-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:16px;padding:3px}
    .ext-workspace-card{border:1px solid #e4e7ec;border-radius:14px;overflow:hidden;background:#fff;min-width:0;padding-bottom:12px}.ext-workspace-card.selected{border:2px solid var(--primary,#d93025)}.ext-workspace-thumbnail{position:relative;width:100%;padding:0;border:0;display:block;background:#e4e7ec;cursor:pointer}.ext-workspace-thumbnail img{display:block;width:100%;aspect-ratio:4/3;object-fit:cover}.ext-workspace-thumbnail span{position:absolute;left:8px;bottom:8px;background:#fff;color:#344054;border-radius:6px;padding:5px 8px;font-size:11px}.ext-workspace-card>strong,.ext-workspace-card>small{display:block;margin:10px 12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ext-workspace-card>small{color:#667085;white-space:normal}.ext-workspace-card>div{display:flex;flex-wrap:wrap;gap:6px;margin:0 12px}.ext-workspace-card .ext-tool{font-size:11px;padding:7px 9px}
    .ext-workspace-empty{width:100%;min-height:280px;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;border:2px dashed #98a2b3;border-radius:16px;background:white;color:#667085;font:inherit;cursor:pointer}.ext-workspace-empty strong{font-size:22px;color:#344054}.ext-workspace-empty i{font-size:32px;color:var(--primary,#d93025)}
    .ext-workspace.dragging .ext-workspace-drop{display:flex!important;position:absolute;inset:16px;align-items:center;justify-content:center;border:3px dashed var(--primary,#d93025);border-radius:16px;background:#f8fafcf2;color:var(--primary,#d93025);font-size:24px;font-weight:700;pointer-events:none;z-index:20}.ext-view.drop-target{outline:3px solid var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.1)}
    .ext-workspace button:focus-visible,.ext-workspace select:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
    @media(min-width:721px){.r-overlay.exteriors-photos .r-right{display:flex!important;min-height:0}}
    @media(max-width:720px){.r-overlay.exteriors-photos .r-win{overflow:auto;flex-direction:column}.r-overlay.exteriors-photos .r-left{box-sizing:border-box;flex:0 0 auto!important;overflow:visible!important}.r-overlay.exteriors-photos .r-scroll{overflow:visible!important}.r-overlay.exteriors-photos .r-right{display:flex!important;flex:0 0 650px;min-height:650px;width:100%}.ext-workspace{padding:12px;gap:10px}.ext-workspace header{flex-wrap:wrap}.ext-workspace-assignment{flex-wrap:wrap}.ext-workspace-assignment>div{flex-basis:100%}.ext-workspace-cards{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.ext-workspace-card .ext-tool{width:100%}}
  `);
  function reset(){removePhotoWorkspace();workspaceSuspended=false;workspaceFilter='all';document.getElementById('rScopeSelect')?.remove();restoreShared();shared.clear();selectedPhoto=null;structure=0;confirmedPins=null;pinSignature='';mapOpen=false;document.getElementById('rOverlay')?.classList.remove('exteriors-map','exteriors-details');document.getElementById('extMapReturn')?.remove();generation++;for(const f of files.values())if(f.url)URL.revokeObjectURL(f.url);files.clear();scope=null;page=0;quote=null;delivery='exteriors_standard';busy=false;error='';notes='';lastType='';lastCount=0;root?.remove();root=null;}
  async function load(){const gen=generation;try{const {data}=await P.util.postAction('exteriors_quote',{project_type:ctx.type,structure_count:Math.max(1,ctx.count)});if(gen!==generation)return;if(!data?.success)throw Error(data?.message||data?.error||'Could not load prices.');quote=data;error='';}catch(e){if(gen!==generation)return;error=e.message;}render();}
  function photoUI(){
    structure=Math.max(0,Math.min(structure,ctx.count-1));
    const count=views.filter(v=>files.get(structure+':'+v)?.media_id).length;
    const order=['back-left','back','back-right','left',null,'right','front-left','front','front-right'];
    const selection=selectedPhoto&&files.get(selectedPhoto);
    return `<h3>${(globalThis.PlatformLanguage?.text("firstmeasure","m_8d70961775865d","Add your exterior photos") ?? "Add your exterior photos")}</h3><p>${(globalThis.PlatformLanguage?.text("firstmeasure","m_a758edd5a86c46","Eight views per house. Left and right are as you face the house from the street.") ?? "Eight views per house. Left and right are as you face the house from the street.")}</p><div class="ext-toolbar">${String(ctx.count>1?`<select aria-label="Structure" data-structure>${Array.from({length:ctx.count},(_,i)=>`<option value="${i}" ${i===structure?'selected':''}>Structure ${i+1}</option>`).join('')}</select>`:'')}</div><input type="file" accept="image/jpeg,image/png,image/webp" data-picker hidden><div class="ext-count"><span>${String(ctx.count>1?'Structure '+(structure+1):'Photo positions')}</span><strong role="status">${((v2) => globalThis.PlatformLanguage?.text("firstmeasure","m_cbe79335d5c117",`${v2} of 8 ready`,{v2}) ?? `${v2} of 8 ready`)(count)}</strong></div>
    ${String(selection?`<div class="ext-selection">${selection.url?`<img src="${selection.url}" alt="Selected photo">`:""}<strong>${esc(selection.name)}</strong>Tap a position below to assign.<br><button type="button" class="ext-tool" data-additional>Keep as extra</button><button type="button" class="ext-tool" data-cancel-selection>Deselect</button>${selection.error?'<button type="button" class="ext-tool" data-retry-selected>Retry upload</button>':''}</div>`:'')}
    <div class="ext-photo-grid">${String(order.map(v=>{if(!v)return `<div class="ext-house"><span>BACK</span><svg viewBox="0 0 80 60" aria-label="House viewed from above, front at bottom" role="img"><rect x="14" y="7" width="52" height="42" rx="4" fill="currentColor" opacity=".12"/><path d="M14 7L40 18L66 7M40 18V38M14 49L40 38L66 49" fill="none" stroke="currentColor" stroke-width="2"/><rect x="32" y="45" width="16" height="10" rx="2" fill="currentColor"/></svg><strong>FRONT ↓</strong></div>`;
    const key=structure+':'+v,f=files.get(key);return `<div class="ext-view ${f?'has-photo':''} ${f?.media_id?'done':''} ${selectedPhoto===key?'selected':''}"><button type="button" data-view="${key}" aria-label="${f?'Select':'Upload'} ${label(v)} photo" aria-pressed="${selectedPhoto===key}">${f&&referenceThumbnail(f)?`<img src="${esc(referenceThumbnail(f))}" alt="">`:!f?'<span class="ext-plus" aria-hidden="true">＋</span>':''}<span class="ext-caption">${label(v)}${f?`<br>${f.uploading?'Uploading…':f.error?'Retry upload':f.media_id?'✓':''}`:''}</span></button>${f?`<button type="button" class="ext-remove" data-remove="${key}" aria-label="Remove ${label(v)} photo">×</button>`:''}</div>`;}).join(''))}</div><div class="ext-street">${(globalThis.PlatformLanguage?.text("firstmeasure","m_0978cf3656f92e","FRONT OF HOUSE · STREET") ?? "FRONT OF HOUSE · STREET")}</div>

`;
  }
  function render(){const scroller=root?.closest('.r-scroll');const savedScroll=scroller?.scrollTop;const focused=document.activeElement;const caret=focused&&/^(INPUT|TEXTAREA)$/.test(focused.tagName)?[focused.selectionStart,focused.selectionEnd]:null;restoreShared();if(!ctx)return;const step=document.getElementById('rStepType');if(!step)return;
    if(!root?.isConnected){root=document.createElement('section');root.className='ext-order';root.id='rExteriorOrder';step.after(root);}
    const visible=!ctx.ordered && ctx.type && allowed(ctx.type) && ctx.orderWorkflow && (!ctx.mobileOrder || (ctx.type==='residential' && ctx.addressSelected && !ctx.typeTransitioning));
    const overlay=document.getElementById('rOverlay');const mobileOrder=!!overlay?.classList.contains('mobile-order');
    root.hidden=!visible||(mobileOrder&&scope==='roof');overlay?.classList.toggle('exteriors-active',!!visible&&active());overlay?.classList.toggle('exteriors-choose',!!visible&&!scope);
    overlay?.classList.toggle('exteriors-details',!!visible&&active()&&page>0);
    overlay?.classList.toggle('exteriors-map',!!visible&&active()&&mapOpen);
    let returnButton=document.getElementById('extMapReturn');
    if(!returnButton&&overlay){returnButton=document.createElement('button');returnButton.id='extMapReturn';returnButton.type='button';returnButton.className='ext-map-return';returnButton.textContent=(globalThis.PlatformLanguage?.text("firstmeasure","m_a1b1e8267a2fa9","Done · Return to order") ?? "Done · Return to order");overlay.querySelector('.r-right')?.append(returnButton);}
    if(returnButton)returnButton.onclick=()=>{mapOpen=false;render();};
    if(!visible||!scope)document.getElementById('rScopeSelect')?.remove();
    if(!visible){removePhotoWorkspace();return;}
    const noteFocus=root.contains(document.activeElement)&&document.activeElement?.matches('.ext-notes') ? [document.activeElement.selectionStart,document.activeElement.selectionEnd] : null;
    if(closed()&&delivery!=='exteriors_standard')delivery='exteriors_standard';
    const q=option();
    let body='';
    if(active()){
      body=`<div class="ext-progress">${['Order','Photos','Review'].map((s,i)=>`<button type="button" data-page="${i}" ${i===page?'aria-current="step"':''} ${!canVisit(i)?'disabled':''}>${i+1}. ${s}</button>`).join('')}</div>`;
      if(page===0)body+=`<div class="ext-shared-pins" data-pin-mount></div><button type="button" class="ext-tool ext-map-edit" data-edit-map><i class="fas fa-map-location-dot" aria-hidden="true"></i>${(globalThis.PlatformLanguage?.text("firstmeasure","m_cf9f938683d5b6"," Place pins on map") ?? " Place pins on map")}</button><div data-confirm-mount></div><div ${String(!pinsConfirmed()?'hidden':'')}><div data-notes-mount></div><div data-cc-mount></div><div class="ext-delivery-heading"><h3>${(globalThis.PlatformLanguage?.text("firstmeasure","m_b73185deef6d79","Delivery") ?? "Delivery")}</h3><button type="button" class="ext-info" data-details="full_house" aria-label="${(globalThis.PlatformLanguage?.text("firstmeasure","m_32e960bf81552c","Full Structure report information") ?? "Full Structure report information")}"><i class="fas fa-circle-info" aria-hidden="true"></i>${(globalThis.PlatformLanguage?.text("firstmeasure","m_76a7f763084e05"," What’s included") ?? " What’s included")}</button></div>${String(quote?`<div class="r-expedite-panel visible ${closed()?'is-closed':''}"><div class="r-expedite-wait"><div class="r-expedite-default-head"><div class="r-expedite-status"><strong>${esc(quote.busy_label||'Current delivery estimate')}</strong><span>Estimated wait time right now</span></div><div class="r-expedite-eta">${Math.round(quote.estimated_wait_minutes/60)} hr estimate</div></div><div class="r-expedite-bar" style="--wait-position:${Math.max(0,Math.min(98,(quote.estimated_wait_minutes/60-18)/6*98))}%"><span class="r-expedite-marker" aria-hidden="true"></span></div><div class="r-expedite-bar-labels"><span>18 hrs</span><span>24 hrs</span></div></div><div class="r-expedite-options">${quote.options.map(o=>`<button type="button" class="r-expedite-btn ${o.key==='exteriors_standard'?'r-expedite-default':''} ${o.key===delivery?'selected':''}" data-delivery="${o.key}" aria-pressed="${o.key===delivery}" ${o.key!=='exteriors_standard'&&closed()?'disabled':''}><span class="r-expedite-copy"><span class="r-expedite-name">${esc(o.label)}</span>${o.key!=='exteriors_standard'?'<span class="r-expedite-pill">Expedited</span>':''}</span><span class="r-expedite-price">${o.key!=='exteriors_standard'?'+':''}${money(o.key==='exteriors_standard'?o.unit_price:o.fee)}</span></button>`).join('')}</div><p class="ext-price-unit">${money(quote.base_price)} per structure + selected delivery fee${closed()?' · Expediting unavailable while closed':''}</p></div>`:'<p>Loading prices…</p>')}</div>`;
      if(page===1)body+=photoUI();
      if(page===2){
        const customers=(ctx.getContacts?.()||[]).filter(contact=>contact.name||contact.email||contact.phone);
        const customerText=customers.map(contact=>[contact.name,contact.email,contact.phone].filter(Boolean).join(' · ')).join('; ');
        const internalNotes=ctx.getInternalNotes?.()||'';
        body+=`<h3>${(globalThis.PlatformLanguage?.text("firstmeasure","m_371d41f75fd74a","Review your Full Structure report") ?? "Review your Full Structure report")}</h3><div class="ext-summary"><div><span>Property</span><strong>${esc(ctx.getAddress?.()||'')}</strong></div><div><span>Property type</span><strong>${esc(ctx.getTypeLabel?.()||ctx.type||'')}</strong></div><div><span>Customer</span><strong>${esc(customerText||'—')}</strong></div><div><span>${(globalThis.PlatformLanguage?.text("firstmeasure","m_4169276a19a978","Structures") ?? "Structures")}</span><strong>${String(ctx.count)}</strong></div><div><span>${(globalThis.PlatformLanguage?.text("firstmeasure","m_b73185deef6d79","Delivery") ?? "Delivery")}</span><strong>${String(esc(q?.label||''))}</strong></div><div><span>${(globalThis.PlatformLanguage?.text("firstmeasure","m_55b0bb36ef9924","Base / structure") ?? "Base / structure")}</span><strong>${String(money(quote?.base_price))}</strong></div><div><span>${(globalThis.PlatformLanguage?.text("firstmeasure","m_2dcc431639f55d","Expediting / structure") ?? "Expediting / structure")}</span><strong>${String(money(q?.fee))}</strong></div><div><span>${(globalThis.PlatformLanguage?.text("firstmeasure","m_ecc15b597e6d14","Includes") ?? "Includes")}</span><strong>${(globalThis.PlatformLanguage?.text("firstmeasure","m_65d8712cd3229f","Roof, walls, windows,") ?? "Roof, walls, windows,")}<br>${(globalThis.PlatformLanguage?.text("firstmeasure","m_649ceb7c3b77e9","doors + gutters") ?? "doors + gutters")}</strong></div><div><span>${(globalThis.PlatformLanguage?.text("firstmeasure","m_709555179e8925","Required references") ?? "Required references")}</span><strong>${((v4,v5) => globalThis.PlatformLanguage?.text("firstmeasure","m_69fadf091cc03e",`${v4} / ${v5} uploaded`,{v4,v5}) ?? `${v4} / ${v5} uploaded`)([...files].filter(([k,f])=>!k.startsWith('tray:')&&!k.includes(':additional')&&f.media_id).length,ctx.count*8)}</strong></div><div><span>${(globalThis.PlatformLanguage?.text("firstmeasure","m_e35b550434e284","Extra references") ?? "Extra references")}</span><strong>${String([...files.keys()].filter(k=>k.includes(':additional')).length)}</strong></div><div class="total"><strong>${(globalThis.PlatformLanguage?.text("firstmeasure","m_9403c7637d4905","Total") ?? "Total")}</strong><strong>${String(money(q?.amount))}</strong></div></div><p>${String(closed()?'Reports placed now will be processed first thing tomorrow morning.':'Delivery timing starts when your order is submitted.')}</p>${String((ctx.getNotes?.()||notes)?`<p><strong>Notes for Technician</strong><br>${esc(ctx.getNotes?.()||notes)}</p>`:'')}${String(ctx.getCc?.().length?`<p><strong>CC for Reports</strong><br>${esc(ctx.getCc().join(', '))}</p>`:'')}${String(internalNotes?`<p><strong>Internal Notes</strong><br>${esc(internalNotes)}</p>`:'')}${String(!ready()?'<p class="ext-test-notice">Test preview only. Add all eight views per structure before placing an order.</p>':'')}`;
      }
      body+=`<div class="ext-nav">${page?`<button type="button" data-back>${(globalThis.PlatformLanguage?.text("firstmeasure","m_121372231b5699","Back") ?? "Back")}</button>`:''}<button type="button" class="primary" data-next ${busy||!!error||!quote||!pinsConfirmed()||(page===1&&!photosReviewable())||(page===2&&(!ready()||pending()||unassigned().length))?'disabled':''}>${busy?'Please wait…':page===2?'Order Full Structure · '+money(q?.amount):page===0?'Continue to photos →':'Review order →'}</button></div>`;
    }
    root.innerHTML=`<div class="ext-choices ${scope?'compact':''}">${[['roof','Roof Only','fa-house-chimney'],['full_house','Full Structure','fa-house']].map(([key,title,icon])=>`<div class="ext-choice-wrap"><button type="button" class="ext-choice ${String(scope===key?'selected':'')}" data-scope="${String(key)}" data-addon-info="${String(key)}" aria-pressed="${String(scope===key)}"><strong>${String(scopeIcon(key))} ${String(title)}</strong></button><button type="button" class="ext-choice-info r-info-tip" data-details="${String(key)}" aria-label="${((v7) => globalThis.PlatformLanguage?.text("firstmeasure","m_79e68d505c1bac",`${v7} report information`,{v7}) ?? `${v7} report information`)(title)}"><i class="fas fa-info" aria-hidden="true"></i></button></div>`).join('')}</div><div class="ext-pages">${body}</div>${error?`<p class="ext-error" role="alert">${esc(error)} <button type="button" ${!quote?'data-reload':'data-dismiss-error'}>${!quote?'Retry':'Dismiss'}</button></p>`:''}`;
    if(active()&&page===0){mountShared('rPinInfo','[data-pin-mount]');if(!mobileOrder)mountShared('rMobilePinStage','[data-confirm-mount]');mountShared('rTechNotes','[data-notes-mount]',true);mountShared('rCcList','[data-cc-mount]',true);}
    root.querySelectorAll('[data-details]').forEach(b=>{b.onclick=e=>{e.stopPropagation();ctx.showInfo?.(b.dataset.details);};});
    root.querySelectorAll('[data-addon-info]').forEach(b=>{b.onmouseenter=()=>ctx.hoverInfo?.(b);b.onmouseleave=()=>ctx.hideInfo?.();b.onfocus=()=>ctx.hoverInfo?.(b);b.onblur=()=>ctx.hideInfo?.();});
    if(scope){
      const pill=document.getElementById('rTypePill');
      if(pill){
        let control=document.getElementById('rScopeSelect');
        if(!control){control=document.createElement('label');control.id='rScopeSelect';control.className='r-order-select';pill.append(control);}
        if(control.dataset.scope!==scope||control.dataset.busy!==String(busy)){
          control.innerHTML=(String(scopeIcon(scope)) + "<select aria-label=\"" + (globalThis.PlatformLanguage?.text("firstmeasure","m_09612fd6ab85db","Report scope") ?? "Report scope") + "\" " + String(busy?'disabled':'') + "><option value=\"roof\" " + String(scope==='roof'?'selected':'') + ">" + (globalThis.PlatformLanguage?.text("firstmeasure","m_d2a894582092f8","Roof Only") ?? "Roof Only") + "</option><option value=\"full_house\" " + String(scope==='full_house'?'selected':'') + ">" + (globalThis.PlatformLanguage?.text("firstmeasure","m_0980d65c27cd2f","Full Structure") ?? "Full Structure") + "</option></select><i class=\"fas fa-chevron-down\" aria-hidden=\"true\"></i>");
          control.dataset.scope=scope;control.dataset.busy=String(busy);
          control.querySelector('select').onchange=e=>root.querySelector(`[data-scope="${e.target.value}"]`)?.click();
        }
        root.querySelector('.ext-choices').hidden=true;
      }
    }
    root.querySelectorAll('[data-scope]').forEach(b=>b.onclick=()=>{if(busy)return;ctx.hideInfo?.();scope=b.dataset.scope;page=0;if(scope==='full_house'){ctx.setPinConfirmed?.(false);ctx.locationConfirmed=false;}ctx.refresh();render();});
    root.querySelectorAll('[data-delivery]').forEach(b=>b.onclick=()=>{delivery=b.dataset.delivery;render();});
    root.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>go(Number(b.dataset.page)));
    root.querySelector('[data-back]')?.addEventListener('click',()=>go(page-1));
    root.querySelector('[data-confirm-pins]')?.addEventListener('change',e=>{confirmedPins=e.target.checked?pinSignature:null;render();});
    root.querySelector('[data-next]')?.addEventListener('click',async()=>{if(page<2){go(page+1);}else{busy=true;render();try{await ctx.submit();}finally{busy=false;render();}}});
    root.querySelector('[data-edit-map]')?.addEventListener('click',()=>{mapOpen=true;ctx.showMap?.();render();});
    root.querySelector('[data-reload]')?.addEventListener('click',load);
    root.querySelector('[data-dismiss-error]')?.addEventListener('click',()=>{error='';render();});
    root.querySelector('.ext-notes')?.addEventListener('input',e=>{notes=e.target.value;});
    root.querySelector('[data-bulk]')?.addEventListener('click',()=>pick(null,true));
    root.querySelector('[data-structure]')?.addEventListener('change',e=>{structure=Number(e.target.value);render();});
    root.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{const key=b.dataset.view;if(selectedPhoto)assign(selectedPhoto,key);else if(files.has(key)){selectedPhoto=key;viewReference(key);render();}else pick(key);});
    root.querySelectorAll('[data-select]').forEach(b=>b.onclick=()=>{selectedPhoto=b.dataset.select;render();});
    root.querySelector('[data-cancel-selection]')?.addEventListener('click',()=>{closeReferenceViewer();selectedPhoto=null;render();});
    root.querySelector('[data-additional]')?.addEventListener('click',()=>assign(selectedPhoto,structure+':additional-'+crypto.randomUUID()));
    root.querySelectorAll('[data-retry]').forEach(b=>b.onclick=()=>send(files.get(b.dataset.retry)));
    root.querySelector('[data-retry-selected]')?.addEventListener('click',()=>send(files.get(selectedPhoto)));
    root.querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>{closeReferenceViewer();const f=files.get(b.dataset.remove);if(f?.url)URL.revokeObjectURL(f.url);files.delete(b.dataset.remove);if(selectedPhoto===b.dataset.remove)selectedPhoto=null;render();});
    if(noteFocus){const field=root.querySelector('.ext-notes');field?.focus({preventScroll:true});field?.setSelectionRange(...noteFocus);}
    if(caret&&focused.isConnected&&focused.offsetParent!==null){focused.focus({preventScroll:true});if(focused.type!=='email')focused.setSelectionRange?.(...caret);}
    if(scroller&&savedScroll!=null)scroller.scrollTop=savedScroll;
    let dragDepth=0;
    const isFileDrag=e=>Array.from(e.dataTransfer?.types||[]).includes('Files');
    const clearDrag=()=>{dragDepth=0;root.classList.remove('is-file-drag');const label=root.querySelector('[data-drop-label]');if(label)label.textContent='Drag photos here';};
    clearDrag();
    root.ondragenter=e=>{if(page<1||!isFileDrag(e))return;e.preventDefault();dragDepth++;root.classList.add('is-file-drag');const hint=root.querySelector('[data-drop-label]');if(hint)hint.textContent='Drop to upload photos';};
    root.ondragover=e=>{if(page<1||!isFileDrag(e))return;e.preventDefault();e.dataTransfer.dropEffect='copy';};
    root.ondragleave=e=>{if(--dragDepth<=0||!root.contains(e.relatedTarget))clearDrag();};
    root.ondrop=e=>{if(page<1||!isFileDrag(e))return;e.preventDefault();e.stopPropagation();clearDrag();for(const file of Array.from(e.dataTransfer.files))void upload(file,'tray:'+crypto.randomUUID());};
    root.ondragend=clearDrag;
    root.querySelectorAll('[data-view]').forEach(button=>{
      button.ondragover=e=>{if(Array.from(e.dataTransfer?.types||[]).includes('application/x-exterior-reference')){e.preventDefault();e.dataTransfer.dropEffect='move';button.closest('.ext-view').classList.add('drop-target');}};
      button.ondragleave=()=>button.closest('.ext-view').classList.remove('drop-target');
      button.ondrop=e=>{const from=e.dataTransfer?.getData('application/x-exterior-reference');if(!files.has(from))return;e.preventDefault();e.stopPropagation();assign(from,button.dataset.view);};
    });
    renderPhotoWorkspace();
    if(mobileOrder)ctx.updateMobilePager?.();
  }
  async function upload(file,key){if(!file)return;if(file.size>8*1024*1024||!/^image\/(jpeg|png|webp)$/.test(file.type)){error='Use JPG, PNG or WebP photos up to 8 MB.';render();return;}
    if(files.size>=100){error='You can upload up to 100 photos per order.';render();return;}
    const old=files.get(key);if(old)files.set('tray:'+crypto.randomUUID(),old);
    const entry={name:file.name,url:URL.createObjectURL(file),file,uploaded_at:new Date().toISOString()};files.set(key,entry);if(!selectedPhoto&&key.startsWith('tray:'))selectedPhoto=key;error='';await send(entry);
  }
  async function send(entry){if(!entry?.file||entry.uploading)return;entry.uploading=true;entry.error='';render();
    if(uploadsInFlight>=3)await new Promise(resolve=>uploadWaiters.push(resolve));
    uploadsInFlight++;
    try{if(![...files.values()].includes(entry))return;const fd=new FormData();fd.append('action','exteriors_upload');fd.append('project_type',ctx.type);fd.append('reference',entry.file);const csrfName=(P.cfg.platformSessionCookieName||'fm_platform_session')+'_csrf';const csrf=document.cookie.split('; ').find(s=>s.startsWith(csrfName+'='))?.slice(csrfName.length+1);const response=await fetch(P.cfg.serverEndpoint,{method:'POST',body:fd,credentials:'include',headers:csrf?{'X-Platform-CSRF':decodeURIComponent(csrf)}:{}});const data=await response.json();if(!response.ok||!data.success)throw Error(data.message||data.error||'Upload failed. Try again.');if([...files.values()].includes(entry))entry.media_id=data.media_id;}catch(e){if([...files.values()].includes(entry))entry.error=e.message;}finally{uploadsInFlight--;uploadWaiters.shift()?.();entry.uploading=false;if([...files.values()].includes(entry))render();}}

  P.ExteriorOrder={active,reset,render,renderPhotos:renderPhotoWorkspace,offersChoice:type=>allowed(type),selectedScope:type=>ctx?.type===type?scope:null,
    mobileDetailsReady:()=>active()&&pinsConfirmed()&&!!option()&&!busy&&!error,
    mobilePhotosReady:()=>active()&&photosReviewable(),
    setMobilePage(step){if(!active())return;const next=step==='photos'?1:step==='final'?2:0;if(page!==next){page=next;render();}},
    previewTabChanged(tab){if(tab!=='photos')closeReferenceViewer();},
    failed(data){error=data?.message||data?.error||'Could not submit this order.';page=0;if(data?.error==='pricing_changed'||data?.error==='exteriors_closed')void load();render();},
    restore(fields){if(!ctx||!allowed(ctx.type)||fields.measurement_scope!=='full_house')return;scope='full_house';delivery=fields.report_expedite_option;notes=fields.tech_notes||'';ctx.setNotes?.(notes);page=0;let refs=[];try{refs=JSON.parse(fields.exterior_references||'[]');}catch{}for(const r of refs)files.set(r.structure+':'+r.view+(r.view==='additional'?'-'+r.media_id:''),{media_id:r.media_id,name:label(r.view)+' reference'});ctx.refresh();render();},needsChoice:()=>!!ctx&&!ctx.ordered&&ctx.orderWorkflow&&allowed(ctx.type)&&!scope,ready:()=>active()&&!!option()&&page===2&&pinsConfirmed()&&ready()&&(!closed()||delivery==='exteriors_standard')&&!pending()&&!unassigned().length&&!error,price:()=>option()?.amount??0,
    sync(context){ctx=context;const nextSignature=JSON.stringify([ctx.type,ctx.count,ctx.pins||[]]);if(nextSignature!==pinSignature){pinSignature=nextSignature;confirmedPins=null;if(active()){ctx.setPinConfirmed?.(false);if(ctx.setPinConfirmed)ctx.locationConfirmed=false;}if(page>0)page=0;}const changed=ctx.type!==lastType||ctx.count!==lastCount;
      if(ctx.type!==lastType){selectedPhoto=null;structure=0;scope=null;page=0;for(const f of files.values())if(f.url)URL.revokeObjectURL(f.url);files.clear();}
      if(changed){generation++;quote=null;lastType=ctx.type;lastCount=ctx.count;for(const [key,f] of files)if(!key.startsWith('tray:')&&Number(key.split(':')[0])>=ctx.count){files.delete(key);files.set('tray:'+crypto.randomUUID(),f);}}
      if(allowed(ctx.type)&&ctx.type&&(changed||(!quote&&!this.loading&&!error))){this.loading=true;void load().finally(()=>{this.loading=false;});}render();},
    payload(){if(!active())return {};return {measurement_scope:'full_house',report_mode:'full',report_expedite_option:delivery,report_pricing_revision:quote?.pricing_revision,exteriors_quoted_amount:option()?.amount,include_gutter_measurements:'1',gutter_addon:'1',include_weather_report:'0',weather_addon:'0',tech_notes:ctx.getNotes?.()??notes,exterior_references:JSON.stringify([...files].filter(([key,f])=>!key.startsWith('tray:')&&f.media_id).map(([key,f])=>({structure:Number(key.split(':')[0]),view:key.includes(':additional')?'additional':key.split(':')[1],media_id:f.media_id})))};}
  };
})();

