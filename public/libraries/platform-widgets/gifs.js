/* Platform Widgets: shared GIF display, attribution and removable draft previews.
 * No Channels, Notes, Feed, session or message-delivery dependency. */
(function(root){
 'use strict';
 if(root.FirstMateGifWidgets)return;
 const base=new URL('./',document.currentScript?.src || new URL('/libraries/platform-widgets/',location.href));
 const markUrl=new URL('../../images/giphy/powered-by-giphy.png?v=20261012',base).href;
 const element=(tag,className)=>{const node=document.createElement(tag);if(className)node.className=className;return node;};
 const dimension=(value,fallback)=>Number.isFinite(Number(value))&&Number(value)>0 ? Math.min(8192,Math.round(Number(value))) : fallback;
 const valid=gif=>gif && /^https:\/\/media\d*\.giphy\.com\/media\//i.test(gif.url || '');
 function styles(){
  if(document.getElementById('fm-gif-widget-styles'))return;
  const style=element('style');style.id='fm-gif-widget-styles';style.textContent=`.fm-widget-gif{position:relative;margin:4px 0 0;width:max-content;max-width:min(320px,100%)}.fm-widget-gif>a{display:block}.fm-widget-gif img{display:block;max-width:100%;height:auto;border-radius:10px}.fm-widget-gif figcaption{position:absolute;right:3px;bottom:3px;max-width:calc(100% - 6px);box-sizing:border-box;padding:1px 1.5px;border-radius:1.5px;background:rgba(0,0,0,.65);color:#fff;font-size:9px;font-weight:500;line-height:12px;text-align:right;margin:0;pointer-events:none}.fm-widget-gif figcaption img{display:block;width:35px;max-width:100%;height:auto;border-radius:0}
.fm-widget-gif-draft{position:relative;display:block;width:max-content;max-width:100%;padding:4px 0}.fm-widget-gif-draft>.fm-widget-gif{margin:0}.fm-widget-gif-draft>.fm-widget-gif>a>img{max-width:180px;max-height:120px;width:auto;border-radius:8px}.fm-widget-gif-draft>.fm-widget-gif-remove{position:absolute;top:8px;right:4px;display:grid;place-items:center;width:22px;height:22px;border:0!important;border-radius:50%;background:#344054!important;color:#fff!important;font:12px/1 system-ui;cursor:pointer;padding:0!important;z-index:1}.fm-widget-gif-remove svg{width:12px;height:12px}.fm-widget-gif-remove:hover{background:var(--hover,#f2f4f7)}.fm-widget-gif-remove:focus-visible{outline:2px solid var(--primary,#175cd3);outline-offset:2px}`;
  document.head.append(style);
 }
 function createCard(gif){
  if(!valid(gif))return null;styles();
  // The fm-ch alias keeps existing host layout hooks working during migration.
  const card=element('figure','fm-widget-gif fm-ch-gif'),link=element('a');link.href=`https://giphy.com/gifs/${encodeURIComponent(String(gif.id || ''))}`;link.target='_blank';link.rel='noopener noreferrer';
  const image=element('img');image.src=gif.url;image.alt=gif.title || 'GIF';image.loading='lazy';image.width=dimension(gif.width,240);image.height=dimension(gif.height,180);
  const caption=element('figcaption'),mark=element('img');mark.src=markUrl;mark.alt='Powered by GIPHY';mark.width=100;mark.height=36;caption.append(mark);link.append(image);card.append(link,caption);return card;
 }
 function createDraft(gif,onRemove){
  const card=createCard(gif);if(!card)return null;
  const preview=element('div','fm-widget-gif-draft fm-ch-gif-draft'),remove=element('button','fm-widget-gif-remove');remove.type='button';remove.setAttribute('aria-label','Remove GIF');remove.dataset.gifRemove='';remove.innerHTML='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';if(onRemove)remove.onclick=onRemove;preview.append(card,remove);return preview;
 }
 function renderCard(gif){return createCard(gif)?.outerHTML || '';}
 function renderDraftHtml(gif){return createDraft(gif)?.outerHTML || '';}
 function renderDraft(host,gif,onRemove){host.replaceChildren();const draft=createDraft(gif,onRemove);if(draft)host.append(draft);return draft;}
 function mount(host,{gif,draft=false,onRemove}={}){
  let active=true;
  const update=value=>{if(!active)return;host.replaceChildren();const node=draft ? createDraft(value,onRemove) : createCard(value);if(node)host.append(node);};update(gif);
  return {update,destroy(){active=false;host.replaceChildren();}};
 }
 root.FirstMateGifWidgets={createCard,renderCard,createDraft,renderDraft,renderDraftHtml,mount};
})(window);
