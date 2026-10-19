/** Photo discussions use the Notes message contract in a media-scoped channel.
 * No project channel or legacy markup list is modified by this adapter. */
import {createHash} from 'node:crypto';
import type {PlatformAuthContext} from '../platform/auth.js';
import {forbidden} from '../platform/errors.js';
import {readMediaMetadata,readMediaMarkupLayer} from '../platform/storage.js';
import {canReadReceiptMedia,canWriteReceiptMedia} from '../platform/media_access.js';
import {canAccessDepartmentResource} from '../workforce/department-access.js';
import * as store from './storage.js';
import {userDirectory,getChannel} from './service.js';
const clean=(v:unknown)=>String(v??'').trim();
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
export async function authorizePhotoDiscussion(ctx:PlatformAuthContext,mediaId:string,write=false){
 const media=await readMediaMetadata(ctx.orgId,mediaId);
 if(!canReadReceiptMedia(media,ctx)||!canAccessDepartmentResource(ctx,object(media.metadata))||(write&&!canWriteReceiptMedia(media,ctx)))throw forbidden('photo_comments_denied','This media discussion is not available to you.');
 return media;
}
export async function ensurePhotoDiscussion(ctx:PlatformAuthContext,mediaId:string){
 const media=await authorizePhotoDiscussion(ctx,mediaId);
 const key='photo-comments:'+mediaId;
 let channel=await store.findChannelByDmKey(ctx.orgId,key);
 if(!channel){
  try{channel=await store.createChannelRecord({organization_id:ctx.orgId,type:'project',dm_key:key,name:clean(media.file_name)||'Photo comments',created_by:ctx.userId,settings:{photo_media_id:mediaId}});}
  catch(error){channel=await store.findChannelByDmKey(ctx.orgId,key);if(!channel)throw error;}
 }
 // Import once, atomically and without sending historical mention notifications.
 // The original markup layer remains intact as a recovery source.
 if(channel.settings.photo_comments_imported!==true){
  const layer=await readMediaMarkupLayer(ctx.orgId,mediaId,'photo_comments').catch((error:unknown)=>{if(object(error).statusCode===404)return null;throw error;});
  const legacy=object(layer?.data).comments;
  const directory=await userDirectory(ctx.orgId);
  await store.getChannelsDatabase().transaction(async db=>{
   // Serialize imports across processes before re-reading the completed marker.
   await db.prepare("UPDATE channels SET updated_at=updated_at WHERE organization_id=? AND id=?").run(ctx.orgId,channel!.id);
   const fresh=(await store.readChannelRecord(ctx.orgId,channel!.id))!;
   if(fresh.settings.photo_comments_imported===true)return;
   for(const [index,value] of (Array.isArray(legacy)?legacy:[]).entries()){
    const comment=object(value),email=clean(comment.author_email).toLowerCase();
    const matched=[...directory.values()].find(user=>user.id===clean(comment.author_id)||!!email&&user.email.toLowerCase()===email);
    const legacyId=clean(comment.id)||String(index);
    const authorId=matched?.id||'legacy_photo_'+createHash('sha256').update(mediaId+':'+legacyId).digest('hex');
    if(!clean(comment.text))continue;
    await store.createMessageRecord({organization_id:ctx.orgId,channel_id:channel!.id,author_id:authorId,client_msg_id:'legacy-photo:'+legacyId,text:clean(comment.text),created_at:clean(comment.created_at)||undefined,mention_users:Array.isArray(comment.mentions)?comment.mentions.map(object):[],metadata:{project_note:true,photo_comment:true,legacy_photo_author:matched?undefined:{id:authorId,name:clean(comment.author_name)||email||'Former member',email,avatar:''}}});
   }
   await store.updateChannelRecord(ctx.orgId,channel!.id,{settings:{...fresh.settings,photo_comments_imported:true}});
  });
 }
 return getChannel(ctx,channel.id);
}
