import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
let root:string,storage:typeof import('../platform/storage.js'),compliance:typeof import('../messaging/storage.js'),approval:typeof import('../messaging/approval_notifications.js'),delivery:typeof import('../platform/notifications/delivery.js');
const sent:any[]=[];const originalFetch=globalThis.fetch;
before(async()=>{
 root=await mkdtemp(path.join(os.tmpdir(),'sms-approval-'));
 Object.assign(process.env,{NODE_ENV:'test',FIRSTMATE_ENV:'test',PLATFORM_STORAGE_ROOT:path.join(root,'platform'),MESSAGING_STORAGE_ROOT:path.join(root,'messaging'),MESSAGING_ENCRYPTION_KEY:'test-approval-key',FIRSTMEASURE_STORAGE_ROOT:path.join(root,'firstmeasure'),CRM_STORAGE_ROOT:path.join(root,'crm'),PRICEBOOK_STORAGE_ROOT:path.join(root,'pricebook'),PLATFORM_HEARTBEAT_DISABLED:'1',FIRSTMEASURE_JOB_WORKERS:'0',COMMUNICATIONS_DELIVERY_MODE:'capture',POSTMARK_SERVER_TOKEN:'test-token',EMAIL_OUTBOUND_DISABLED:'0'});
 globalThis.fetch=(async(url:any,options:any)=>{assert.equal(String(url),'https://api.postmarkapp.com/email');sent.push(JSON.parse(options.body));return new Response(JSON.stringify({ErrorCode:0,MessageID:'accepted'}),{status:200});}) as typeof fetch;
 storage=await import('../platform/storage.js');compliance=await import('../messaging/storage.js');approval=await import('../messaging/approval_notifications.js');delivery=await import('../platform/notifications/delivery.js');
});
after(async()=>{globalThis.fetch=originalFetch;await(await import('./helpers/platform-fixture.js')).closePlatformFixtureStores();await(await import('../messaging/communications_storage.js')).closeCommunicationsDatabase();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
async function fixture(id:string){
 await storage.createOrganization({id,name:'Cedar Test'});
 await(await import('../platform/capabilities.js')).saveCapabilityValues(id,{'platform.expanded_access':true,'apps.messaging':true,'apps.notifications':true,'platform.sms_settings':true});
 for(const [name,level,status] of [['owner','owner','active'],['optout','admin','active'],['employee','member','active'],['disabled','owner','disabled']]){
  const identity=await storage.createIdentity({email:`${id}-${name}@example.test`,name});
  await storage.addIdentityMembership(String(identity.id),id,name!,level!);
  await storage.upsertDocument(id,'users',{id:name!,data:{identity_id:identity.id,email:identity.email,role:level,status,org_permissions:{level,items:{}},...(name==='optout'?{notification_preferences:{email:{'sms_registration.approved':false}}}:{})}});
 }
 const org=await compliance.ensureMessagingOrganization(id);
 return compliance.updateSmsComplianceProfile(await compliance.createSmsComplianceProfile(org),{status:'campaign_submitted',brand_status:'verified',campaign_status:'pending',brand:{displayName:'Cedar Test'},provider_refs:{telnyx_brand_id:`brand-${id}`,telnyx_campaign_id:`campaign-${id}`}});
}
test('approval via webhook sends one in-app/account email notice and respects active manager audience and email opt-outs',async()=>{
 const profile=await fixture('org_approval');await approval.notifySmsCampaignApproved(profile);
 assert.equal((await storage.listDocuments(profile.external_organization_id,'notifications')).length,0);
 const webhooks=await import('../messaging/telnyx_webhooks.js');
 const event={data:{id:'approval-event-1',event_type:'10dlc.campaign.update',occurred_at:'2026-10-12T05:00:00Z',payload:{campaignId:profile.provider_refs.telnyx_campaign_id,type:'VERIFIED',status:'MNO_PROVISIONED'}}};
 await webhooks.acceptTelnyxWebhook(event);
 const current=await compliance.readSmsComplianceProfile(profile.messaging_organization_id,profile.id);assert.equal(current.campaign_status,'mno_provisioned');
 await webhooks.acceptTelnyxWebhook(event);await approval.notifySmsCampaignApproved(current);await approval.recoverSmsApprovalNotifications();await delivery.drainNotifications(100);
 const notes=await storage.listDocuments(profile.external_organization_id,'notifications');assert.equal(notes.length,1);
 assert.equal((notes[0]!.data.frontend_action as any).kind,'open_sms_registration');assert.deepEqual([...(notes[0]!.data.target_user_ids as string[])].sort(),['optout','owner']);assert.match(String(notes[0]!.data.body),/approved by the carriers/);assert.doesNotMatch(String(notes[0]!.data.body),/ready to send/);
 const {notificationStore}=await import('../platform/notifications/store.js');
 const recipients=await notificationStore().prepare('SELECT user_id,id FROM notification_recipients WHERE organization_id=?').all(profile.external_organization_id);assert.equal(recipients.length,2);
 for(const recipient of recipients){const rows=await notificationStore().prepare('SELECT method,state FROM notification_deliveries WHERE recipient_id=?').all(String(recipient.id));assert.equal(rows.find(r=>r.method==='in_app')?.state,'available');assert.equal(rows.find(r=>r.method==='email')?.state,recipient.user_id==='owner'?'accepted':'suppressed');}
 assert.equal(sent.length,1);assert.equal(sent[0].From,'noreply@1m8.ai');assert.equal(sent[0].To,'org_approval-owner@example.test');assert.equal(sent[0].Tag,'sms-registration-approved');
});
test('mock, rejected, brand-only and deactivated registrations never announce campaign approval',async()=>{
 const profile=await fixture('org_nonapproved');
 for(const patch of [{campaign_status:'mno_rejected'},{campaign_status:'pending'},{campaign_status:'mno_provisioned',status:'deactivated'},{campaign_status:'mno_provisioned',provider_refs:{telnyx_campaign_id:'mock_campaign'}},{campaign_status:'mno_provisioned',events:[{type:'campaign_submitted',mock:true}]}]){assert.equal(approval.smsCampaignApproval({...profile,...patch}),false);await approval.notifySmsCampaignApproved({...profile,...patch});}
 assert.equal((await storage.listDocuments(profile.external_organization_id,'notifications')).length,0);
});
test('recovery enqueues a missed approval after status was committed and remains idempotent',async()=>{
 const profile=await fixture('org_recovery');await compliance.updateSmsComplianceProfile(profile,{campaign_status:'mno_provisioned',events:[{type:'provider_status_refreshed',approval_notification_campaign_id:profile.provider_refs.telnyx_campaign_id}]});await approval.recoverSmsApprovalNotifications();await approval.recoverSmsApprovalNotifications();assert.equal((await storage.listDocuments(profile.external_organization_id,'notifications')).length,1);
});
