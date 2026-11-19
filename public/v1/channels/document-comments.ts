/** Document discussions (GP-68): the comments on a document in a project's Docs tab that is not a media file
 * (an invoice, a delivered report), using the Notes message contract in a channel of its own, like a photo
 * discussion. A media file keeps its photo discussion. Access is the project's: whoever may read the project's
 * notes may read and post here. No project channel is modified by this adapter. */
import {createHash} from 'node:crypto';
import type {PlatformAuthContext} from '../platform/auth.js';
import {hasPermission} from '../platform/auth.js';
import {badRequest,forbidden,notFound} from '../platform/errors.js';
import {readDocument} from '../platform/storage.js';
import * as store from './storage.js';
import {getChannel} from './service.js';
const clean=(v:unknown)=>String(v??'').trim();
export async function authorizeDocumentDiscussion(ctx:PlatformAuthContext,projectId:string){
 if(!hasPermission(ctx,'view_projects|manage_company_settings|crew.projects.view'))throw forbidden('document_comments_denied','This document discussion is not available to you.');
 try{return await readDocument(ctx.orgId,'projects',projectId);}
 catch{throw notFound('project_not_found','This project does not exist.');}
}
export async function ensureDocumentDiscussion(ctx:PlatformAuthContext,input:{project_id?:unknown;document_id?:unknown;title?:unknown}){
 const projectId=clean(input.project_id),documentId=clean(input.document_id);
 if(!projectId||!documentId||projectId.length>200||documentId.length>2000)throw badRequest('document_required','Name the project and the document.');
 await authorizeDocumentDiscussion(ctx,projectId);
 const key='document-comments:'+createHash('sha256').update(JSON.stringify([projectId,documentId])).digest('hex');
 let channel=await store.findChannelByDmKey(ctx.orgId,key);
 if(!channel){
  const name=clean(input.title).slice(0,80)||'Document comments';
  try{channel=await store.createChannelRecord({organization_id:ctx.orgId,type:'project',dm_key:key,name,created_by:ctx.userId,settings:{document_project_id:projectId,document_id:documentId}});}
  catch(error){channel=await store.findChannelByDmKey(ctx.orgId,key);if(!channel)throw error;}
 }
 return getChannel(ctx,channel.id);
}
