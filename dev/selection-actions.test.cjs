const test=require('node:test'),assert=require('node:assert/strict');
const {actions,mount}=require('../public/measure/internal/editor_scripts/selection_actions.js');
function fixture(context={mode:'walls',points:2}){
 const listeners={},calls=[],doc={activeElement:null};
 class Element{
  constructor(tag){this.tagName=tag;this.children=[];this.style={};this.attrs={};}
  appendChild(n){n.parent=this;this.children.push(n);return n;}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(c=>c!==this);}
  contains(n){return n===this||this.children.some(c=>c.contains(n));}
  setAttribute(k,v){this.attrs[k]=v;}
  focus(){doc.activeElement?.onblur?.();doc.activeElement=this;this.onfocus?.();}
  blur(){if(doc.activeElement===this)doc.activeElement=null;this.onblur?.();}
  get firstElementChild(){return this.children[0];}
  getBoundingClientRect(){return {width:230,height:this.children.length*30};}
  closest(selector){return selector==='#three-view-wrapper'&&this.view?this:null;}
 }
 doc.createElement=tag=>new Element(tag);doc.body=new Element('body');
 const win={document:doc,innerWidth:800,innerHeight:700,addEventListener:(k,f)=>(listeners[k]||=[]).push(f)};
 const target=new Element('canvas');target.view=true;
 const api=mount({actions:()=>actions(context),run:a=>calls.push(a)},win);
 function emit(type,data={}){const e={target,clientX:100,clientY:100,button:2,pointerId:1,key:'',preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;},...data};for(const fn of listeners[type]||[]){fn(e);if(e.stopped)break;}return e;}
 const open=()=>{emit('pointerdown');emit('pointerup');};
 return {api,emit,open,calls,doc,target,menu:()=>doc.body.children[0]};
}
test('multiple points expose connect and create face; edge shortcuts are unambiguous',()=>{
 const points=actions({mode:'walls',points:3,transform:true});assert.equal(points.find(a=>a.key==='c'&&!a.ctrl).label,'Connect points');assert.ok(points.some(a=>a.key==='v'&&!a.ctrl));assert.equal(points.find(a=>a.key==='r').label,'Rotate');
 const lines=actions({mode:'walls',lines:2,transform:true,trim:true,canExtrude:true});assert.equal(lines.find(a=>a.key==='r').label,'Fillet');assert.equal(lines.find(a=>a.key==='t').label,'Trim');assert.ok(lines.some(a=>a.key==='e'));
 for(const list of [points,lines])assert.equal(new Set(list.map(a=>a.key+!!a.ctrl)).size,list.length);
});
test('plane and base faces expose their different supported commands',()=>{
 const plane=actions({mode:'plane',points:4,lines:2});assert.ok(plane.some(a=>a.key==='l'));assert.ok(!plane.some(a=>a.key==='e'));assert.ok(plane.some(a=>a.key==='x'&&a.ctrl));
 const base=actions({mode:'base',faces:2});assert.equal(base.find(a=>a.key==='m').label,'Move vertically');assert.equal(base.find(a=>a.key==='y').label,'Adjust pitch');assert.ok(!base.some(a=>a.key==='e'||a.key==='l'));
 assert.deepEqual(actions({mode:'walls',points:2,busy:true}),[]);assert.deepEqual(actions({mode:'walls'}),[]);
});
test('opening and dismissing a menu never invokes a selection or command',()=>{
 const f=fixture();f.open();assert.ok(f.api.isOpen());assert.equal(f.menu().attrs.role,'menu');assert.equal(f.menu().children.find(b=>b.textContent==='C Connect points').attrs['aria-keyshortcuts'],'c');
 const e=f.emit('keydown',{key:'Escape'});assert.ok(e.stopped);assert.ok(!f.api.isOpen());assert.deepEqual(f.calls,[]);
});
test('shortcut executes once, closes menu, and consumes the original keyboard event',()=>{
 const f=fixture();f.open();const e=f.emit('keydown',{key:'c'});assert.ok(e.stopped);assert.equal(f.calls.length,1);assert.equal(f.calls[0].label,'Connect points');assert.ok(!f.api.isOpen());
});
test('copy modifier is distinct from connect and unrelated shortcuts do not leak',()=>{
 const f=fixture();f.open();f.emit('keydown',{key:'c',ctrlKey:true});assert.equal(f.calls[0].label,'Copy');f.open();assert.ok(f.emit('keydown',{key:'z',ctrlKey:true}).stopped);assert.equal(f.calls.length,1);assert.ok(f.api.isOpen());
});
test('button activation executes the same action as its shortcut',()=>{
 const f=fixture();f.open();const button=f.menu().children.find(b=>b.textContent==='C Connect points');f.emit('pointerdown',{target:button,button:0});assert.ok(f.api.isOpen());button.onclick();assert.equal(f.calls[0].label,'Connect points');assert.ok(!f.api.isOpen());
});
test('outside click dismisses without passing a selection-changing click through',()=>{
 const f=fixture();f.open();assert.ok(f.emit('pointerdown',{button:0}).stopped);assert.ok(f.emit('mousedown',{button:0}).stopped);assert.ok(f.emit('click',{button:0}).stopped);assert.deepEqual(f.calls,[]);assert.ok(!f.api.isOpen());
});
test('right drag remains navigation and does not open menu',()=>{
 const f=fixture();assert.ok(!f.emit('pointerdown').stopped);assert.ok(!f.emit('pointermove',{clientX:120}).stopped);f.emit('pointermove',{clientX:100});f.emit('pointerup');assert.ok(!f.api.isOpen());
});
test('menu is clamped to viewport and keyboard navigation activates focused row',()=>{
 const f=fixture();f.emit('pointerdown',{clientX:795,clientY:695});f.emit('pointerup',{clientX:795,clientY:695});assert.equal(f.menu().style.left,'562px');assert.ok(parseFloat(f.menu().style.top)>=8);f.emit('keydown',{key:'End'});f.emit('keydown',{key:'Enter'});assert.equal(f.calls[0].label,'Delete');
});
test('pointer movement over the menu cannot change the tool anchor',()=>{const f=fixture();f.open();assert.ok(f.emit('pointermove',{clientX:500}).stopped);f.emit('blur');assert.ok(!f.api.isOpen());});
test('a tall menu can scroll without closing or zooming the scene',()=>{const f=fixture();f.open();assert.ok(f.emit('wheel',{target:f.menu()}).stopped);assert.ok(f.api.isOpen());assert.ok(!f.emit('wheel').stopped);assert.ok(!f.api.isOpen());});
