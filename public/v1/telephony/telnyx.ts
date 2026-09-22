import { randomBytes } from "node:crypto";
import { TelnyxClient, TelnyxError } from "../messaging/telnyx.js";
import { env } from "../src/config/env.js";
import { badRequest, conflict } from "../platform/errors.js";
import { isTelnyxWebhookPublicKeyValid } from "../messaging/telnyx_webhooks.js";
import { id, object, text, type Json } from "../comms/calls/storage.js";

/** The browser receives a short-lived endpoint token, never this account client. */
export class TelnyxVoiceClient {
  constructor(private readonly client = new TelnyxClient()) {}
  async request(path:string, method="GET", body?:Json) {
    return this.client.request(path,{method,...(body?{body:JSON.stringify(body)}:{})});
  }
  async data(path:string,method="GET",body?:Json) { const result=object(await this.request(path,method,body));return object(result.data); }
  async dial(payload:Json) {return this.data("/calls","POST",payload);}
  async command(controlId:string,action:string,payload:Json={}) {
    const allowed=new Set(["answer","hangup","bridge","send_dtmf","speak","playback_start","playback_stop","record_start","record_stop","record_pause","record_resume","transcription_start","transcription_stop","transfer","enqueue","leave_queue"]);
    if(!allowed.has(action))throw badRequest("invalid_voice_command","Unsupported voice action.");
    return this.data(`/calls/${encodeURIComponent(controlId)}/actions/${action}`,"POST",payload);
  }
  async readCall(controlId:string) {return this.data(`/calls/${encodeURIComponent(controlId)}`);}
  async createConference(payload:Json){return this.data("/conferences","POST",payload);}
  async conference(conferenceId:string,action:string,payload:Json){
    if(!["join","leave","hold","unhold","mute","unmute","end"].includes(action))throw badRequest("conference_action_invalid","Unsupported conference action.");
    return this.data(`/conferences/${encodeURIComponent(conferenceId)}/actions/${action}`,"POST",payload);
  }
  async readNumber(providerId:string) {return this.data(`/phone_numbers/${encodeURIComponent(providerId)}`);}
  async bindNumber(providerId:string,connectionId:string) {return this.data(`/phone_numbers/${encodeURIComponent(providerId)}`,"PATCH",{connection_id:connectionId});}
  async createCredential(connectionId:string,name:string) {
    return this.data("/telephony_credentials","POST",{connection_id:connectionId,name,expires_at:new Date(Date.now()+24*3600_000).toISOString()});
  }
  async token(credentialId:string) {
    const raw=await this.request(`/telephony_credentials/${encodeURIComponent(credentialId)}/token`,"POST");
    const token=typeof raw==="string"?raw:text(object(raw).data||object(raw).token);
    if(!token||token.split(".").length!==3)throw conflict("voice_token_unavailable","The phone provider did not return an endpoint token.");
    let expiry=0;try{expiry=Number(JSON.parse(Buffer.from(token.split(".")[1]!,"base64url").toString()).exp)*1000;}catch{}
    return {token,expires_at:expiry?new Date(expiry).toISOString():new Date(Date.now()+3600_000).toISOString()};
  }
  async revokeCredential(credentialId:string) {try{await this.request(`/telephony_credentials/${encodeURIComponent(credentialId)}`,"DELETE");}catch(error){if(!(error instanceof TelnyxError&&error.statusCode===404))throw error;}}
  async recording(recordingId:string) {return this.data(`/recordings/${encodeURIComponent(recordingId)}`);}
  async deleteRecording(recordingId:string) {await this.request(`/recordings/${encodeURIComponent(recordingId)}`,"DELETE");}
  async list(path:string) {const body=object(await this.request(path));return Array.isArray(body.data)?body.data.map(object):[];}
  async findNamed(path:string,field:string,name:string){
    const matches:Json[]=[];
    for(let page=1;page<=30;page++){
      const body=object(await this.request(`${path}?page[size]=100&page[number]=${page}`));
      const rows=Array.isArray(body.data)?body.data.map(object):[];matches.push(...rows.filter(row=>text(row[field])===name));
      const pages=Number(object(body.meta).total_pages);
      if((pages&&page>=pages)||rows.length<100)return matches;
    }
    throw conflict('provider_inventory_limit','Provider reconciliation exceeded the inventory limit. Review the named resource in Telnyx.');
  }
  async createOutboundProfile(orgId:string,limit:number,dailySpend:string,countries:string[]) {
    return this.data("/outbound_voice_profiles","POST",{name:`FirstMate ${id("org",orgId)} voice`,enabled:true,concurrent_call_limit:limit*3,
      daily_spend_limit:dailySpend,daily_spend_limit_enabled:true,whitelisted_destinations:countries,traffic_type:"conversational",service_plan:"global"});
  }
  async createApplication(orgId:string,profileId:string) {
    return this.data("/call_control_applications","POST",{application_name:`FirstMate ${id("org",orgId)} customer calls`,active:true,
      webhook_event_url:voiceWebhookUrl(),webhook_api_version:"2",call_cost_in_webhooks:true,redact_dtmf_debug_logging:true,
      first_command_timeout:true,first_command_timeout_secs:30,outbound:{outbound_voice_profile_id:profileId}});
  }
  async createConnection(orgId:string) {
    // Every browser-originated call is parked and rejected by our webhook handler.
    // Only server-authorized Call Control calls can reach the customer PSTN leg.
    return this.data("/credential_connections","POST",{connection_name:`FirstMate ${id("org",orgId)} staff`,user_name:`fm_${randomBytes(12).toString("hex")}`,
      password:randomBytes(32).toString("base64url"),active:true,sip_uri_calling_preference:"internal",encrypted_media:"SRTP",
      webhook_event_url:voiceWebhookUrl(),webhook_api_version:"2",outbound:{call_parking_enabled:true,channel_limit:1},
      inbound:{codecs:["OPUS","G722","PCMU","PCMA"]}});
  }
}
let factory:()=>TelnyxVoiceClient=()=>new TelnyxVoiceClient();
export function voiceClient(){return factory();}
/** Test injection never changes provider mode or bypasses production authorization. */
export function setVoiceClientFactoryForTests(next:(()=>TelnyxVoiceClient)|null){
  if(process.env.NODE_ENV!=="test")throw new Error("Voice adapter injection is restricted to tests.");
  factory=next||(()=>new TelnyxVoiceClient());
}
export function voiceMode(){return process.env.TELNYX_VOICE_MODE==="live"?"live":"disabled";}
export function voiceWebhookUrl(){return text(process.env.TELNYX_VOICE_WEBHOOK_URL)||`${env.publicBaseUrl.replace(/\/$/,"")}/v1/comms/voice/webhooks/telnyx`;}
export function voiceEnvironmentStatus(){
  const webhook=voiceWebhookUrl();let https=false;try{const u=new URL(webhook);https=u.protocol==="https:"&&!/^(localhost|127\.|\[::1\])/.test(u.hostname);}catch{}
  return {mode:voiceMode(),api_key_configured:!!env.telnyxApiKey,webhook_key_configured:isTelnyxWebhookPublicKeyValid(),webhook_url:webhook,public_https:https};
}
export function requireVoiceEnvironment(){
  const status=voiceEnvironmentStatus();
  if(status.mode!=="live")throw conflict("voice_disabled","Browser calling is disabled on this server. External call logging is available.");
  if(!status.api_key_configured||!status.webhook_key_configured||!status.public_https)throw conflict("voice_configuration_required","Configure the Telnyx API key, webhook verification key, and public HTTPS voice webhook before enabling calls.");
}
