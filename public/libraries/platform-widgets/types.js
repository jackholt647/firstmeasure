/* Shared browser/server widget type graph. Inheritance describes contracts, never UI containment. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.FirstMateWidgetTypes=api;})(typeof window==='object'?window:globalThis,function(){
  'use strict';
  function validate(schema,value){
    const kind=value===null?'null':Array.isArray(value)?'array':typeof value;
    if(schema.type&&!([schema.type].flat().includes(kind)||schema.type==='integer'&&Number.isInteger(value)))throw Error('Invalid typed widget value');
    if(Object.hasOwn(schema,'const')&&JSON.stringify(value)!==JSON.stringify(schema.const)||schema.enum&&!schema.enum.some(item=>JSON.stringify(item)===JSON.stringify(value)))throw Error('Invalid typed widget variant');
    if(kind==='object'){for(const name of schema.required||[])if(!Object.hasOwn(value,name))throw Error('Missing typed widget value: '+name);for(const [name,item]of Object.entries(value)){const rule=schema.properties?.[name];if(rule)validate(rule,item);else if(schema.additionalProperties===false)throw Error('Unexpected widget value: '+name);}}
    if(kind==='array'){if(schema.maxItems!=null&&value.length>schema.maxItems)throw Error('Too many selected values');if(schema.items)value.forEach(item=>validate(schema.items,item));}
    if(kind==='string'&&(schema.maxLength!=null&&value.length>schema.maxLength||schema.pattern&&!new RegExp(schema.pattern).test(value)))throw Error('Invalid widget value format');
  }
  function create(rows){
    const types=new Map();
    for(const row of rows){if(!row.id||types.has(row.id))throw Error('Duplicate or missing widget type');types.set(row.id,row);}
    function lineage(id){const chain=[],seen=new Set();while(id){if(seen.has(id))throw Error('Widget type inheritance cycle');seen.add(id);const row=types.get(id);if(!row)throw Error('Unknown widget type: '+id);chain.unshift(row);id=row.parent;}return chain;}
    for(const id of types.keys())lineage(id);
    function contract(id){const chain=lineage(id);return {id,ancestors:chain.map(row=>row.id),selection:chain.some(row=>row.selection===true),defaults:Object.assign({},...chain.map(row=>row.defaults||{})),constraints:Object.assign({},...chain.map(row=>row.constraints||{})),configSchemas:chain.flatMap(row=>row.configSchema?[row.configSchema]:[]),selectionSchemas:chain.flatMap(row=>row.selectionSchema?[row.selectionSchema]:[])};}
    function config(id,value={}){const c=contract(id);for(const [key,expected]of Object.entries(c.constraints))if(Object.hasOwn(value,key)&&JSON.stringify(value[key])!==JSON.stringify(expected))throw Error('Widget subtype requires '+key);const result={...c.defaults,...value,...c.constraints};for(const schema of c.configSchemas)validate(schema,result);return result;}
    function candidates(definitions,request){
      const c=contract(request.type),matches=[];
      for(const def of definitions){if(request.surface&&!def.surfaces.includes(request.surface))continue;for(const binding of def.types||[]){const b=contract(binding);if(c.ancestors.includes(binding))matches.push({definition:def,type:request.type,distance:c.ancestors.length-1-c.ancestors.indexOf(binding),config:config(request.type,request.config)});else if(b.ancestors.includes(request.type))matches.push({definition:def,type:binding,distance:100+b.ancestors.length-c.ancestors.length,config:config(binding,request.config)});}}
      return matches.sort((a,b)=>a.distance-b.distance||a.definition.id.localeCompare(b.definition.id));
    }
    function resolve(definitions,request){const matches=candidates(definitions,request);if(!matches.length)return {status:'unavailable'};const best=matches.filter(row=>row.distance===matches[0].distance);if(best.length>1)return {status:'ambiguous',candidates:best.map(row=>({id:row.definition.id,version:row.definition.version,type:row.type}))};const row=best[0];return {status:'ready',widget:{id:row.definition.id,version:row.definition.version,type:row.type,config:row.config},definition:row.definition};}
    function validateDefinitions(definitions){for(const def of definitions)for(const id of def.types||[]){const c=contract(id);if(c.selection&&!def.selection)throw Error('Data-entry widget needs a selection contract: '+def.id);}}
    return {lineage,contract,config,candidates,resolve,validateDefinitions,validateSelection(id,value){for(const schema of contract(id).selectionSchemas)validate(schema,value);},list:()=>rows.map(row=>JSON.parse(JSON.stringify(row)))};
  }
  return {create};
});
