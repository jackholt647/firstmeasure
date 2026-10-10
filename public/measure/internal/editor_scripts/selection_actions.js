/* Selection commands share the editor's keyboard route; this menu never picks geometry. */
(function(root){
 'use strict';
 function actions(c){
  if(!c||c.busy)return [];
  const out=[],p=c.points||0,l=c.lines||0,f=c.faces||0,any=p+l+f>0;
  if(!any)return out;
  const add=(key,label,ctrl=false)=>out.push({key,label,ctrl});
  if(c.mode==='roof'){
   if(p)add('m','Move vertically');
   add('r','Rotate');if(p)add('y','Resize vertically');add('t','Flip');
   if(p){add('n','New connected point');if(p<=2)add('q','Draw rectangle');add('h','Flatten');}
   if(p>=2){add('c','Connect points');add('w','Merge points');}
   if(p>=3){add('v','Create face');add('b','Subtract face');}
   if(l>=2)add('l','Make lines parallel');
  }else if(c.mode==='plane'){
   if(p){add('m','Move');add('r','Rotate');add('y','Resize');add('t','Flip');add('n','New connected point');}
   if(p>=2)add('c','Connect points');
   if(p>=3){add('v','Create face');add('b','Subtract region');}
   if(p===1)add('s','Draw curve');
   if(p>0&&p<=2)add('q','Draw rectangle');
   if(l===1)add('a','Arch line');
   if(l>=2)add('l','Make lines parallel');
   add('p','Leave drawing plane');
  }else{
   add('m',c.mode==='base'&&!c.transform?'Move vertically':'Move');
   if(c.canExtrude)add('e','Extrude');
   if(l||p===1)add('r','Fillet');else if(c.transform)add('r','Rotate');else if(c.mode==='walls'&&f===1)add('r','Face view');
   if(c.transform){add('y','Resize');if(!c.trim)add('t','Flip');}
   else if(c.mode==='base'&&f)add('y','Adjust pitch');
   if(c.trim)add('t','Trim');
   if(p){add('n','New connected point');add('h','Horizontal cut');if(p<3)add('v','Vertical cut');}
   if(p>=2)add('c','Connect points');else if(l)add('c','Chamfer');
   if(p>=3)add('v','Create face');
   if(p===1)add('s','Draw curve');
   if(c.mode==='walls'&&p>0&&p<=2)add('q','Draw rectangle');
   if(l===1)add('a','Arch line');
   if(c.mode==='base'&&f){add('h',f>1?'Align base heights':'Flatten base');if(f===1)add('l','Level base');}
   if(c.feature){add('l','Divide window / door');}
   if(f&&c.mode==='walls'){add('w','Window');add('d','Door');add('g','Garage');}
   add('p','Drawing plane');
  }
  if(c.mode!=='base'||p||l)add('c','Copy',true);if(c.canPaste)add('v','Paste',true);
  if(c.mode==='plane')add('x','Cut',true);
  if(c.mode!=='base'||p||l)add('Delete','Delete');
  return out;
 }
 function mount(host,win=root){
  const doc=win.document;let menu=null,items=[],target=null,press=null,ignoreClick=false;
  const inView=e=>e.target?.closest?.('#three-view-wrapper')&&!e.target.closest('button,input,select,textarea,[contenteditable=true],.enh-control-panel,.controls-3d-actions,#axis-gizmo-container,#exterior-graphics,#resource-3d-controls');
  const stop=e=>{e.preventDefault();e.stopImmediatePropagation();};
  function close(){menu?.remove();menu=null;items=[];}
  function execute(a){const canvas=target;close();doc.activeElement?.blur?.();host.run(a,canvas);}
  function show(e){
   close();items=host.actions();if(!items.length)return;
   target=e.target;doc.activeElement?.blur?.();menu=doc.createElement('div');menu.id='selection-actions-menu';menu.setAttribute('role','menu');menu.setAttribute('aria-label','Selection actions');
   menu.style.cssText='position:fixed;z-index:100000;min-width:215px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow-x:hidden;overflow-y:auto;box-sizing:border-box;padding:5px;background:#242a30;color:#f1f3f4;border:1px solid #697680;border-radius:7px;box-shadow:0 6px 24px #0008;font:13px system-ui;';
   for(const a of items){const b=doc.createElement('button');b.type='button';b.setAttribute('role','menuitem');
    const shortcut=(a.ctrl?'Ctrl+':'')+(a.key.length===1?a.key.toUpperCase():a.key);
    b.textContent=shortcut+' '+a.label;b.setAttribute('aria-keyshortcuts',(a.ctrl?'Control+':'')+a.key);
    b.style.cssText='display:block;box-sizing:border-box;margin:0;width:100%;text-align:left;padding:7px 10px;border:0;border-radius:3px;background:transparent;color:inherit;font:inherit;cursor:pointer;white-space:nowrap;';
    b.onfocus=()=>b.style.background='#405466';b.onblur=()=>b.style.background='transparent';b.onpointerenter=()=>b.focus({preventScroll:true});b.onclick=()=>execute(a);menu.appendChild(b);
   }
   doc.body.appendChild(menu);const r=menu.getBoundingClientRect();menu.style.left=Math.max(8,Math.min(e.clientX,win.innerWidth-r.width-8))+'px';menu.style.top=Math.max(8,Math.min(e.clientY,win.innerHeight-r.height-8))+'px';menu.firstElementChild.focus({preventScroll:true});
  }
  win.addEventListener('contextmenu',e=>{if(menu?.contains(e.target)||inView(e)&&(menu||host.actions().length))stop(e);},true);
  win.addEventListener('pointerdown',e=>{
   if(menu){if(menu.contains(e.target)){e.stopImmediatePropagation();return;}close();if(e.button===0){ignoreClick=true;stop(e);return;}}
   if(e.button===2&&inView(e))press={x:e.clientX,y:e.clientY,id:e.pointerId,moved:false,target:e.target};
  },true);
  win.addEventListener('pointermove',e=>{if(press&&Math.hypot(e.clientX-press.x,e.clientY-press.y)>5)press.moved=true;if(menu)e.stopImmediatePropagation();},true);
  win.addEventListener('pointerup',e=>{if(e.button!==2||!press)return;const p=press;press=null;if(!p.moved&&inView(e))show(e);},true);
  for(const type of ['mousedown','mouseup','click','dblclick'])win.addEventListener(type,e=>{
   if(ignoreClick){stop(e);if(type==='click')ignoreClick=false;return;}
   if(menu?.contains(e.target)&&type!=='click')e.stopImmediatePropagation();
  },true);
  win.addEventListener('keydown',e=>{
   if(!menu)return;
   const buttons=[...menu.children],at=buttons.indexOf(doc.activeElement);
   if(['Escape','Tab'].includes(e.key)){close();stop(e);return;}
   if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){const i=e.key==='Home'?0:e.key==='End'?buttons.length-1:(at+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;buttons[i].focus({preventScroll:true});stop(e);return;}
   if(e.key==='Enter'||e.key===' '){const a=items[Math.max(0,at)];stop(e);if(!e.repeat)execute(a);return;}
   const a=items.find(a=>a.key.toLowerCase()===e.key.toLowerCase()&&!!a.ctrl===!!(e.ctrlKey||e.metaKey)&&!e.altKey&&!e.shiftKey);
   stop(e);if(a&&!e.repeat)execute(a);
  },true);
  for(const type of ['blur','resize','pointercancel'])win.addEventListener(type,()=>{press=null;close();});
  win.addEventListener('wheel',e=>{if(menu?.contains(e.target))e.stopImmediatePropagation();else close();},true);
  return {close,isOpen:()=>!!menu};
 }
 root.SelectionActions={actions,mount};
 // Install before editor capture listeners so menu keys never reach two tools.
 if(root.document)root.selectionActionMenu=mount({actions:()=>root.WallMode?.selectionActions?.()||[],run:(a,target)=>{
  const surface=target?.closest?.('#three-view-wrapper')?.querySelector('canvas')||target;
  // Moving onto the floating menu can leave the canvas, but the command
  // still belongs to the 3D view (not the 2D resize/move shortcut).
  const previous=typeof activeController3D==='undefined'?undefined:activeController3D;
  try{if(previous!==undefined)activeController3D=true;surface?.dispatchEvent(new KeyboardEvent('keydown',{key:a.key,ctrlKey:!!a.ctrl,bubbles:true,cancelable:true}));}
  finally{if(previous!==undefined)activeController3D=previous;}
 }});
 if(typeof module!=='undefined')module.exports={actions,mount};
})(typeof window!=='undefined'?window:globalThis);
