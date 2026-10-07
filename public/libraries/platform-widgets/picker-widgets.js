/* Picker widgets: shared pickers mounted through the widget runtime. Each reports a bounded selection
 * (ids and plain values only) to its host and, as untrusted screen metadata, to agents. */
(function(global){
  'use strict';
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const clean=value=>String(value??'').trim(),base=new URL('./',document.currentScript.src);let selectorScript;
  function styles(){
    if(document.getElementById('fm-picker-widget-css'))return;
    const style=document.createElement('style');style.id='fm-picker-widget-css';style.textContent=`
      .fpw,.fpw *{box-sizing:border-box}.fpw{font:inherit;color:var(--text,#1d2939);background:var(--panel,#fff);border:1px solid var(--border,#e4e7ec);border-radius:12px;min-width:0;display:flex;flex-direction:column}
      .fpw-head{padding:12px 14px 0}.fpw-head strong{display:block;font-size:14px;font-weight:600;overflow-wrap:anywhere}.fpw-body{padding:12px 14px;min-width:0}.fpw-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
      .fpw label{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--muted,#667085);min-width:0}.fpw input[type=date],.fpw input[type=time],.fpw input[type=datetime-local]{font:inherit;font-size:13px;padding:8px 10px;border:1px solid var(--border,#d0d5dd);border-radius:8px;background:var(--panel,#fff);color:inherit;min-width:0}
      .fpw-inline{margin-top:10px;max-width:420px}.fpw-inline:empty{display:none}.fpw-color{display:flex;align-items:center;gap:12px}.fpw-color input[type=color]{width:56px;height:40px;padding:2px;border:1px solid var(--border,#d0d5dd);border-radius:8px;background:var(--panel,#fff);cursor:pointer}.fpw-color output{font-size:13px;font-variant-numeric:tabular-nums}
      .fpw-foot{display:flex;align-items:center;gap:10px;padding:10px 14px;border-top:1px solid var(--border,#e4e7ec)}.fpw-summary{flex:1;min-width:0;font-size:12px;color:var(--muted,#667085);overflow-wrap:anywhere}
      .fpw-confirm{font:inherit;font-size:12px;font-weight:600;padding:8px 14px;border:1px solid var(--primary,#d93025);border-radius:8px;background:var(--primary,#d93025);color:var(--on-primary,#fff);cursor:pointer}.fpw-confirm:disabled{opacity:.5;cursor:default}.fpw button:focus-visible,.fpw input:focus-visible{outline:2px solid #528bff;outline-offset:2px}
      .fpw[data-project] .fpw-body{min-height:330px}
    `;document.head.append(style);
  }
  /* Common chrome: the question, the control, a plain-language summary and one confirm button.
   * read() returns {value,label} or null. Every change is reported; confirm marks it as the answer.
   * Hosts that apply changes live can hide the button with context.confirm === false. */
  function frame(root,{prompt,fallback,confirm,context,notifySelection}){
    styles();root.innerHTML=`<section class="fpw" role="group"><header class="fpw-head"><strong></strong></header><div class="fpw-body"></div><footer class="fpw-foot"><span class="fpw-summary" role="status"></span><button type="button" class="fpw-confirm" disabled></button></footer></section>`;
    const shell=root.firstElementChild,body=root.querySelector('.fpw-body'),summary=root.querySelector('.fpw-summary'),button=root.querySelector('.fpw-confirm');
    root.querySelector('.fpw-head strong').textContent=clean(prompt)||fallback;shell.setAttribute('aria-label',clean(prompt)||fallback);
    if(context.confirm===false)button.hidden=true;
    let read=()=>null,sent='';
    function sync(report=true){const picked=read(),key=picked?JSON.stringify(picked.value):'';summary.textContent=picked?picked.label:'Nothing selected yet';button.disabled=!picked||key===sent;button.textContent=picked&&key===sent?'Selected':confirm;if(report)notifySelection(picked?picked.value:null,{label:picked?.label});}
    button.addEventListener('click',()=>{const picked=read();if(!picked)return;sent=JSON.stringify(picked.value);notifySelection(picked.value,{confirmed:true,label:picked.label});sync(false);});
    return {shell,body,sync,use(reader){read=reader;sync(false);},selection(){return read()?.value??null;}};
  }
  function register(){
    const W=global.FirstMateWidgets;if(!W?.attachRenderer)return false;

    /* Media: the Photos picker itself, mounted inline. Data is the authorized media.library export, or
     * host-supplied photos in context.data['media.picker'] = {items:[...]} (items may be project photo objects). */
    W.attachRenderer('media.picker','1',async(root,{data,config,context,reference,state,notifySelection})=>{
      const feed=global.Portal?.PhotoFeed;if(!feed?.mountProjectMediaPicker)throw Error('The media picker is unavailable on this page.');
      const target=reference.target||context.target||{},multiple=config.multiple!==false,video=config.kind==='image_video',max=multiple?Math.min(config.max||50,50):1;
      const source={provider:'media',export:'library'},read=context.read||((source,target)=>global.PlatformAPI.publication.read(target.organizationId,{...source,target}));
      const args={...(video?{kind:'image_video'}:{}),...(config.project_id&&target.scope==='organization'?{project_id:config.project_id}:{})};
      async function load(){const result=await read({...source,args},target);if(result.status!=='ready')throw Error(result.message||'Media is unavailable.');return result.value;}
      // The runtime's first read carries no arguments; repeat it only when this instance needs videos or a project filter.
      if(!context.data?.[reference.id]&&Object.keys(args).length)data=await load();
      const photos=value=>(Array.isArray(value?.items)?value.items:[]).map(item=>item&&typeof item==='object'&&(item.media_id||item.src||item.url)?item:{id:item.id,media_id:item.id,content_type:item.content_type,label:item.label||item.file_name,file_name:item.file_name,uploaded_at:item.created_at,project_id:item.project_id});
      const selection=ids=>ids.length?{media_ids:ids.slice(0,50)}:null,label=ids=>ids.length+(video?' item':' photo')+(ids.length===1?'':'s');
      const options={photos:photos(data),multiple,imageOnly:!video,projectId:target.projectId||config.project_id||'',selectedIds:Array.isArray(state?.media_ids)?state.media_ids:[],title:clean(config.prompt)||(video?'Select media':'Select photos'),subtitle:data?.truncated?'Showing the newest items.':' ',onUpload:context.onUpload,
        onConfirm(_chosen,ids){return notifySelection(selection(ids),{confirmed:true,label:label(ids)});}};
      const picker=feed.mountProjectMediaPicker(root,options,{inline:true,maxSelected:max,onSelectionChange:ids=>notifySelection(selection(ids),{label:label(ids)})});
      let alive=true;
      return {selection:()=>selection(picker.selectedIds()),serialize:()=>({media_ids:picker.selectedIds()}),async refresh(){const next=context.data?.[reference.id]||await load();if(alive)picker.refresh(photos(next));},destroy(){alive=false;picker.destroy();root.replaceChildren();}};
    });

    /* Date and time: the shared date/time picker on ordinary inputs. The calendar is mounted inline when no
     * other picker is open (the shared picker shows one at a time); otherwise the field opens its popup. */
    W.attachRenderer('datetime.picker','1',(root,{config,context,state,notifySelection})=>{
      const mode=config.mode||'date',range=mode==='date_range',type=mode==='datetime'?'datetime-local':range?'date':mode;
      const ui=frame(root,{prompt:config.prompt,fallback:range?'Choose dates':mode==='time'?'Choose a time':mode==='datetime'?'Choose a date and time':'Choose a date',confirm:range?'Use these dates':mode==='time'?'Use this time':'Use this date',context,notifySelection});
      const field=(name,text,value)=>`<label>${esc(text)}<input type="${type}" data-field="${name}" value="${esc(value||'')}"${config.min?` min="${esc(config.min)}"`:''}${config.max?` max="${esc(config.max)}"`:''}></label>`;
      ui.body.innerHTML=`<div class="fpw-row">${range?field('start','Start',state?.start||config.value)+field('end','End',state?.end||config.end_value):field('value',mode==='time'?'Time':mode==='datetime'?'Date and time':'Date',state?.value||config.value)}</div><div class="fpw-inline"></div>`;
      const input=name=>ui.body.querySelector(`[data-field="${name}"]`),inline=ui.body.querySelector('.fpw-inline'),zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
      const show=(value,options)=>{const date=new Date(type==='time'?'1970-01-01T'+value:type==='date'?value+'T00:00':value);return Number.isFinite(date.getTime())?date.toLocaleString(undefined,options):value;};
      ui.use(()=>{
        if(range){const start=input('start'),end=input('end');end.min=start.value||config.min||'';if(!start.value||!end.value||!start.validity.valid||!end.validity.valid||end.value<start.value)return null;return {value:{mode,start:start.value,end:end.value,timezone:zone},label:show(start.value,{dateStyle:'medium'})+' – '+show(end.value,{dateStyle:'medium'})};}
        const el=input('value');if(!el.value||!el.validity.valid)return null;
        return {value:{mode,value:el.value,timezone:zone},label:show(el.value,mode==='time'?{timeStyle:'short'}:mode==='datetime'?{dateStyle:'medium',timeStyle:'short'}:{dateStyle:'full'})};
      });
      const changed=()=>ui.sync();ui.body.addEventListener('input',changed);ui.body.addEventListener('change',changed);
      if(!range&&global.FirstMateDateTimePicker?.mount&&!document.querySelector('fm-date-time-picker'))global.FirstMateDateTimePicker.mount(inline,input('value'));
      return {selection:ui.selection,serialize:()=>range?{start:input('start').value,end:input('end').value}:{value:input('value').value},destroy(){if(inline.querySelector('fm-date-time-picker'))global.FirstMateDateTimePicker?.close(false);root.replaceChildren();}};
    });

    /* Color: a standard color input, which the shared FirstMate color picker enhances wherever it is loaded. */
    W.attachRenderer('color.picker','1',(root,{config,context,state,notifySelection})=>{
      const ui=frame(root,{prompt:config.prompt,fallback:'Choose a color',confirm:'Use this color',context,notifySelection});
      const hex=value=>/^#[0-9a-f]{6}$/i.test(clean(value))?clean(value).toLowerCase():'';
      const initial=hex(state?.color)||hex(config.value);let touched=!!initial;
      ui.body.innerHTML=`<div class="fpw-color"><input type="color" aria-label="${esc(clean(config.prompt)||'Color')}" value="${initial||'#3b82f6'}"><output></output></div>`;
      const input=ui.body.querySelector('input'),output=ui.body.querySelector('output');
      ui.use(()=>{const color=hex(input.value);output.textContent=touched?color:'';return touched&&color?{value:{color},label:color}:null;});
      const changed=()=>{touched=true;ui.sync();};input.addEventListener('input',changed);input.addEventListener('change',changed);
      return {selection:ui.selection,serialize:()=>touched?{color:hex(input.value)}:{},destroy(){if(input.getAttribute('aria-expanded')==='true')global.FirstMateColorPicker?.close?.(false);root.replaceChildren();}};
    });

    /* Project: the shared project selector, searching through the authorized project directory export. */
    W.attachRenderer('project.picker','1',async(root,{config,context,reference,state,notifySelection})=>{
      if(!global.FirstMateProjectSelector?.mount)await (selectorScript||=new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=new URL('../project-selector/project-selector.js?v=20261007-picker-widgets',base);s.onload=resolve;s.onerror=()=>{selectorScript=null;reject(Error('The project picker could not load'));};document.head.append(s);}));
      const target=reference.target||context.target||{},source={provider:'project-widgets',export:'directory'};
      const read=context.read||((source,target)=>global.PlatformAPI.publication.read(target.organizationId,{...source,target}));
      const ui=frame(root,{prompt:config.prompt,fallback:'Choose a project',confirm:'Use this project',context,notifySelection});ui.shell.dataset.project='true';
      const host=document.createElement('div');ui.body.append(host);let picked=null;
      const selector=global.FirstMateProjectSelector.mount(host,{orgId:target.organizationId,projectId:clean(state?.project_id||config.project_id),
        async search(query){const result=await read({...source,args:{query:String(query||'').slice(0,200),limit:12}},{scope:'organization',organizationId:target.organizationId});if(result.status!=='ready')throw Error(result.message||'Could not find projects.');return result.value;},
        onChange(id){picked=id?{value:{project_id:id},label:clean(host.querySelector('input')?.value)||id}:null;ui.sync();}});
      ui.use(()=>picked);await selector.ready;
      if(selector.value&&!picked){picked={value:{project_id:selector.value},label:clean(host.querySelector('input')?.value)||selector.value};ui.sync(false);}
      return {selection:ui.selection,serialize:()=>picked?{project_id:picked.value.project_id}:{},destroy(){selector.destroy();root.replaceChildren();}};
    });
    return true;
  }
  if(!register())global.addEventListener('load',register,{once:true});
})(window);
