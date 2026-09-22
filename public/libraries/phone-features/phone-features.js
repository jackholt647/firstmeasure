/* Shared device adapter. Ordinary browsers retain their existing controls. */
(function(root){
  'use strict';
  const pending=new Map();let sequence=0,info=null;
  const transport=()=>root.FirstMeasureNative?.postMessage ? root.FirstMeasureNative : root.webkit?.messageHandlers?.firstmeasure;
  function receive(value){
    let reply;try{reply=typeof value==='string'?JSON.parse(value):value;}catch{return;}
    const call=pending.get(reply?.id);if(!call)return;
    pending.delete(reply.id);clearTimeout(call.timer);
    reply.error?call.reject(Object.assign(new Error(reply.error.message||'Phone action failed.'),{code:reply.error.code||'native_error'})):call.resolve(reply.result);
  }
  function request(method,payload={}){
    const bridge=transport();if(!bridge)return Promise.reject(Object.assign(new Error('This feature requires the mobile app.'),{code:'unsupported'}));
    const id=String(++sequence);
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);reject(Object.assign(new Error('The phone action timed out.'),{code:'timeout'}));},30000);
      pending.set(id,{resolve,reject,timer});
      try{bridge.postMessage(JSON.stringify({version:1,id,method,payload}));}catch(error){clearTimeout(timer);pending.delete(id);reject(error);}
    });
  }
  function pickFiles({source='library',multiple=false,accept='image/*'}={}){
    return new Promise(resolve=>{
      const input=document.createElement('input');input.type='file';input.accept=accept;input.multiple=multiple;
      if(source==='camera')input.setAttribute('capture','environment');
      input.style.display='none';document.body.appendChild(input);
      const finish=()=>{const files=Array.from(input.files||[]);input.remove();resolve(files);};
      input.addEventListener('change',finish,{once:true});input.addEventListener('cancel',finish,{once:true});input.click();
    });
  }
  async function share({title='',text='',url=''}={}){
    if(url){const parsed=new URL(url,location.href);if(!['https:','http:'].includes(parsed.protocol))throw new Error('Unsupported link.');url=parsed.href;}
    if(transport())return request('share',{title,text,url});
    if(navigator.share)return navigator.share({title,text,...(url?{url}:{})});
    throw Object.assign(new Error('Sharing is not available in this browser.'),{code:'unsupported'});
  }
  async function saveFile(blob,name='download'){
    if(!(blob instanceof Blob)||blob.size>16*1024*1024)throw new Error('Choose a file smaller than 16 MB to share.');
    if(!transport())throw Object.assign(new Error('Use your browser download control.'),{code:'unsupported'});
    const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('Unable to read file.'));reader.readAsDataURL(blob);});
    return request('saveFile',{name,mime:blob.type||'application/octet-stream',data});
  }
  async function download(url){
    const parsed=new URL(url,location.href);
    if(parsed.origin!==location.origin)throw new Error('Downloads must start from this application.');
    if(transport())return request('download',{url:parsed.href});
    const link=document.createElement('a');link.href=parsed.href;link.download='';link.click();
  }
  if(root.FirstMeasureNative)root.FirstMeasureNative.onmessage=event=>receive(event.data);
  root.addEventListener('fm:native:reply',event=>receive(event.detail));
  root.addEventListener('pagehide',()=>{for(const call of pending.values()){clearTimeout(call.timer);call.reject(new Error('Page closed.'));}pending.clear();});
  const ready=transport()?request('info').then(value=>{
    if(value?.bridgeVersion!==1)throw new Error('Please update the mobile app.');
    info=Object.freeze(value);document.documentElement.dataset.nativeApp=value.platform;
    root.dispatchEvent(new CustomEvent('fm:phone:ready',{detail:info}));return info;
  }).catch(error=>{root.dispatchEvent(new CustomEvent('fm:phone:error',{detail:{message:error.message}}));return null;}):Promise.resolve(null);
  // Native hosts cannot resolve JavaScript blob URLs. Keep the existing export controls
  // and deliver their generated file to the OS share sheet instead.
  if(transport())document.addEventListener('click',event=>{
    const link=event.target?.closest?.('a[download]');if(!link||!link.href.startsWith('blob:'))return;
    event.preventDefault();fetch(link.href).then(r=>r.blob()).then(blob=>saveFile(blob,link.download||'download')).catch(error=>root.dispatchEvent(new CustomEvent('fm:phone:error',{detail:{message:error.message}})));
  },true);
  root.PhoneFeatures=Object.freeze({version:1,ready,isNative:()=>!!transport(),info:()=>info,pickFiles,capturePhoto:()=>pickFiles({source:'camera'}),share,download,saveFile,
    haptic:()=>transport()?request('haptic'):Promise.resolve(),openSettings:()=>request('settings'),authenticate:()=>request('authenticate')});
})(window);
