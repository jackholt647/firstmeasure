(function(){
 'use strict';
 const script=document.currentScript;
 function init(options){
  const base=new URL(options.api,location.href);if(base.protocol!=='https:')throw Error('Use an HTTPS tracking API.');
  const endpoint=base.href.replace(/\/$/,'')+'/phone-tracking/'+encodeURIComponent(options.organization)+'/pools/'+encodeURIComponent(options.pool);
  const fallback=options.fallback,targets=options.selector||'[data-phone-tracking],a[href^="tel:"]';
  let key='',timer=null,stopped=false,inFlight=false,epoch=0,lastNumber='';const originals=new Map();
  const allowed=()=>typeof options.consent==='function'?options.consent():options.consent===true;
  const storageKey='firstmate-phone-visit:'+options.organization+':'+options.pool;
  function reset(){lastNumber='';for(const [el,old]of originals){if(old.href!==null)el.setAttribute('href',old.href);if(old.text!==null)el.textContent=old.text;}originals.clear();}
  function swap(number){lastNumber=number;for(const el of originals.keys())if(!el.isConnected)originals.delete(el);for(const el of document.querySelectorAll(targets)){
   const href=el.getAttribute('href'),isTarget=el.hasAttribute('data-phone-tracking')||href&&href.replace(/[^+\d]/g,'')===fallback.replace(/[^+\d]/g,'');if(!isTarget&&!originals.has(el))continue;
   if(!originals.has(el))originals.set(el,{href,text:el.children.length?null:el.textContent});
   if(href&&/^tel:/i.test(href))if(el.getAttribute('href')!=='tel:'+number)el.setAttribute('href','tel:'+number);
   if(!el.children.length&&el.textContent!==number)el.textContent=number;
  }}
  async function refresh(){
   if(stopped)return;if(timer)clearTimeout(timer);
   if(!allowed()){epoch++;reset();if(timer)clearTimeout(timer);timer=null;if(key)fetch(endpoint+'/release',{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify({visitor_key:key}),keepalive:true}).catch(()=>{});if(key){key='';try{sessionStorage.removeItem(storageKey);}catch{}}return;}
   if(inFlight)return;const thisEpoch=epoch;inFlight=true;
   try{
    if(!key){const campaign=new URLSearchParams(location.search),fingerprint=['utm_source','utm_medium','utm_campaign','utm_content','utm_term'].map(k=>campaign.get(k)||'').join('|');let saved=null;try{saved=JSON.parse(sessionStorage.getItem(storageKey)||'null');}catch{}
     const hasTags=!!fingerprint.replaceAll('|','');key=saved&&(!hasTags||saved.fingerprint===fingerprint)?saved.key:crypto.randomUUID();try{sessionStorage.setItem(storageKey,JSON.stringify({key,fingerprint:!hasTags&&saved?saved.fingerprint:fingerprint}));}catch{}
    }
    const res=await fetch(endpoint+'/assign',{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify({visitor_key:key,consent:true,page_url:location.href,referrer:document.referrer})});
    if(!res.ok)throw Error('Tracking unavailable');const value=await res.json();if(stopped||thisEpoch!==epoch||!allowed()){reset();return;}swap(value.number||fallback);
    document.dispatchEvent(new CustomEvent('firstmate:phone-assignment',{detail:{number:value.number,status:value.status,session_id:value.session_id}}));
   }catch{if(!stopped&&thisEpoch===epoch)reset();}
   finally{inFlight=false;if(!stopped&&allowed())timer=setTimeout(refresh,thisEpoch!==epoch?0:5*60*1000);}
  }
  const observer=new MutationObserver(records=>{if(lastNumber&&allowed()&&records.some(r=>r.type==='attributes'||[...r.addedNodes].some(n=>n.nodeType===1)))swap(lastNumber);});observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['href']});
  const consentChanged=()=>{if(!allowed()&&!key){try{key=JSON.parse(sessionStorage.getItem(storageKey)||'null')?.key||'';}catch{}}refresh();};document.addEventListener('firstmate:tracking-consent',consentChanged);
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',refresh,{once:true});else refresh();
  return {refresh,destroy(){stopped=true;observer.disconnect();epoch++;clearTimeout(timer);reset();document.removeEventListener('firstmate:tracking-consent',consentChanged);}};
 }
 window.FirstMateCallTracking={init};
 if(script?.dataset.phonePool)init({api:script.dataset.api,organization:script.dataset.organization,pool:script.dataset.phonePool,fallback:script.dataset.fallback,selector:script.dataset.selector,consent:()=>window.FirstMateCallTrackingConsent===true});
})();
