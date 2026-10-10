/* Platform Widgets: shared emoji and GIF pickers. No dependency on Channels UI. */
(function(root){
  'use strict';
  if(root.FirstMatePickerWidgets)return;
  const base=new URL('./',document.currentScript?.src||new URL('/libraries/platform-widgets/',location.href));
  const EMOJI_SET = [
    { group: 'Reactions', items: ['👍','👎','❤️','🔥','🎉','😂','😊','😮','😢','😡','🙏','👏','💯','✅','❌','👀','🤝','🫡','🤔','😅','🥳','😍','🚀','⭐'] },
    { group: 'Faces', items: ['😀','😄','😁','😆','🙂','😉','😌','😎','🤩','🥲','😴','🤯','🤢','🥶','😱','😳','🙄','😬','🤐','😇','🤠','🤡','👻','💀'] },
    { group: 'Hands', items: ['👋','✌️','🤞','🤟','👌','🤌','✋','🖐️','💪','🦾','🖖','👈','👉','👆','👇','☝️','✍️','🤙','🙌','🫶'] },
    { group: 'Work', items: ['🏠','🏗️','🧰','🔨','🪜','📐','📏','🧱','🪵','🏡','🚧','⚒️','🛠️','📸','📋','📝','📞','📧','💰','🧾','📦','🚚','🗓️','⏰'] },
    { group: 'Weather', items: ['☀️','⛅','☁️','🌧️','⛈️','🌨️','❄️','🌪️','🌈','💨','🌊','🌡️'] }
  ];
  const el=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!=null)node.textContent=text;return node;};
  const scripts=new Map();
  function loadScript(path){
    if(!scripts.has(path))scripts.set(path,new Promise((resolve,reject)=>{const script=el('script');script.src=new URL(path,base);script.onload=resolve;script.onerror=()=>{scripts.delete(path);script.remove();reject(Error('The picker is unavailable.'));};document.head.append(script);}));
    return scripts.get(path);
  }
  function styles(){
    if(document.getElementById('fm-picker-widget-styles'))return;
    const style=el('style');style.id='fm-picker-widget-styles';style.textContent=`
.fm-picker{--picker-border:var(--border,#e4e7ec);--picker-muted:var(--muted,#667085);--picker-accent:var(--primary-readable,var(--primary,#d93025));font:13px/1.45 system-ui;color:var(--text,#101828);box-sizing:border-box}
.fm-picker *{box-sizing:border-box}.fm-picker button{font:inherit;cursor:pointer;border:0;background:none;color:inherit;padding:0}.fm-picker button:focus-visible{outline:2px solid var(--picker-accent);outline-offset:-2px}
.fm-picker-popover{position:fixed;z-index:1601;width:304px;max-width:calc(100vw - 16px);max-height:calc(100dvh - 16px);border:1px solid var(--picker-border);border-radius:10px;background:var(--card,#fff);box-shadow:0 8px 28px rgba(15,23,42,.16);overflow:auto}
.fm-picker-search{display:block;flex:none;width:calc(100% - 16px);margin:8px;padding:7px 9px;border:1px solid var(--picker-border);border-radius:8px;background:var(--card,#fff);color:inherit;font:inherit;font-size:12px}.fm-picker-search:focus-visible{outline:2px solid var(--picker-accent);outline-offset:-1px}
.fm-picker-emoji{max-height:340px;overflow:auto}.fm-picker-emoji-group{padding:6px 12px 2px;font-size:11px;font-weight:700;color:var(--picker-muted)}.fm-picker-emoji-grid{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:2px;padding:4px 8px 8px}.fm-picker-emoji-grid button{font-size:22px;line-height:1;border-radius:6px;min-width:0;height:32px}.fm-picker-emoji-grid button:hover{background:var(--hover,#f2f4f7)}
.fm-picker-popover.fm-picker-gif{height:340px;display:flex;flex-direction:column;overflow:hidden;padding:0 8px}.fm-picker-gif .fm-picker-search{width:100%;margin:8px 0}.fm-picker-gif-grid{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain}.fm-picker-gif-grid [role=button]:focus-visible{outline:3px solid var(--picker-accent)}
.fm-picker-status{flex:none;font-size:12px;color:var(--picker-muted);margin:0 0 8px}.fm-picker-status:empty{display:none}.fm-picker-attribution{flex:none;padding:6px 0;font-size:10px;line-height:1.2;color:var(--picker-muted);text-align:right}
.fm-picker-trigger{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:6px;background:none;color:inherit;cursor:pointer}.fm-picker-trigger span{font:800 10px system-ui;border:1.5px solid currentColor;border-radius:3px;padding:1px}.fm-picker-trigger:hover{background:var(--hover,#f2f4f7)}
`;document.head.append(style);
  }
  let active=null;
  function closeFor(anchor){if(active&&(!anchor||active.anchor===anchor))active.close();}
  function popover(anchor,label,build){
    styles();if(active?.anchor===anchor){active.close();return null;}closeFor();
    const pop=el('div','fm-picker fm-picker-popover');pop.setAttribute('role','dialog');pop.setAttribute('aria-label',label);
    anchor.setAttribute('aria-haspopup','dialog');anchor.setAttribute('aria-expanded','true');
    document.body.append(pop);
    let cleanup,disposed=false;
    const close=(restore=false)=>{
      if(disposed)return;disposed=true;if(active?.pop===pop)active=null;
      cleanup?.();observer.disconnect();sizeObserver.disconnect();document.removeEventListener('pointerdown',outside,true);document.removeEventListener('focusin',focusOutside);document.removeEventListener('keydown',keydown,true);document.removeEventListener('scroll',position,true);root.removeEventListener('resize',position);
      pop.remove();anchor.setAttribute('aria-expanded','false');if(restore&&anchor.isConnected)anchor.focus();
    };
    const position=()=>{
      const rect=anchor.getBoundingClientRect(),bounds=pop.getBoundingClientRect();
      let top=rect.bottom+6;if(top+bounds.height>innerHeight-8)top=Math.max(8,rect.top-bounds.height-6);
      pop.style.top=Math.max(8,Math.min(top,innerHeight-bounds.height-8))+'px';pop.style.left=Math.max(8,Math.min(rect.left,innerWidth-bounds.width-8))+'px';
    };
    const outside=event=>{if(!pop.contains(event.target)&&!anchor.contains(event.target))close();};
    const focusOutside=event=>{if(!pop.contains(event.target)&&!anchor.contains(event.target))close();};
    const keydown=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true);}};
    const observer=new MutationObserver(()=>{if(!anchor.isConnected)close();});
    const sizeObserver=new ResizeObserver(position);
    active={anchor,pop,close};
    document.addEventListener('pointerdown',outside,true);document.addEventListener('focusin',focusOutside);document.addEventListener('keydown',keydown,true);document.addEventListener('scroll',position,true);root.addEventListener('resize',position);
    observer.observe(document.body,{childList:true,subtree:true});sizeObserver.observe(pop);
    try{cleanup=build(pop,close);position();}catch(error){close();throw error;}
    return pop;
  }
  function mountEmojiPicker(container,onPick){
    styles();const body=el('div','fm-picker fm-picker-emoji'),search=el('input','fm-picker-search'),holder=el('div');search.type='search';search.placeholder='Search emoji groups';search.setAttribute('aria-label','Search emoji');body.append(search,holder);container.replaceChildren(body);
    function paint(){
      holder.replaceChildren();const filter=search.value.trim().toLowerCase();
      for(const group of EMOJI_SET){
        const items=group.items.filter(emoji=>!filter||group.group.toLowerCase().includes(filter)||emoji.includes(filter));if(!items.length)continue;
        holder.append(el('div','fm-picker-emoji-group',group.group));const grid=el('div','fm-picker-emoji-grid');
        for(const emoji of items){const button=el('button','',emoji);button.type='button';button.setAttribute('aria-label',emoji);button.onclick=()=>onPick(emoji);grid.append(button);}holder.append(grid);
      }
    }
    search.oninput=paint;paint();return {focus:()=>search.focus(),destroy(){body.remove();}};
  }
  function openEmojiPicker(anchor,onPick){
    return popover(anchor,'Choose an emoji',(pop,close)=>{const picker=mountEmojiPicker(pop,emoji=>{close(true);onPick(emoji);});picker.focus();return ()=>picker.destroy();});
  }
  function openGifPicker(anchor,{orgId,onSend,onError=()=>{},getConfig,dialogTitle='Choose a GIF'}={}){
    return popover(anchor,dialogTitle,(pop,close)=>{
      pop.classList.add('fm-picker-gif');
      const search=el('input','fm-picker-search');search.type='search';search.placeholder='Search GIPHY';search.setAttribute('aria-label',search.placeholder);
      const status=el('p','fm-picker-status','Loading GIFs…');status.setAttribute('role','status');
      const grid=el('div','fm-picker-gif-grid'),attribution=el('a','fm-picker-attribution','Powered by GIPHY');attribution.href='https://giphy.com';attribution.target='_blank';attribution.rel='noopener noreferrer';pop.append(search,status,grid,attribution);search.focus();
      let disposed=false,sending=false,timer,removeGrid,resizeObserver,generation=0;
      const operationId='gif_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2);
      (async()=>{
        if(!getConfig&&!root.ChannelsAPI)await loadScript('../channels-api/channels-api.js');
        if(disposed)return;
        const config=await (getConfig?getConfig(orgId):root.ChannelsAPI.gifs.config(orgId));if(disposed)return;
        if(!config.enabled)throw Error('GIF search is not configured for this environment yet.');
        const {GiphyFetch,renderGrid}=await import('../gif-picker/giphy-sdk.js?v=20260929');if(disposed)return;
        const client=new GiphyFetch(config.sdk_key);
        function paint(){
          const query=search.value.trim(),version=++generation;removeGrid?.();grid.replaceChildren();status.textContent='Loading GIFs…';
          removeGrid=renderGrid({width:Math.max(1,Math.floor(grid.clientWidth)),columns:2,gutter:4,noLink:true,
            fetchGifs:async offset=>{
              try{const data=await (query?client.search(query,{offset,limit:12,rating:'pg'}):client.trending({offset,limit:12,rating:'pg'}));if(!disposed&&version===generation&&!sending)status.textContent=data.data.length?'':'No GIFs found. Try another search.';return data;}
              catch(error){if(!disposed&&version===generation&&!sending)status.textContent='GIF search is unavailable or its request limit was reached. Try again later.';return {data:[],pagination:{total_count:0,count:0,offset},meta:{status:200,msg:'Unavailable',response_id:''}};}
            },
            onGifClick:async(gif,event)=>{
              event?.preventDefault();if(disposed||sending||version!==generation)return;
              const image=gif.images.fixed_width||gif.images.original;if(!/^https:\/\/media\d*\.giphy\.com\/media\//i.test(image?.url||''))return;
              const selected={id:String(gif.id),url:image.url,title:gif.title||'GIF',width:Number(image.width),height:Number(image.height)};
              clearTimeout(timer);sending=true;grid.inert=true;search.disabled=true;status.textContent='Sending GIF…';
              try{await onSend(selected,operationId);if(!disposed)close(true);}
              catch(error){if(!disposed){sending=false;grid.inert=false;search.disabled=false;status.textContent='Could not send this GIF. Try again.';}onError(error);}
            }
          },grid);
        }
        search.oninput=()=>{clearTimeout(timer);timer=setTimeout(paint,300);};paint();
        let width=grid.clientWidth;resizeObserver=new ResizeObserver(()=>{if(!disposed&&!sending&&grid.clientWidth!==width){width=grid.clientWidth;paint();}});resizeObserver.observe(grid);
      })().catch(error=>{if(!disposed)status.textContent=error.message||'GIF search is unavailable.';});
      return ()=>{disposed=true;clearTimeout(timer);resizeObserver?.disconnect();removeGrid?.();};
    });
  }
  function createGifPickerButton(options){
    styles();const button=el('button','fm-picker-trigger');button.append(el('span','','GIF'));button.type='button';button.title='Send a GIF';button.setAttribute('aria-label',button.title);button.setAttribute('aria-haspopup','dialog');button.setAttribute('aria-expanded','false');button.onclick=()=>openGifPicker(button,options);button.destroy=()=>closeFor(button);return button;
  }
  root.FirstMatePickerWidgets={mountEmojiPicker,openEmojiPicker,openGifPicker,createGifPickerButton,closeFor};
})(window);
