import assert from 'node:assert/strict';
import test from 'node:test';
import { hasPermission, type PlatformAuthContext } from '../platform/auth.js';
import { notificationPermissions, assertPersonalNotificationEdit } from '../platform/notifications/permissions.js';
import { factoryPersonaDefinitions } from '../workforce/access.js';

const auth = (patch: Partial<PlatformAuthContext> = {}) => ({ role:'viewer', permissions:{}, user:{}, ...patch } as PlatformAuthContext);
test('existing users retain personal settings and only settings administrators inherit organization management', () => {
  assert.deepEqual(notificationPermissions(auth()), {personal:true,organization:false});
  assert.deepEqual(notificationPermissions(auth({role:'admin'})), {personal:true,organization:true});
  assert.deepEqual(notificationPermissions(auth({permissions:{manage_company_settings:true}})), {personal:true,organization:true});
  assert.deepEqual(notificationPermissions(auth({permissions:{manage_notification_defaults:true}})), {personal:true,organization:true});
});
test('explicit personal denial wins even for administrators and does not revoke unrelated reads', () => {
  const ctx=auth({role:'admin',permissions:{manage_own_notifications:false,view_documents:true}});
  assert.equal(notificationPermissions(ctx).personal,false);
  assert.throws(()=>assertPersonalNotificationEdit(ctx), /cannot change/);
  assert.equal(hasPermission(ctx,'view_documents'),true);
  assert.equal(hasPermission(ctx,'manage_company_settings'),true); // legacy seven unchanged
  assert.equal(notificationPermissions(auth({role:'admin',user:{permission_overrides:{manage_own_notifications:false}}})).personal,false);
});
test('explicit role and user denials override wildcard and migration grants', () => {
  const ctx=auth({role:'admin',permissions:{'*':true,manage_own_notifications:true,manage_notification_defaults:true},accessProfile:{roles:[{permissions:{manage_own_notifications:false,manage_notification_defaults:false}}]} as any});
  assert.deepEqual(notificationPermissions(ctx),{personal:false,organization:false});
  assert.equal(notificationPermissions(auth({role:'admin',permissions:{manage_notification_defaults:false}})).organization,false);
  assert.equal(notificationPermissions(auth({role:'admin',user:{org_permissions:{items:{manage_notification_defaults:false}}}})).organization,false);
});
test('factory personas expose personal permission and administrators expose organization management', () => {
  const personas=factoryPersonaDefinitions();
  assert.ok(personas.every(role=>role.permissions.manage_own_notifications===true));
  assert.equal(personas.find(role=>role.id==='admin')?.permissions.manage_notification_defaults,true);
});
