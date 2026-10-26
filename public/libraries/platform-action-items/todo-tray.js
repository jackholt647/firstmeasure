/* Global to-dos share the existing list and the portal's dockable window shell. */
(function(){
  'use strict';
  const Portal=window.Portal=window.Portal||{};
  if(Portal.TodoTray)return;
  let shell,win,controller,visible=false,identity='',lastButton,todoBody,sheet=null,inSheet=false;
  const org=()=>String(Portal.cfg?.userOrgId||Portal.cfg?.orgId||window.__APP?.userOrgId||window.__APP?.orgId||'').trim();
  const branch=()=>Portal.branchModules?.currentBranchId?.()||Portal.cfg?.userBranchId||Portal.cfg?.branchId||'default';
  // Whether the organization has the top bar on, not whether its desktop row is laid out: on phones the
  // same entry lives in the More sheet, so both follow topbar.todos alike.
  const enabled=()=>!!org()&&Portal.can?.('topbar.todos')===true&&(Portal.topbar?.isEnabled||Portal.topbar?.isVisible)?.()!==false;
  const style=document.createElement('style');style.textContent=`
    .fm-todo-tray{display:flex;flex-direction:column;min-height:0;background:var(--panel,#fff);color:var(--text,#202124);border:1px solid var(--border,#dadce0);border-radius:var(--radius-lg,12px);box-shadow:var(--shadow,0 10px 30px #00000014);overflow:hidden}
    .fm-todo-tray[hidden]{display:none!important}
    .fm-todo-tray [data-window-action=minimize]{display:none!important}
    .fm-todo-body{flex:1;min-height:0;padding:12px;box-sizing:border-box;overflow:hidden;display:flex;flex-direction:column}.fm-todo-body>.pai-today-list{flex:1;min-height:0}
  `;document.head.append(style);
  function buttons(){return document.querySelectorAll('#platformTodoBtn,#mobilePlatformMoreTodos');}
  // On a phone the same list opens as a bottom sheet from the portal's top bar (Portal.topbar.phoneSheet), like the
  // project window's trays; its body moves into the sheet and back into the window when the sheet has slid away.
  const phone=()=>typeof Portal.topbar?.phoneSheet==='function'&&Portal.topbar.isPhone?.()===true;
  let home=null;
  function returnBody(){if(!todoBody||!home)return;if(home.parent.isConnected)home.parent.insertBefore(todoBody,home.next?.parentNode===home.parent?home.next:null);else todoBody.remove();home=null;}
  function todoSheet(){
    sheet||=Portal.topbar.phoneSheet({id:'mobilePlatformTodoSheet',label:'To Do',onClosing:()=>{if(!inSheet)return;inSheet=false;visible=false;buttons().forEach(button=>button.setAttribute('aria-expanded','false'));},onClosed:()=>{if(!inSheet)returnBody();}});
    return sheet;
  }
  function setVisible(value){
    if(!value&&inSheet){sheet?.close();return;}
    visible=value;win?.setVisible(value);buttons().forEach(button=>button.setAttribute('aria-expanded',String(value)));
  }
  function close(){setVisible(false);lastButton?.focus({preventScroll:true});}
  function openSheet(){
    const target=todoSheet();if(!target?.body)return false;
    if(!home)home={parent:todoBody.parentNode,next:todoBody.nextSibling};
    target.body.append(todoBody);inSheet=true;visible=true;
    buttons().forEach(button=>button.setAttribute('aria-expanded','true'));
    target.open();return true;
  }
  function mount(){
    const key=org()+':'+branch();
    if(shell&&identity===key)return true;
    if(!window.FirstMateWindows?.attach||!window.FirstMateWindowShell?.trayWindow||!window.PlatformActionItems?.renderTodayList)return false;
    controller?.destroy?.();win?.destroy?.();shell?.remove();identity=key;
    const host=document.querySelector('main.main')||document.querySelector('.main')||document.body;
    shell=document.createElement('aside');shell.id='platformTodoTray';shell.className='fm-todo-tray';shell.setAttribute('aria-label','To Do');shell.hidden=true;
    const header=document.createElement('header'),title=document.createElement('div'),body=document.createElement('div');
    title.className='fm-todo-title fm-window-minimized-identity';title.innerHTML='<i class="fas fa-list-check" aria-hidden="true"></i><span>To Do</span>';title.tabIndex=0;body.className='fm-todo-body';header.append(title);shell.append(header,body);host.append(shell);
    if(inSheet)sheet?.close();todoBody?.remove();home=null;todoBody=body;
    const tray=window.FirstMateWindowShell.trayWindow({element:shell,header,title,body,label:'To Do tabs',tabs:[{id:'today',label:'Today',element:body}]});
    win=window.FirstMateWindows.attach({element:shell,header,title,body:tray.body,host,contentTarget:host.querySelector(':scope > #mainPanels'),name:'todos',label:'To Do',mode:'docked',resetOnHide:true,width:380,height:600,minWidth:300,minHeight:300,dockWidth:380,mobileFullDock:true,topInset:()=>document.getElementById('platformTopbar')?.offsetHeight||0,onClose:close});
    controller=window.PlatformActionItems.renderTodayList(body,{orgId:org(),branchId:branch(),userId:String(Portal.cfg?.userId||window.__APP?.userId||Portal.currentUser?.id||''),completedOpen:true,showProjectContext:true,showUpcoming:true,showFuture:true,scrollItemsOnly:true,query:{includeFuture:true}});
    return true;
  }
  function toggle(event){
    if(!enabled())return;
    lastButton=event?.currentTarget||document.getElementById('platformTodoBtn');
    document.getElementById('mobilePlatformMoreMenu')?.classList.remove('visible');
    if(visible){close();return;}
    if(!mount())return;
    if(phone()&&openSheet()){controller?.load?.({quiet:true})?.catch(()=>null);return;}
    returnBody();
    if(win.state?.mode==='minimized')win.restore();
    setVisible(true);controller?.load?.({quiet:true})?.catch(()=>null);
  }
  function install(){
    const phone=document.getElementById('platformPhoneSlot'),assistant=document.getElementById('platformAssistantSlot');
    if(!document.getElementById('platformTodoSlot')&&(phone||assistant)){
      const slot=document.createElement('div');slot.id='platformTodoSlot';slot.hidden=true;
      slot.innerHTML='<button type="button" class="ptb-bell" id="platformTodoBtn" data-fm-tooltip="To Do" aria-label="To Do" aria-controls="platformTodoTray" aria-expanded="false"><i class="fas fa-list-check" aria-hidden="true"></i></button>';
      (phone||assistant).before(slot);slot.firstElementChild.addEventListener('click',toggle);
    }
    const more=document.getElementById('mobilePlatformMoreMenu');
    if(more&&!document.getElementById('mobilePlatformMoreTodos')){
      const button=document.createElement('button');button.type='button';button.id='mobilePlatformMoreTodos';button.className='ptb-more-item';button.innerHTML='<i class="fas fa-list-check" aria-hidden="true"></i><span>To Do</span>';button.setAttribute('aria-controls','platformTodoTray');button.setAttribute('aria-expanded','false');button.addEventListener('click',toggle);more.prepend(button);
    }
    const allowed=enabled();const slot=document.getElementById('platformTodoSlot'),mobile=document.getElementById('mobilePlatformMoreTodos');
    if(slot)slot.hidden=!allowed;if(mobile)mobile.hidden=!allowed;
    if(!allowed&&visible)setVisible(false);
    if(identity&&identity!==org()+':'+branch()){setVisible(false);controller?.destroy?.();win?.destroy?.();shell?.remove();shell=win=controller=null;identity='';}
  }
  const reload=()=>{if(visible&&document.visibilityState!=='hidden')controller?.load?.({quiet:true})?.catch(()=>null);};
  window.addEventListener('fm:work:updated',reload);window.addEventListener('focus',reload);
  document.addEventListener('visibilitychange',reload);setInterval(reload,30000);
  Portal.TodoTray={toggle,close,refresh:install};
  for(const name of ['fm:capabilities:updated','fm:platform-topbar-visibility','fm:branch-module:updated'])window.addEventListener(name,install);
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&visible)close();});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);else install();
})();
