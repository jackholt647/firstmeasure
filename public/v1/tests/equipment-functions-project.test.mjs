import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('../../libraries/apps/materials/project.js',import.meta.url),'utf8');
function fn(name) {
  const start=source.search(new RegExp(`  (?:async )?function ${name}\\(`));
  assert.ok(start>=0,name); return source.slice(start,source.indexOf('\n  }',start)+4);
}

test('picking equipment for a project line stamps what it provides, so requirements count the line', () => {
  const context = vm.createContext({
    state:{
      pricebookItems:[],
      equipmentUnits:[
        {id:'u1',name:'Dumpster 2',type_id:'dumpster',rates:{daily_cents:4500},effective_provides:[{item:'disposal.debris',capacity:8,per_load:false}]},
        {id:'u2',name:'Trailer 1',type_id:'trailer',effective_provides:[{item:'disposal.debris',capacity:10,per_load:true}]},
        {id:'u3',name:'Skid steer',type_id:'skid'}
      ],
      equipmentTypes:[
        {id:'dumpster',name:'Dumpster',default_rates:{daily_cents:4000},provides:[{item:'disposal.debris',capacity:6,per_load:false}]},
        {id:'skid',name:'Skid steer',provides:[]}
      ]
    },
    loads:0
  });
  vm.runInContext(`
    const cleanText = (value) => String(value ?? '').trim();
    const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
    const money = (value) => '$' + Number(value).toFixed(2);
    const resourceType = (list) => list.resource_type;
    const categorySources = () => ['equipment'];
    const categorySkuOnly = () => false;
    const laborSettings = () => ({});
    function loadEquipmentUnits(){ loads += 1; }
    ${fn('equipmentProvides')}
    ${fn('autofillMatches')}
    globalThis.runJson = (query) => JSON.stringify(autofillMatches(query, {resource_type:'equipment'}));
    globalThis.providesJson = (value) => JSON.stringify(equipmentProvides(value));
  `, context);

  const run = (query) => JSON.parse(context.runJson(query)), provides = (value) => JSON.parse(context.providesJson(value));
  // A unit: itself, its type, and what it holds in effect (its own capacity, not the type's six).
  const dumpster = run('dumpster');
  assert.deepEqual(dumpster.map((entry) => [entry.label, entry.detail]), [['Dumpster 2','Equipment · $45.00 per day'],['Dumpster','Equipment type · $40.00 per day']]);
  assert.deepEqual(dumpster[0].patch.metadata, {equipment_unit_id:'u1',equipment_type_id:'dumpster',provides:[{item:'disposal.debris',capacity:8,per_load:false}]});
  // A type, when no one unit is meant: what the type holds, and no unit.
  assert.deepEqual(dumpster[1].patch.metadata, {equipment_unit_id:'',equipment_type_id:'dumpster',provides:[{item:'disposal.debris',capacity:6,per_load:false}]});
  assert.deepEqual(run('trailer')[0].patch.metadata.provides, [{item:'disposal.debris',capacity:10,per_load:true}]);
  // Equipment that provides nothing says so, which also clears what an earlier pick stamped. A type named like a unit is listed once.
  const skid = run('skid');
  assert.deepEqual(skid.map((entry) => [entry.label, entry.patch.metadata.provides]), [['Skid steer',[]]]);
  assert.ok(context.loads > 0);
  // Only what the requirements read is copied: no capacity stays no capacity.
  assert.deepEqual(provides([{item:'disposal.debris',capacity:null,per_load:1,extra:true},{item:''},null]), [{item:'disposal.debris',per_load:false}]);
  assert.deepEqual(provides(undefined), []);
});
