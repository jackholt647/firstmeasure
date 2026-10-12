import {closePlatformFixtureStores,enableExpandedPlatformFixture} from './helpers/platform-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type {PlatformAuthContext} from '../platform/auth.js';

test('suppliers are connections with their own catalogue; locations inherit and store only differences',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'material-suppliers-'));Object.assign(process.env,{NODE_ENV:'test',PLATFORM_STORAGE_ROOT:path.join(root,'platform'),FIRSTMEASURE_STORAGE_ROOT:path.join(root,'reports'),FIRSTMEASURE_INDEX_DB_PATH:path.join(root,'index.sqlite')});
 const storage=await import('../platform/storage.js'),suppliers=await import('../materials/suppliers.js'),connections=await import('../connections/storage.js');
 try{
  await storage.createOrganization({id:'org_suppliers',name:'Suppliers'});await storage.createOrganization({id:'org_other',name:'Other'});await storage.saveGlobal('org_suppliers',{data:{app_flags:{platform:{expanded_access:true,materials:true}}}},{replace:false});await enableExpandedPlatformFixture('org_suppliers',{'platform.materials':true,'platform.pricebook':true});
  const auth={orgId:'org_suppliers',userId:'owner',role:'owner',permissions:{}} as PlatformAuthContext;
  const member={...auth,role:'member',permissions:{manage_company_settings:false}} as PlatformAuthContext;
  assert.deepEqual(await suppliers.listSuppliers('org_suppliers'),[]);

  // Authorization and input contract.
  await assert.rejects(()=>suppliers.saveSupplier('org_suppliers',{name:'ABC Supply'},member),/company settings access/);
  await assert.rejects(()=>suppliers.saveSupplier('org_suppliers',{name:'ABC Supply'},{...auth,orgId:'org_other'}),/company settings access/);
  await assert.rejects(()=>suppliers.saveSupplier('org_suppliers',{name:'ABC Supply',offerings:[{item_id:'shingle',price_cents:-1}]},auth));
  await assert.rejects(()=>suppliers.saveSupplier('org_suppliers',{name:'ABC Supply',offerings:[{item_id:'shingle'},{item_id:'shingle'}]},auth),/listed twice/);
  await assert.rejects(()=>suppliers.saveSupplier('org_suppliers',{name:'ABC Supply',unknown:true},auth));

  const abc=await suppliers.saveSupplier('org_suppliers',{name:'ABC Supply',order_email:'orders@abc.test',delivery_fee:{amount_cents:7500,free_above_cents:500000},offerings:[{item_id:'shingle',sku:'ABC-HDZ',price_cents:3850},{item_id:'underlayment',sku:'ABC-UL'},{item_id:'nails',price_cents:4200}]},auth);
  assert.deepEqual(abc.roles,['material_supplier']);assert.equal(abc.offerings.length,3);assert.equal(abc.offerings[1]?.price_cents,null,'an item can be carried at an unknown price');assert.deepEqual(abc.locations,[]);

  // A supplier is stored as a connection but does not appear among workforce connections.
  const sub=await connections.createOrganizationConnection('org_suppliers',{name:'Roofing Sub'});
  assert.deepEqual((await connections.listOrganizationConnections('org_suppliers')).map(row=>row.name),['Roofing Sub']);
  assert.deepEqual((await connections.listOrganizationConnections('org_suppliers',{relationship_scope:'suppliers'})).map(row=>row.name),['ABC Supply']);
  assert.equal((await connections.listOrganizationConnections('org_suppliers',{relationship_scope:'all'})).length,2);

  // Partial saves keep what they do not mention; stale revisions are refused.
  const renamed=await suppliers.saveSupplier('org_suppliers',{id:abc.id,name:'ABC Supply Co',expected_revision:abc.revision},auth);
  assert.equal(renamed.name,'ABC Supply Co');assert.equal(renamed.order_email,'orders@abc.test');assert.equal(renamed.offerings.length,3);assert.equal(renamed.delivery_fee?.amount_cents,7500);
  await assert.rejects(()=>suppliers.saveSupplier('org_suppliers',{id:abc.id,name:'Stale',expected_revision:abc.revision},auth),/revision/i);
  await assert.rejects(()=>suppliers.saveSupplier('org_suppliers',{id:'missing',name:'Nobody'},auth),/unavailable/);

  // A location with no differences answers exactly as its supplier does.
  const north=await suppliers.saveSupplierLocation('org_suppliers',{supplier_id:abc.id,name:'North yard'},auth);
  assert.deepEqual(suppliers.effectiveSupplierOffer(renamed,north,'shingle'),{carried:true,sku:'ABC-HDZ',price_cents:3850,inherited:true});
  assert.deepEqual(suppliers.effectiveDeliveryFee(renamed,north),{amount_cents:7500,free_above_cents:500000});
  assert.equal(suppliers.effectiveSupplierOffer(renamed,north,'gutter').carried,false);

  // Differences: a price, an item it does not stock, an extra item, and its own fee.
  const south=await suppliers.saveSupplierLocation('org_suppliers',{supplier_id:abc.id,name:'South yard',delivery_fee:{amount_cents:12000},overrides:[{item_id:'shingle',price_cents:3990},{item_id:'nails',carried:false},{item_id:'gutter',carried:true,sku:'S-GUT',price_cents:900}]},auth);
  assert.deepEqual(suppliers.effectiveSupplierOffer(renamed,south,'shingle'),{carried:true,sku:'ABC-HDZ',price_cents:3990,inherited:false});
  assert.equal(suppliers.effectiveSupplierOffer(renamed,south,'nails').carried,false);
  assert.deepEqual(suppliers.effectiveSupplierOffer(renamed,south,'gutter'),{carried:true,sku:'S-GUT',price_cents:900,inherited:false});
  assert.equal(suppliers.effectiveSupplierOffer(renamed,south,'underlayment').price_cents,null);
  assert.deepEqual(suppliers.effectiveDeliveryFee(renamed,south),{amount_cents:12000,free_above_cents:null});

  // A supplier price change reaches every location that has not set its own.
  const repriced=await suppliers.saveSupplier('org_suppliers',{id:abc.id,name:'ABC Supply Co',offerings:[{item_id:'shingle',sku:'ABC-HDZ',price_cents:4000},{item_id:'underlayment',sku:'ABC-UL'},{item_id:'nails',price_cents:4200}]},auth);
  assert.equal(repriced.locations.length,2);
  assert.equal(suppliers.effectiveSupplierOffer(repriced,repriced.locations.find(row=>row.name==='North yard')!,'shingle').price_cents,4000);
  assert.equal(suppliers.effectiveSupplierOffer(repriced,repriced.locations.find(row=>row.name==='South yard')!,'shingle').price_cents,3990);

  // Quoting one delivery: coverage, unknown prices, and the fee.
  const lines=[{item_id:'shingle',quantity:10},{item_id:'nails',quantity:2}];
  assert.deepEqual(suppliers.quoteSupplierDelivery(repriced,null,lines),{covers_all:true,missing_item_ids:[],unpriced_item_ids:[],subtotal_cents:48400,delivery_cents:7500,delivery_waived:false,total_cents:55900});
  assert.equal(suppliers.quoteSupplierDelivery(repriced,null,lines,{delivery:false}).total_cents,48400);
  assert.deepEqual(suppliers.quoteSupplierDelivery(repriced,null,[{item_id:'shingle',quantity:200}]),{covers_all:true,missing_item_ids:[],unpriced_item_ids:[],subtotal_cents:800000,delivery_cents:0,delivery_waived:true,total_cents:800000});
  const unknown=suppliers.quoteSupplierDelivery(repriced,null,[...lines,{item_id:'underlayment',quantity:3}]);assert.equal(unknown.covers_all,true);assert.deepEqual(unknown.unpriced_item_ids,['underlayment']);assert.equal(unknown.total_cents,null,'a total with an unknown price is unknown');assert.equal(unknown.delivery_cents,7500);
  const southQuote=suppliers.quoteSupplierDelivery(repriced,south,lines);assert.equal(southQuote.covers_all,false);assert.deepEqual(southQuote.missing_item_ids,['nails']);
  assert.deepEqual(suppliers.quoteSupplierDelivery(repriced,null,[{item_id:'',quantity:1}]).missing_item_ids,[''],'a line with no price book item cannot be matched');

  // Location edits and removal.
  await assert.rejects(()=>suppliers.saveSupplierLocation('org_suppliers',{supplier_id:abc.id,name:'North yard'},member),/company settings access/);
  await assert.rejects(()=>suppliers.saveSupplierLocation('org_suppliers',{supplier_id:'missing',name:'Nowhere'},auth),/unavailable/);
  const cleared=await suppliers.saveSupplierLocation('org_suppliers',{id:south.id,supplier_id:abc.id,name:'South yard',delivery_fee:null,overrides:[],expected_revision:south.revision},auth);
  assert.equal(cleared.delivery_fee,null);assert.deepEqual(cleared.overrides,[]);
  await suppliers.archiveSupplierLocation('org_suppliers',{id:north.id},auth);
  assert.deepEqual((await suppliers.listSuppliers('org_suppliers'))[0]?.locations.map(row=>row.name),['South yard']);
  await assert.rejects(()=>suppliers.archiveSupplierLocation('org_suppliers',{id:north.id},auth),/unavailable/);

  // A company that is both a subcontractor and a supplier keeps its work relationship when the supplier side is removed.
  await connections.patchOrganizationConnection('org_suppliers',String(sub.id),{relationship_type_ids:['work_provider','equipment_rental'],expected_revision:Number(sub.revision)});
  assert.deepEqual((await suppliers.listSuppliers('org_suppliers')).map(row=>row.name).sort(),['ABC Supply Co','Roofing Sub']);
  assert.deepEqual((await connections.listOrganizationConnections('org_suppliers')).map(row=>row.name),['Roofing Sub']);
  await assert.rejects(()=>suppliers.archiveSupplier('org_suppliers',{id:String(sub.id)},member),/company settings access/);
  await suppliers.archiveSupplier('org_suppliers',{id:String(sub.id)},auth);
  assert.deepEqual((await connections.listOrganizationConnections('org_suppliers')).map(row=>[row.name,row.status]),[['Roofing Sub','active']]);
  await suppliers.archiveSupplier('org_suppliers',{id:abc.id},auth);
  assert.deepEqual(await suppliers.listSuppliers('org_suppliers'),[]);
  await assert.rejects(()=>suppliers.archiveSupplier('org_suppliers',{id:abc.id},auth),/unavailable/);
 }finally{await closePlatformFixtureStores();try{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}catch(error){if(!['EBUSY','EPERM'].includes((error as NodeJS.ErrnoException).code||''))throw error;}}
});
