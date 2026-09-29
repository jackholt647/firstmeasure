import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../libraries/platform-notifications/platform-notifications.js', import.meta.url), 'utf8');
test('silent deliveries remain visible without alerts; hidden bell items can still alert', async () => {
  let response = { notifications: [] }, sounds = 0, celebrations = 0;
  const window = {
    PlatformAPI: { notifications: { list: async () => response, setUserState: async () => ({}) } },
    PlatformCelebrations: { indicator: () => sounds++, fromNotification: () => celebrations++ }
  };
  runInNewContext(source, { window, setTimeout });
  const load = () => window.PlatformNotifications.load('org');
  await load();
  response = { notifications: [{ id: 'silent', presentation: { sound: false, badge: false, bell: true } }] };
  let state = await load();
  assert.equal(state.notifications.length, 1);
  assert.equal(state.unread_count, 0);
  assert.equal(sounds, 0);
  response.in_app_alerts = [{ id: 'message', presentation: { sound: true, bell: false } }];
  state = await load();
  assert.equal(state.notifications.length, 1);
  assert.equal(sounds, 1);
  await load();
  assert.equal(sounds, 1, 'polling does not repeat alerts');
  response.notifications.push({ id: 'celebration', kind: 'celebration', presentation: { sound: false, bell: true } });
  state = await load();
  assert.equal(state.notifications.length, 2);
  assert.equal(celebrations, 0);
  assert.equal(sounds, 1);
});


test('recipient surface claims deduplicate tabs and grouped actions apply to all members',async()=>{
 const claims=new Set(),changed=[];let sounds=0,celebrations=0;
 const response={notifications:['a','b'].map(id=>({id,title:'Signed',delivery_version:2,presentation:{bell:true,sound:true,celebration:true},deliveries:{groups:[{group:'same-channel'}],methods:{audio:{id:id+'-audio',state:'available'},celebration:{id:id+'-celebration',state:'available'}}}}))};
 const window={PlatformAPI:{notifications:{list:async()=>response,acknowledge:async(_org,id)=>{if(claims.has(id))return {claimed:false};claims.add(id);return {claimed:true};},setUserState:async(_org,id)=>{changed.push(id);return {};}}},PlatformCelebrations:{indicator:()=>sounds++,fromNotification:()=>celebrations++}};
 runInNewContext(source,{window,setTimeout});
 const result=await window.PlatformNotifications.load('org');
 assert.equal(result.notifications.length,1);assert.equal(result.notifications[0].group_count,2);assert.equal(result.unread_count,1);
 assert.equal(sounds,2);assert.equal(celebrations,2);
 await window.PlatformNotifications.load('org');assert.equal(sounds,2);assert.equal(celebrations,2);
 await window.PlatformNotifications.dismiss('org','a');assert.deepEqual(changed,['a','b']);
});
