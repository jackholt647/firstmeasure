/* Transactional ownership of persistent exterior render parts. */
(function(root){'use strict';
class ExteriorSceneCache{
 constructor(){this.entries=new Map();this.pending=null;}
 begin(context){if(this.pending)throw Error('Exterior render transaction already active');this.context=JSON.stringify(context);this.pending=new Map();this.moves=[];this.stats={reused:0,built:0};}
 part(key,input,parent,build){
  if(!this.pending)throw Error('Exterior render transaction required');
  if(this.pending.has(key))throw Error('Duplicate exterior render part: '+key);
  const signature=this.context+'|'+JSON.stringify(input),old=this.entries.get(key);let entry;
  if(old?.signature===signature){entry=old;this.moves.push({object:entry.group,parent:entry.group.parent});this.stats.reused++;}
  else{const group=new root.THREE.Group();parent.add(group);entry={signature,group,value:build(group)};this.stats.built++;}
  parent.add(entry.group);this.pending.set(key,entry);return entry.value;
 }
 commit(){if(!this.pending)return;this.entries=this.pending;this.pending=null;this.moves=[];return {...this.stats};}
 rollback(){if(!this.pending)return;for(const {object,parent}of this.moves.reverse()){object.parent?.remove(object);parent?.add(object);}this.pending=null;this.moves=[];}
 clear(){this.rollback();this.entries.clear();}
}
if(typeof module!=='undefined'&&module.exports)module.exports=ExteriorSceneCache;else root.ExteriorSceneCache=ExteriorSceneCache;
})(typeof window!=='undefined'?window:globalThis);
