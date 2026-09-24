(function(root){
  'use strict';
  const text=(key,fallback)=>root.PlatformLanguage?.text('mobile',key,fallback)||fallback;
  async function mount(host,{orgId}={}){
    if(!host)return;
    const marker={};host.__mobileMount=marker;
    host.replaceChildren();const status=document.createElement('p');status.setAttribute('role','status');status.textContent=text('loading','Loading app downloads…');host.appendChild(status);
    try{
      const response=await fetch('/v1/mobile/organizations/'+encodeURIComponent(orgId)+'/config',{credentials:'same-origin',cache:'no-store'});
      const data=await response.json();if(!response.ok)throw new Error(data.message||'Unable to load app downloads.');
      if(host.__mobileMount!==marker)return;
      host.replaceChildren();const heading=document.createElement('h3');heading.textContent=text('title','Get the FirstMate app');host.appendChild(heading);
      const description=document.createElement('p');description.textContent=text('description','Use your existing account, projects, language and company settings on your phone.');host.appendChild(description);
      const ios=/iPhone|iPad|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
      const android=/Android/.test(navigator.userAgent);
      function row(label,url){const item=document.createElement(url?'a':'p');item.textContent=label+(url?'':text('unpublished',' — not published yet'));if(url){item.href=url;item.rel='noopener';item.style.cssText='display:block;padding:14px 18px;margin:12px 0;border:1px solid #ddd;border-radius:12px;font-weight:600;';}host.appendChild(item);}
      const stores=[['android','Google Play'],['ios','App Store']];if(ios)stores.reverse();
      for(const [platform,label] of stores)row(label+((ios&&platform==='ios'||android&&platform==='android')?text('recommended',' · Your device'):''),data.stores[platform]);
      if(data.developer){const title=document.createElement('h4');title.textContent=text('testing','Developer testing');host.appendChild(title);row(text('android_test','Download Android test build'),data.developer.android);row(text('ios_test','Install iPhone test build with TestFlight'),data.developer.ios);
        const note=document.createElement('p');note.textContent=text('testing_note','Test builds use the development environment. iPhone installation requires TestFlight or an Apple-signed build for your registered device.');host.appendChild(note);}
      if(root.PhoneFeatures?.isNative()){const native=document.createElement('p');const info=await root.PhoneFeatures.ready;if(info)native.textContent=`${info.platform} · ${info.version} · ${info.environment}`;host.appendChild(native);}
    }catch(error){if(host.__mobileMount!==marker)return;status.textContent=error.message;const retry=document.createElement('button');retry.type='button';retry.textContent=text('retry','Try again');retry.onclick=()=>mount(host,{orgId});host.appendChild(retry);}
  }
  root.FirstMeasureAppDownload={mount};
})(window);
