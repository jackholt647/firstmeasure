import type { PlatformAuthContext } from '../platform/auth.js';
import { forbidden } from '../platform/errors.js';
import { isCapabilityEnabled } from '../platform/capabilities.js';
import { polishDraft } from '../platform/draft-polish.js';
import { requireChannelAccess } from './service.js';

export async function polishChannelDraft(ctx:PlatformAuthContext,channelId:string,input:{text:string;mention_names:string[]}){
 return polishDraft(ctx,input,async()=>{
  if(!await isCapabilityEnabled(ctx.orgId,'channels.ai'))throw forbidden('polish_unavailable','AI assistance is not enabled for Channels.');
  await requireChannelAccess(ctx,channelId,{post:true});
 });
}
