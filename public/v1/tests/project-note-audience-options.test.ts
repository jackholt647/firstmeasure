import test from 'node:test';
import assert from 'node:assert/strict';
import {noteAudienceOptions,noteGroupAudiencesEnabled,NOTE_GROUP_AUDIENCE_CAPABILITIES} from '../workforce/note-audiences.js';

// The note visibility picker offers only sections that can mean something. These shapes are data, never a named configuration.
const users=[{id:'me'},{id:'ann'},{id:'bo'}];
const oneDepartment={viewerId:'me',groupsEnabled:false,selection:{organization_wide:true,department_ids:['default']},departments:[{id:'default',label:'Company',status:'active'}],groups:[],groupKinds:[],members:users.map(u=>({id:u.id,department_ids:['default'],resource_group_ids:[]})),users};

test('one department and groups off: Everybody plus searchable people, no department or group section',()=>{
 const options=noteAudienceOptions(oneDepartment);
 assert.deepEqual(options.sections,{departments:false,groups:false,users:true});
 assert.deepEqual(options.users.map(u=>u.id),['me','ann','bo']);
 assert.deepEqual(options.groups,[]);assert.deepEqual(options.group_kinds,[]);
});

test('departments appear only when the person can choose more than one active department',()=>{
 const departments=[{id:'a',label:'Sales',status:'active'},{id:'b',label:'Production',status:'active'},{id:'c',label:'Old',status:'archived'}];
 assert.equal(noteAudienceOptions({...oneDepartment,departments,selection:{organization_wide:false,department_ids:['a']}}).sections.departments,false,'One choosable department is not a choice');
 assert.equal(noteAudienceOptions({...oneDepartment,departments,selection:{organization_wide:false,department_ids:['a','c']}}).sections.departments,false,'An archived department does not count');
 const two=noteAudienceOptions({...oneDepartment,departments,selection:{organization_wide:true,department_ids:['a','b']}});
 assert.equal(two.sections.departments,true);assert.deepEqual(two.selectable_department_ids,['a','b']);assert.deepEqual(two.departments.map(d=>d.id),['a','b']);
});

test('groups appear only when switched on and some exist; group types follow their groups',()=>{
 const groups=[{id:'g1',kind_id:'kind-a',department_ids:['default']}],groupKinds=[{id:'kind-a'},{id:'kind-empty'}];
 assert.equal(noteAudienceOptions({...oneDepartment,groups,groupKinds}).sections.groups,false,'Switched off: nothing offered even when groups exist');
 assert.deepEqual(noteAudienceOptions({...oneDepartment,groups,groupKinds}).groups,[]);
 assert.equal(noteAudienceOptions({...oneDepartment,groupsEnabled:true}).sections.groups,false,'Switched on with no groups: nothing to offer');
 const on=noteAudienceOptions({...oneDepartment,groupsEnabled:true,groups,groupKinds});
 assert.equal(on.sections.groups,true);assert.deepEqual(on.groups.map(g=>g.id),['g1']);assert.deepEqual(on.group_kinds.map(k=>k.id),['kind-a'],'A type with no groups is not offered');
});

test('people and groups stay bounded to the sender department context',()=>{
 const input={...oneDepartment,groupsEnabled:true,selection:{organization_wide:false,department_ids:['a']},departments:[{id:'a',label:'A'},{id:'b',label:'B'}],
  groups:[{id:'mine',kind_id:'k',department_ids:['b']},{id:'theirs',kind_id:'k',department_ids:['b']},{id:'here',kind_id:'k',department_ids:['a']}],groupKinds:[{id:'k'}],
  members:[{id:'me',department_ids:['a'],resource_group_ids:['mine']},{id:'ann',department_ids:['a']},{id:'bo',department_ids:['b']}]};
 const options=noteAudienceOptions(input);
 assert.deepEqual(options.users.map(u=>u.id),['me','ann']);assert.deepEqual(options.groups.map(g=>g.id),['mine','here']);
});

test('the groups switches are the ones People uses',()=>{
 assert.deepEqual([...NOTE_GROUP_AUDIENCE_CAPABILITIES],['platform.people_access','apps.crew']);
 assert.equal(noteGroupAudiencesEnabled({'platform.people_access':true,'apps.crew':true}),true);
 assert.equal(noteGroupAudiencesEnabled({'platform.people_access':false,'apps.crew':true}),false);
 assert.equal(noteGroupAudiencesEnabled({'apps.crew':true}),false);assert.equal(noteGroupAudiencesEnabled(undefined),false);
});
