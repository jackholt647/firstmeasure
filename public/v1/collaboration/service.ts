import { createHash, randomBytes } from "node:crypto";
import { backgroundAuthContext, hasPermission, type PlatformAuthContext } from "../platform/auth.js";
import { isCapabilityEnabled } from "../platform/capabilities.js";
import { badRequest, forbidden, notFound } from "../platform/errors.js";
import { readOrganization, readDocument, upsertDocument } from "../platform/storage.js";
import { contactSettings, saveContactSettings } from "../contacts/service.js";
import { updateProjectData } from "../platform/project_document_mutation.js";
import { createOrganizationConnection, readOrganizationConnection } from "../connections/storage.js";
import { withDeferredWorkEvents } from "../work/engine.js";
import { policySchema, grantSchema, invitationSchema, relationshipSchema, audienceSchema, type ResourceRef, type GrantInput } from "./schemas.js";
import { withOrganizationLocks, collaborationStore, getRecord, findRecord, insertRecord, updateRecord, listRecords, audit, newId, now, resourceKey, type RecordValue } from "./storage.js";

export const actor=(ctx:PlatformAuthContext)=>({identity_id:ctx.identityId,organization_id:ctx.orgId,user_id:ctx.userId});
export function requirePermission(ctx:PlatformAuthContext,key:string){
  // Explicit decisions also win for legacy administrators; the seven historical flags are untouched.
  if(ctx.permissions?.[key]===false || !hasPermission(ctx,key))throw forbidden("collaboration_permission_denied","You do not have permission for this action.");
}
export async function currentActor(ctx:PlatformAuthContext){
  return backgroundAuthContext(ctx.orgId,ctx.userId);
}
export async function privacy(orgId:string){
  const saved=await findRecord(`privacy_${orgId}`,"privacy");
  return {policy:policySchema.parse(saved?.policy||{}),revision:saved?.revision||0};
}
export async function requireOpen(orgId:string,mode:"accept_connections"|"receive_shares"|"send_shares"){
  const [{policy},org]=await Promise.all([privacy(orgId),readOrganization(orgId)]);
  if(!policy.enabled || !policy[mode] || org.status!=="active" || !await isCapabilityEnabled(orgId,"platform.collaboration"))throw forbidden("collaboration_private","Organization privacy settings do not allow this interaction.");
  return policy;
}
export async function savePrivacy(ctx:PlatformAuthContext,raw:unknown,expected:number){
  ctx=await currentActor(ctx); requirePermission(ctx,"manage_external_privacy");
  const policy=policySchema.parse(raw);
  return withOrganizationLocks([ctx.orgId],async()=>{
    const current=await findRecord(`privacy_${ctx.orgId}`,"privacy");
    if(!current && expected!==0)throw badRequest("collaboration_revision_conflict","Reload these settings.");
    const saved=current?await updateRecord(current,{policy},expected):await insertRecord("privacy",{id:`privacy_${ctx.orgId}`,owner_org_id:ctx.orgId,status:"active",revision:1,policy});
    await audit(saved,"collaboration.privacy.changed",actor(ctx));return saved;
  });
}
const digest=(raw:string)=>createHash("sha256").update(raw).digest("hex");
const pairId=(a:string,b:string)=>`connection_${digest([a,b].sort().join(":"))}`;
export async function connectionBetween(a:string,b:string){return findRecord(pairId(a,b),"connection");}
export async function requireConnection(a:string,b:string){
  const connection=await connectionBetween(a,b);
  if(!connection || connection.status!=="active")throw forbidden("connection_required","An accepted active organization connection is required.");
  return connection;
}
export async function organizationProfile(orgId:string){
  const p=await privacy(orgId), org=await readOrganization(orgId);
  return {organization_id:orgId,name:p.policy.enabled?String(org.name):"Private organization"};
}
export async function createInvitation(ctx:PlatformAuthContext,raw:unknown){
  ctx=await currentActor(ctx);requirePermission(ctx,"manage_external_connections");
  const input=invitationSchema.parse(raw);
  if(input.grant){
    requirePermission(ctx,"manage_external_sharing");await validateOwnedResource(ctx,input.grant.resource);
    const {validateDelegatedOperations,validateSharedFields}=await import("./resources.js");
    validateDelegatedOperations(ctx,input.grant.resource.type,input.grant.operations);validateSharedFields(input.grant.resource.type,input.grant.fields);
  }
  const token=randomBytes(32).toString("base64url");
  return withOrganizationLocks([ctx.orgId],async()=>{
    await requireOpen(ctx.orgId,"send_shares");
    const invitation=await insertRecord("invitation",{...input,id:newId("invitation"),owner_org_id:ctx.orgId,revision:1,status:"pending",created_by:actor(ctx),created_at:now(),expires_at:new Date(Date.now()+input.expires_in_days*86400000).toISOString()});
    await collaborationStore().prepare("INSERT INTO collaboration_tokens(token_hash,invitation_id) VALUES(?,?)").run(digest(token),invitation.id);
    await audit(invitation,"collaboration.invitation.created",actor(ctx));
    return {invitation,token,url:`/portal/#collaboration_invite=${encodeURIComponent(token)}`};
  });
}
async function invitationByToken(token:string){
  if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw notFound("invitation_unavailable","This invitation is unavailable.");
  const row=await collaborationStore().prepare("SELECT invitation_id FROM collaboration_tokens WHERE token_hash=?").get(digest(token));
  if(!row)throw notFound("invitation_unavailable","This invitation is unavailable.");
  const invitation=await getRecord(String(row.invitation_id),"invitation");
  if(!["pending","claimed","accepted"].includes(invitation.status)||Date.parse(invitation.expires_at)<=Date.now())throw notFound("invitation_unavailable","This invitation has expired or been revoked.");
  return invitation;
}
export async function previewInvitation(ctx:PlatformAuthContext,token:string){
  const invitation=await invitationByToken(token);
  await requireOpen(invitation.owner_org_id,"send_shares");
  return {id:invitation.id,kind:invitation.kind,label:invitation.label,relationship:invitation.relationship,
    inviter:await organizationProfile(invitation.owner_org_id),expires_at:invitation.expires_at,
    recipient_kind:invitation.recipient_kind||"organization",email_required:!!invitation.email,email_matches:!invitation.email||invitation.email===String(ctx.identity.email).toLowerCase(),
    policy:(await privacy(ctx.orgId)).policy,
    requested_access:invitation.grant?{type:invitation.grant.resource.type,operations:invitation.grant.operations,fields:invitation.grant.fields}:null};
}
export async function acceptInvitation(ctx:PlatformAuthContext,token:string){
  ctx=await currentActor(ctx);requirePermission(ctx,"use_external_shares");
  const initial=await invitationByToken(token);
  const result=await withOrganizationLocks([ctx.orgId,initial.owner_org_id],async()=>{
    const inv=await invitationByToken(token);
    if(inv.recipient_kind!=="individual")requirePermission(ctx,"manage_external_connections");
    if(inv.owner_org_id===ctx.orgId)throw badRequest("connection_self","Choose the organization receiving this invitation.");
    await requireOpen(inv.owner_org_id,"send_shares");await requireOpen(ctx.orgId,inv.recipient_kind==="individual"?"receive_shares":"accept_connections");
    const metadata=ctx.identity.metadata as Record<string,any>||{};
    if(inv.email && (String(ctx.identity.email).toLowerCase()!==inv.email || !(metadata.email_verified===true || metadata.signup_email_verification?.verified===true)))throw forbidden("invitation_email_verification_required","Sign in with the invited email and verify it before accepting.");
    if(inv.recipient_org_id && inv.recipient_org_id!==ctx.orgId)throw forbidden("invitation_claimed","This invitation has already been claimed.");
    if(inv.status==="accepted"){
      if(inv.recipient_kind==="individual"&&inv.accepted_by.identity_id!==ctx.identityId)throw forbidden("invitation_claimed","This invitation has already been claimed.");
      return {invitation:inv,connection:inv.recipient_kind==="individual"?null:await requireConnection(inv.owner_org_id,ctx.orgId)};
    }
    if(inv.status==="claimed")return {invitation:inv,connection:null};
    // Untargeted links request owner approval. Possession alone never grants project access.
    const claimed=await updateRecord(inv,{recipient_org_id:ctx.orgId,accepted_by:actor(ctx),status:inv.email?"accepted":"claimed"},inv.revision);
    if(!inv.email){await audit(claimed,"collaboration.connection.requested",actor(ctx));return {invitation:claimed,connection:null};}
    return finalizeInvitation(ctx,claimed);
  });
  if(result.connection)await reconcileLocalContacts(result.connection);
  return result;
}
async function finalizeInvitation(ctx:PlatformAuthContext,inv:RecordValue){
  await requireOpen(inv.owner_org_id,"send_shares");await requireOpen(inv.recipient_org_id,inv.recipient_kind==="individual"?"receive_shares":"accept_connections");
  const issuer=await backgroundAuthContext(inv.created_by.organization_id,inv.created_by.user_id);
  requirePermission(issuer,"manage_external_connections");
  const acceptor=await backgroundAuthContext(inv.accepted_by.organization_id,inv.accepted_by.user_id);
  requirePermission(acceptor,inv.recipient_kind==="individual"?"use_external_shares":"manage_external_connections");
  if(inv.recipient_kind==="individual"){
    requirePermission(issuer,"manage_external_sharing");
    await createGrantInside(issuer,grantSchema.parse({...inv.grant,recipient_org_id:inv.recipient_org_id,recipient_identity_id:acceptor.identityId,audience:{mode:"selected",user_ids:[acceptor.userId]}}),`grant_${inv.id}`,true);
    await audit(inv,"collaboration.share.accepted",actor(ctx));
    return {invitation:inv,connection:null};
  }
  let connection=await connectionBetween(inv.owner_org_id,inv.recipient_org_id);
  if(connection?.status==="ended")connection=await updateRecord(connection,{status:"active",disabled_by:null},connection.revision);
  if(connection && connection.status!=="active")throw forbidden("connection_blocked","Restore this connection explicitly before accepting another invitation.");
  if(!connection)connection=await insertRecord("connection",{id:pairId(inv.owner_org_id,inv.recipient_org_id),owner_org_id:inv.owner_org_id,recipient_org_id:inv.recipient_org_id,status:"active",revision:1,created_at:now()});
  for(const orgId of [inv.owner_org_id,inv.recipient_org_id]){
    const id=`relationship_${digest(`${connection.id}:${orgId}`)}`;
    if(!await findRecord(id))await insertRecord("relationship",{id,owner_org_id:orgId,recipient_org_id:orgId===inv.owner_org_id?inv.recipient_org_id:inv.owner_org_id,connection_id:connection.id,classification:orgId===inv.owner_org_id?inv.relationship:"contact",note:"",payment_terms:"",status:"active",revision:1,created_at:now()});
  }
  await queueContactProjection(connection);
  if(inv.grant){
    requirePermission(issuer,"manage_external_sharing");
    await createGrantInside(issuer,grantSchema.parse({...inv.grant,recipient_org_id:inv.recipient_org_id}),`grant_${inv.id}`);
  }
  const accepted=inv.status==="accepted"?inv:await updateRecord(inv,{status:"accepted"},inv.revision);
  await audit(accepted,"collaboration.connection.accepted",actor(ctx));
  return {invitation:accepted,connection};
}
export async function approveInvitation(ctx:PlatformAuthContext,id:string,expected:number){
  ctx=await currentActor(ctx);requirePermission(ctx,"manage_external_connections");
  const initial=await getRecord(id,"invitation");
  const result=await withOrganizationLocks([ctx.orgId,initial.recipient_org_id],async()=>{
    const inv=await getRecord(id,"invitation");
    if(inv.owner_org_id!==ctx.orgId||inv.status!=="claimed"||Date.parse(inv.expires_at)<=Date.now())throw forbidden("invitation_unavailable","This request is unavailable.");
    if(expected!==inv.revision)throw badRequest("collaboration_revision_conflict","Reload this request.");
    return finalizeInvitation(ctx,inv);
  });
  if(result.connection)await reconcileLocalContacts(result.connection);return result;
}
export async function revokeInvitation(ctx:PlatformAuthContext,id:string,expected:number){
  ctx=await currentActor(ctx);requirePermission(ctx,"manage_external_connections");
  return withOrganizationLocks([ctx.orgId],async()=>{
    const inv=await getRecord(id,"invitation");if(inv.owner_org_id!==ctx.orgId)throw forbidden("invitation_unavailable","This invitation is unavailable.");
    const next=await updateRecord(inv,{status:"revoked"},expected);await audit(next,"collaboration.invitation.revoked",actor(ctx));return next;
  });
}
export async function setConnectionStatus(ctx:PlatformAuthContext,id:string,status:"active"|"suspended"|"blocked"|"ended",expected:number){
  ctx=await currentActor(ctx);requirePermission(ctx,"manage_external_connections");
  const initial=await getRecord(id,"connection");
  return withOrganizationLocks([initial.owner_org_id,initial.recipient_org_id],async()=>{
    const c=await getRecord(id,"connection");if(![c.owner_org_id,c.recipient_org_id].includes(ctx.orgId))throw forbidden("connection_unavailable","This connection is unavailable.");
    if(c.status==="ended"&&status!=="ended")throw forbidden("connection_ended","An ended connection cannot be restored. Create a new invitation to reconnect.");
    if(status==="active"&&c.status!=="active"&&c.disabled_by!==ctx.orgId)throw forbidden("connection_disabled","Only the organization that disabled this connection can restore it.");
    const next=await updateRecord(c,{status,disabled_by:status==="active"?null:ctx.orgId},expected);
    if(status==="ended"){
      const rows=await collaborationStore().prepare("SELECT value_json FROM collaboration_records WHERE kind='grant' AND status='active' AND ((owner_org_id=? AND recipient_org_id=?) OR (owner_org_id=? AND recipient_org_id=?))").all(c.owner_org_id,c.recipient_org_id,c.recipient_org_id,c.owner_org_id);
      for(const row of rows){const grant=JSON.parse(String(row.value_json));const revoked=await updateRecord(grant,{status:"revoked"},grant.revision);await audit(revoked,"collaboration.share.revoked",actor(ctx));}
    }
    await audit(next,`collaboration.connection.${status}`,actor(ctx));return next;
  });
}
export async function listRelationships(ctx:PlatformAuthContext,after="",limit=50){
  requirePermission(ctx,"view_partners");
  const page=await listRecords("relationship",ctx.orgId,"outbound",after,limit);
  for(const r of page.items){r.organization=await organizationProfile(r.recipient_org_id);r.connection=await getRecord(r.connection_id,"connection");r.classification=await relationshipClassification(r);}
  return page;
}
export async function relationshipClassification(relationship:RecordValue){
  if(!relationship.contact_ref)return relationship.classification;
  const {resolveContact}=await import("../contacts/service.js");
  const resolved=await resolveContact(relationship.owner_org_id,relationship.contact_ref).catch(()=>null);
  return Array.isArray(resolved?.contact.tags)&&resolved.contact.tags.includes("partner")?"partner":relationship.classification==="client"?"client":"contact";
}
export async function updateRelationship(ctx:PlatformAuthContext,id:string,raw:unknown){
  ctx=await currentActor(ctx);requirePermission(ctx,"manage_external_connections");const input=relationshipSchema.parse(raw);
  const value=await withOrganizationLocks([ctx.orgId],async()=>{
    const r=await getRecord(id,"relationship");if(r.owner_org_id!==ctx.orgId)throw forbidden("relationship_private","This relationship profile belongs to another organization.");
    const {expected_revision,...patch}=input;const saved=await updateRecord(r,patch,expected_revision);await queueContactProjection(await getRecord(r.connection_id,"connection"));await audit(saved,"collaboration.relationship.updated",actor(ctx));return saved;
  });
  await reconcileLocalContacts(await getRecord(value.connection_id,"connection"));return value;
}
export async function reconcileLocalContacts(connection:RecordValue){
  // Deterministic identifiers make repair safe after a local filesystem write fails.
  for(const owner of [connection.owner_org_id,connection.recipient_org_id]){
    await withOrganizationLocks([owner],async()=>{
    const other=owner===connection.owner_org_id?connection.recipient_org_id:connection.owner_org_id;
    const relationship=await getRecord(`relationship_${digest(`${connection.id}:${owner}`)}`,"relationship");
    const suffix=digest(`${connection.id}:${owner}`).slice(0,24), projectId=`partner_contact_${suffix}`,contactId=`partner_${suffix}`;
    const profile=await organizationProfile(other);
    let existing:any=null;try{existing=await readDocument(owner,"projects",projectId);}catch(e:any){if(e.statusCode!==404&&e.code!=="ENOENT")throw e;}
    const settings=await contactSettings(owner);
    if(!(settings.tags as any[]).some(t=>t.id==="partner"))await saveContactSettings(owner,{...settings,tags:[...(settings.tags as any[]),{id:"partner",label:"Partner",enabled:true}]});
    if(!existing){
      try{await upsertDocument(owner,"projects",{id:projectId,data:{workflow_state:"contact_only",title:profile.name,contacts:[]}},{createOnly:true});}
      catch(e:any){if(e.code!=="document_exists")throw e;}
    }
    await updateProjectData(owner,projectId,data=>{
      const contacts=Array.isArray(data.contacts)?data.contacts as Record<string,any>[]:[];
      const previous=contacts.find(c=>c.id===contactId)||{};
      const tags=[...new Set([...(previous.tags||[]).filter((v:string)=>v!=="partner"),"org",...(relationship.classification==="partner"?["partner"]:[])])];
      const contact={...previous,id:contactId,name:previous.name||profile.name,contact_kind:"org",tags,firstmate_connection_id:connection.id};
      return {...data,contacts:[...contacts.filter(c=>c.id!==contactId),contact]};
    });
    const workforceId=`partner_${suffix}`;
    try{await readOrganizationConnection(owner,workforceId);}catch(e:any){if(e.code!=="organization_connection_not_found")throw e;await createOrganizationConnection(owner,{id:workforceId,name:profile.name,linked_organization_id:other,link_status:"linked",metadata:{collaboration_connection_id:connection.id,contact_ref:{project_id:projectId,contact_id:contactId}}});}
    if(!relationship.contact_ref)await withOrganizationLocks([owner],async()=>{const fresh=await getRecord(relationship.id);await updateRecord(fresh,{contact_ref:{project_id:projectId,contact_id:contactId},workforce_connection_id:workforceId},fresh.revision);});
    });
  }
}
export async function validateOwnedResource(ctx:PlatformAuthContext,resource:ResourceRef){
  if(resource.owner_org_id!==ctx.orgId)throw forbidden("share_owner_required","Only the owning organization may share this resource.");
  const {validateResource}=await import("./resources.js");await validateResource(ctx,resource);
}
async function queueContactProjection(connection:RecordValue){
  const id=`projection_${connection.id}`,prior=await findRecord(id,"contact_projection");
  if(prior)await updateRecord(prior,{status:"pending"},prior.revision);
  else await insertRecord("contact_projection",{id,owner_org_id:connection.owner_org_id,recipient_org_id:connection.recipient_org_id,connection_id:connection.id,status:"pending",revision:1});
}
export async function repairCollaborationContacts(limit=25){
  const rows=await collaborationStore().prepare("SELECT value_json FROM collaboration_records WHERE kind='contact_projection' AND status='pending' ORDER BY revision,id LIMIT ?").all(limit);
  for(const row of rows){
    const job=JSON.parse(String(row.value_json));
    try{await withOrganizationLocks([job.owner_org_id,job.recipient_org_id],async()=>{
      const current=await getRecord(job.id);if(current.status!=="pending")return;
      await reconcileLocalContacts(await getRecord(job.connection_id,"connection"));
      await updateRecord(current,{status:"completed"},current.revision);
    });}catch{await withOrganizationLocks([job.owner_org_id,job.recipient_org_id],async()=>{const current=await getRecord(job.id);await updateRecord(current,{last_attempted_at:now()},current.revision);});}
  }
}
async function requireResourceCapability(orgId:string,resource:ResourceRef,operation:string){
  const capability=operation.startsWith("photos.")||resource.type==="media"?"platform.photos_feed":operation.startsWith("schedule.")?"platform.scheduling":resource.type==="document"?"platform.documents":resource.type==="invoice"?"platform.money":resource.type==="channel"?"apps.channels":"";
  if(capability&&!await isCapabilityEnabled(orgId,capability))throw forbidden("collaboration_feature_disabled","The required application is disabled for this organization.");
}
async function createGrantInside(ctx:PlatformAuthContext,input:GrantInput,id=newId("grant"),individualConsent=false){
  await validateOwnedResource(ctx,input.resource);
  const {validateSharedFields,validateDelegatedOperations}=await import("./resources.js");
  validateSharedFields(input.resource.type,input.fields);
  validateDelegatedOperations(ctx,input.resource.type,input.operations);
  for(const operation of input.operations)await requireResourceCapability(ctx.orgId,input.resource,operation);
  const policy=await requireOpen(ctx.orgId,"send_shares"),recipientPolicy=await requireOpen(input.recipient_org_id,"receive_shares");
  if(!policy.allowed_types.includes(input.resource.type)||!recipientPolicy.allowed_types.includes(input.resource.type))throw forbidden("sharing_type_private","Organization policy excludes this resource type.");
  if(!individualConsent)await requireConnection(ctx.orgId,input.recipient_org_id);
  if(input.expires_at&&Date.parse(input.expires_at)<=Date.now())throw badRequest("share_expired","Choose a future expiration.");
  if(await findRecord(id))return getRecord(id,"grant");
  const count=await collaborationStore().prepare("SELECT COUNT(*) AS count FROM collaboration_records WHERE kind='grant' AND resource_key=? AND recipient_org_id=? AND status='active'").get(resourceKey(input.resource),input.recipient_org_id);
  if(Number(count?.count)>=100)throw badRequest("share_limit","Revoke unused grants before adding more access policies for this organization and resource.");
  const value=await insertRecord("grant",{...input,id,individual_consent:individualConsent,owner_org_id:ctx.orgId,status:"active",revision:1,created_by:actor(ctx),created_at:now()});
  await audit(value,"collaboration.share.created",actor(ctx));return value;
}
export async function createGrant(ctx:PlatformAuthContext,raw:unknown){
  ctx=await currentActor(ctx);requirePermission(ctx,"manage_external_sharing");const input=grantSchema.parse(raw);
  return withOrganizationLocks([ctx.orgId,input.recipient_org_id],()=>createGrantInside(ctx,input));
}
export async function revokeGrant(ctx:PlatformAuthContext,id:string,expected:number){
  ctx=await currentActor(ctx);requirePermission(ctx,"manage_external_sharing");
  return withOrganizationLocks([ctx.orgId],async()=>{
    const g=await getRecord(id,"grant");if(g.owner_org_id!==ctx.orgId)throw forbidden("share_owner_required","Only the owner can revoke this share.");
    const next=await updateRecord(g,{status:"revoked"},expected);await audit(next,"collaboration.share.revoked",actor(ctx));return next;
  });
}
export function audienceAllows(ctx:PlatformAuthContext,g:RecordValue){
  if(g.recipient_identity_id&&g.recipient_identity_id!==ctx.identityId)return false;
  return g.audience.mode==="members"||g.audience.mode==="selected"&&g.audience.user_ids.includes(ctx.userId)||g.audience.mode==="managers"&&ctx.permissions?.manage_external_connections!==false&&hasPermission(ctx,"manage_external_connections");
}
export async function saveRecipientAudience(ctx:PlatformAuthContext,grantId:string,raw:unknown,expected:number){
  ctx=await currentActor(ctx);requirePermission(ctx,"manage_external_connections");
  const audience=audienceSchema.parse(raw);
  return withOrganizationLocks([ctx.orgId],async()=>{
    const grant=await getRecord(grantId,"grant");
    if(grant.recipient_org_id!==ctx.orgId)throw forbidden("share_recipient_required","Only the receiving organization can limit its audience.");
    for(const userId of audience.user_ids){const user=await readDocument(ctx.orgId,"users",userId);if(user.data.status!=="active")throw badRequest("participant_inactive","Select active members of your organization.");}
    const id=`audience_${grantId}`,current=await findRecord(id,"audience");
    if(!current&&expected!==0)throw badRequest("audience_revision","Reload this audience before saving.");
    const value=current?await updateRecord(current,{audience},expected):await insertRecord("audience",{id,owner_org_id:ctx.orgId,grant_id:grantId,audience,status:"active",revision:1});
    await audit(value,"collaboration.audience.updated",actor(ctx));return value;
  });
}
export async function authorizeShared(ctx:PlatformAuthContext,resource:ResourceRef,operation:string){
  ctx=await currentActor(ctx);requirePermission(ctx,"use_external_shares");
  await requireResourceCapability(ctx.orgId,resource,operation);await requireResourceCapability(resource.owner_org_id,resource,operation);
  if(ctx.orgId===resource.owner_org_id)throw badRequest("shared_resource_external","Use the owning organization's normal workspace for this resource.");
  const ownerPolicy=await requireOpen(resource.owner_org_id,"send_shares"),recipientPolicy=await requireOpen(ctx.orgId,"receive_shares");
  if(!ownerPolicy.allowed_types.includes(resource.type)||!recipientPolicy.allowed_types.includes(resource.type))throw forbidden("resource_private","This resource type is private.");
  const connection=await connectionBetween(resource.owner_org_id,ctx.orgId);
  if(connection&&connection.status!=="active")throw forbidden("connection_disabled","This organization connection is disabled.");
  const rows=await collaborationStore().prepare("SELECT value_json FROM collaboration_records WHERE kind='grant' AND resource_key=? AND recipient_org_id=? AND status='active'").all(resourceKey(resource),ctx.orgId);
  const eligible:RecordValue[]=[];
  const ownerDenials=new Set<string>();
  for(const row of rows){
    const grant=JSON.parse(String(row.value_json)) as RecordValue;
    if(!(connection?.status==="active"||grant.individual_consent===true&&grant.recipient_identity_id===ctx.identityId)||grant.expires_at&&Date.parse(grant.expires_at)<=Date.now()||!audienceAllows(ctx,grant))continue;
    for(const denied of grant.denied_operations)ownerDenials.add(denied);
    const local=await findRecord(`audience_${grant.id}`,"audience");
    if(!local||audienceAllows(ctx,local))eligible.push(grant);
  }
  if(ownerDenials.has(operation))throw forbidden("shared_operation_excluded","The owner has excluded this operation.");
  const grants=eligible.filter(g=>g.operations.includes(operation));
  if(!grants.length)throw forbidden("shared_access_denied","This resource or operation is not shared with you.");
  const operations=[...new Set(eligible.flatMap(g=>g.operations))].filter(op=>!ownerDenials.has(op)) as string[];
  return {ctx,grants,fields:[...new Set(grants.flatMap(g=>g.fields))] as string[],operations,ownerPolicy};
}
export async function withSharedAccess<T>(ctx:PlatformAuthContext,resource:ResourceRef,operation:string,fn:(decision:Awaited<ReturnType<typeof authorizeShared>>)=>Promise<T>){
  // Revocations and effects take the same lock. No client can construct a decision.
  return withDeferredWorkEvents(()=>withOrganizationLocks([ctx.orgId,resource.owner_org_id],async()=>fn(await authorizeShared(ctx,resource,operation))));
}
export async function participantView(viewerOrg:string,participant:{organization_id:string;user_id:string},authorizedContribution=false){
  const {policy}=await privacy(participant.organization_id);
  if(!policy.enabled)return {name:"Private participant"};
  if(viewerOrg!==participant.organization_id&&!authorizedContribution){
    const connection=await connectionBetween(viewerOrg,participant.organization_id);
    if(connection?.status!=="active")return {name:"External participant"};
  }
  const record=await readDocument(participant.organization_id,"users",participant.user_id).catch(()=>null);
  return {organization_id:participant.organization_id,name:policy.disclose_name?String(record?.data.name||"Former participant"):"Private participant",
    ...(policy.disclose_email?{email:String(record?.data.email||"")} : {}),...(policy.disclose_phone?{phone:String(record?.data.phone||"")}:{})};
}
