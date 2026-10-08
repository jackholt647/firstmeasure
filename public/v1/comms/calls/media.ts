import { createReadStream } from "node:fs";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../../src/config/env.js";
import { notFound, badRequest } from "../../platform/errors.js";
import { voiceClient, voiceMode } from "../../telephony/telnyx.js";
import { TelnyxError } from "../../messaging/telnyx.js";
import { deleteSharedObject, getSharedObject, isSpacesArtifactStorageEnabled, putSharedObject } from "../../src/storage/project_artifacts.js";
import * as s from "./storage.js";
import { text, object, type Json } from "./storage.js";

function localRecording(orgId:string,artifact:Json){
  const root=path.resolve(env.messagingStorageRoot,"call-recordings",s.id("org",orgId));
  const file=path.resolve(text(object(artifact.data).file_path));
  if(!file.startsWith(root+path.sep))throw notFound("recording_unavailable","This recording is unavailable.");
  return file;
}
function objectKey(orgId:string,artifactId:string,extension:string){
  if(!['mp3','wav'].includes(extension))throw badRequest("recording_format_invalid","Unsupported recording format.");
  return `communications/call-recordings/${s.id("org",orgId)}/${s.id("artifact",artifactId)}.${extension}`;
}
function objectRecording(orgId:string,artifactId:string,artifact:Json){
  const key=text(object(artifact.data).object_key);
  const extension=text(object(artifact.data).content_type)==="audio/wav"?"wav":"mp3";
  if(key!==objectKey(orgId,artifactId,extension))throw notFound("recording_unavailable","This recording is unavailable.");
  return key;
}
export async function saveRecording(orgId:string,artifactId:string,content:Buffer,extension:"mp3"|"wav"){
  const contentType=extension==="mp3"?"audio/mpeg":"audio/wav";
  if(isSpacesArtifactStorageEnabled()){
    const key=objectKey(orgId,artifactId,extension);
    await putSharedObject(key,content,contentType);
    return {object_key:key,content_type:contentType,bytes:content.length};
  }
  const folder=path.resolve(env.messagingStorageRoot,"call-recordings",s.id("org",orgId));
  await mkdir(folder,{recursive:true});
  const filename=path.join(folder,`${artifactId}.${extension}`),temporary=`${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary,content,{mode:0o600});await rename(temporary,filename);
  return {file_path:filename,content_type:contentType,bytes:content.length};
}
export async function removeRecording(orgId:string,artifactId:string,artifact:Json){
  const data=object(artifact.data);
  if(text(data.object_key))await deleteSharedObject(objectRecording(orgId,artifactId,artifact));
  if(text(data.file_path))await unlink(localRecording(orgId,artifact)).catch(error=>{if(error.code!=='ENOENT')throw error;});
}
export async function streamRecording(req:FastifyRequest,reply:FastifyReply,orgId:string,callId:string,artifactId:string){
  const artifact=(await s.artifacts(orgId,callId)).find(a=>a.id===artifactId);
  if(!artifact||artifact.state!=="ready"||text(artifact.expires_at)<=s.now()||!['recording','voicemail'].includes(text(artifact.kind)))throw notFound("recording_unavailable","This recording is unavailable or has expired.");
  const remote=text(object(artifact.data).object_key);
  const content=remote?await getSharedObject(objectRecording(orgId,artifactId,artifact)):null;
  const filename=remote?"":localRecording(orgId,artifact);
  const info=remote?null:await stat(filename).catch(()=>null);
  if(remote&&!content||!remote&&!info?.isFile())throw notFound("recording_unavailable","This recording is unavailable.");
  const size=content?.length??info!.size;
  reply.header("Cache-Control","private, no-store").header("X-Content-Type-Options","nosniff").header("Accept-Ranges","bytes").type(text(object(artifact.data).content_type)||"audio/mpeg");
  const range=text(req.headers.range);
  if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);if(!match)throw badRequest("range_invalid","Invalid audio range.");
    const start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]));const end=match[1]&&match[2]?Number(match[2]):size-1;
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||end>=size)return reply.code(416).header("Content-Range",`bytes */${size}`).send();
    reply.code(206).header("Content-Range",`bytes ${start}-${end}/${size}`).header("Content-Length",end-start+1);return reply.send(content?content.subarray(start,end+1):createReadStream(filename,{start,end}));
  }
  reply.header("Content-Length",size);return reply.send(content??createReadStream(filename));
}
export async function deleteArtifact(orgId:string,callId:string,artifactId:string,actor="retention"){
  const row=object((await s.database().prepare("SELECT * FROM customer_call_artifacts WHERE organization_id=? AND call_id=? AND id=?").get(orgId,callId,artifactId)));
  if(!row.id)return;const artifact={...row,data:object(JSON.parse(text(row.data_json)||'{}'))};
  const data=object(artifact.data);
  // Tombstone before I/O so late provider events cannot make deleted content visible again.
  (await s.database().prepare("UPDATE customer_call_artifacts SET state='deleted' WHERE organization_id=? AND id=?").run(orgId,artifactId));
  if(text(data.provider_recording_id))(await s.database().prepare("UPDATE customer_call_artifacts SET state='deleted',data_json='{}' WHERE organization_id=? AND call_id=? AND kind='transcript' AND json_extract(data_json,'$.recording_id')=?", "UPDATE customer_call_artifacts SET state='deleted',data_json='{}' WHERE organization_id=? AND call_id=? AND kind='transcript' AND data_json::jsonb #>> '{recording_id}'=?")
    .run(orgId,callId,text(data.provider_recording_id)));
  if(text(data.file_path)||text(data.object_key))await removeRecording(orgId,artifactId,artifact);
  if(text(data.provider_recording_id)){
    if(voiceMode()!=='live')return; // Keep the deletion job discoverable until provider deletion can run.
    try{await voiceClient().deleteRecording(text(data.provider_recording_id));}catch(error){if(!(error instanceof TelnyxError&&error.statusCode===404))throw error;}
  }
  (await s.database().prepare("UPDATE customer_call_artifacts SET data_json='{}' WHERE organization_id=? AND id=?").run(orgId,artifactId));
  (await s.appendEvent(orgId,callId,"communication.call.artifact_deleted",{artifact_id:artifactId,actor},`${artifactId}:deleted`));
}
export async function expireArtifacts(){
  const rows=(await s.database().prepare("SELECT organization_id,call_id,id FROM customer_call_artifacts WHERE (expires_at<=? AND state<>'deleted') OR (state='deleted' AND data_json<>'{}') LIMIT 30").all(s.now()));
  for(const row of rows)await deleteArtifact(text(object(row).organization_id),text(object(row).call_id),text(object(row).id));
}
