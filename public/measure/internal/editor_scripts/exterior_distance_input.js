/* Keyboard distance entry shared by constrained editing tools. Defaults to feet; angle tools supply degree units. */
(function(root){'use strict';
let current=null,currentAxis=null,buffer='',badge=null;
function render(owner){
 if(owner?.token!==current||owner?.axis!==currentAxis){current=owner?.token||null;currentAxis=owner?.axis;buffer='';}
 const anchor=document.getElementById('btnTogglePitch');
 if(anchor&&!badge){badge=document.createElement('span');badge.id='exterior-distance';badge.setAttribute('aria-live','polite');Object.assign(badge.style,{color:'#fff',fontSize:'13px',padding:'5px 9px',whiteSpace:'nowrap',fontVariantNumeric:'tabular-nums',pointerEvents:'none'});anchor.after(badge);}
 if(anchor&&badge&&badge.parentElement!==anchor.parentElement)anchor.after(badge);
 if(badge){const angle=owner?.unit==='degrees',scale=owner?.unitsPerInput??.3048;badge.hidden=!owner;badge.textContent=owner?((owner.label?owner.label+' ': '')+(buffer||((owner.amount||0)/scale).toFixed(2))+(angle?'\u00b0':' ft')+(buffer?'':angle?' · type angle':' · type '+(owner.label?.toLowerCase()||'distance'))):'';}
}
function key(e,owner){
 render(owner);if(!owner||e.ctrlKey||e.metaKey||e.altKey)return false;
 const k=e.key;let next=buffer;
 if(/^\d$/.test(k))next+=k;
 else if(k==='.'||k==='Decimal'){if(!next.includes('.'))next+='.';}
 else if(k==='-'||k==='+')next=(k==='-'?'-':'')+next.replace(/^[+-]/,'');
 else if(k==='Backspace')next=next.slice(0,-1);
 else if(k==='Escape'&&buffer)next='';
 else return false;
 e.preventDefault();e.stopImmediatePropagation();buffer=next;
 const n=Number(buffer);owner.set(buffer.trim()!==''&&Number.isFinite(n)&&(n!==0||owner.allowZero)?n*(owner.unitsPerInput??.3048):null);render(owner);return true;
}
root.ExteriorDistanceInput={key,render};
})(window);
