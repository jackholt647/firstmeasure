import sharp from "sharp";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { badRequest } from "../platform/errors.js";
import { storeMediaUpload } from "../platform/storage.js";
const MAX_BYTES=10*1024*1024;
const IMAGE_TYPES=new Set(["image/jpeg","image/png","image/webp","image/gif"]);
export function publicPhotoAddress(address:string){
 if(isIP(address)!==4)return false;
 const [a,b,c]=address.split(".").map(Number);
 return !(a===0 || a===10 || a===127 || a! >= 224 || a===169 && b===254 || a===172 && b! >= 16 && b! <= 31 || a===192 && (b===168 || b===0 || b===2) || a===100 && b! >= 64 && b! <= 127 || a===198 && (b===18 || b===19 || b===51 && c===100) || a===203 && b===0 && c===113);
}
export function photoImportUrl(source:string){
 let url:URL;try{url=new URL(source);}catch{throw badRequest("contact_photo_url","Use an HTTPS photo URL.");}
 if(url.protocol!=="https:" || url.username || url.password || url.port && url.port!=="443" || isIP(url.hostname) || url.hostname.endsWith(".local") || !url.hostname.includes("."))throw badRequest("contact_photo_url","Photo URLs must use a public HTTPS host without credentials.");
 return url;
}
async function remoteImage(source:string,redirects=0):Promise<{bytes:Buffer;contentType:string}>{
 const url=photoImportUrl(source),addresses=await lookup(url.hostname,{family:4,all:true});
 if(!addresses.length || addresses.some(row=>!publicPhotoAddress(row.address)))throw badRequest("contact_photo_host","Private network photo URLs are not allowed.");
 return new Promise((resolve,reject)=>{
  const req=request(url,{signal:AbortSignal.timeout(15000),lookup:(_host,_options,callback)=>callback(null,addresses[0]!.address,4),headers:{Accept:"image/jpeg,image/png,image/webp,image/gif"}},response=>{
   if([301,302,303,307,308].includes(response.statusCode || 0)){
    response.resume();if(redirects>=3 || !response.headers.location){reject(badRequest("contact_photo_redirect","Too many photo redirects."));return;}
    remoteImage(new URL(response.headers.location,url).href,redirects+1).then(resolve,reject);return;
   }
   const contentType=String(response.headers["content-type"] || "").split(";")[0]!.trim().toLowerCase();
   if(response.statusCode!==200 || !IMAGE_TYPES.has(contentType) || Number(response.headers["content-length"] || 0)>MAX_BYTES){response.resume();reject(badRequest("contact_photo_response","The photo must be a JPEG, PNG, WebP or GIF under 10MB."));return;}
   let length=0;const chunks:Buffer[]=[];
   response.on("data",(chunk:Buffer)=>{length+=chunk.length;if(length>MAX_BYTES){response.destroy();reject(badRequest("contact_photo_size","The photo exceeds 10MB."));}else chunks.push(chunk);});
   response.on("error",reject);response.on("end",()=>resolve({bytes:Buffer.concat(chunks),contentType}));
  });req.on("error",reject);req.end();
 });
}
export async function importContactPhoto(orgId:string,contactId:string,projectId:string,source:string,importId:string){
 let image:{bytes:Buffer;contentType:string};
 if(source.startsWith("data:")){
  const match=/^data:(image\/(?:jpeg|png|webp|gif));base64,([a-zA-Z0-9+/=\s]+)$/.exec(source);
  if(!match || match[2]!.length>MAX_BYTES*1.4)throw badRequest("contact_photo_data","Invalid embedded contact photo.");
  image={contentType:match[1]!,bytes:Buffer.from(match[2]!.replace(/\s/g,""),"base64")};
 }else image=await remoteImage(source);
 if(!image.bytes.length || image.bytes.length>MAX_BYTES)throw badRequest("contact_photo_size","The photo must be under 10MB.");
 await validateContactPhoto(image);
 return storeMediaUpload(orgId,{...image,ownerType:"contact",ownerId:contactId,slot:"profile",collection:"contacts",scope:"contact",fileName:`profile.${image.contentType.split("/")[1]}`,metadata:{contact_record_project_id:projectId,import_id:importId,source:"contact_import"}});
}

export async function validateContactPhoto(image:{bytes:Buffer;contentType:string}){
 if(!IMAGE_TYPES.has(image.contentType) || !image.bytes.length || image.bytes.length>MAX_BYTES)throw badRequest("contact_photo_size","Choose a JPEG, PNG, WebP or GIF under 10MB.");
 const decoded=await sharp(image.bytes,{limitInputPixels:40000000}).metadata().catch(()=>null);
 if(!decoded || !["jpeg","png","webp","gif"].includes(decoded.format || ""))throw badRequest("contact_photo_data","The imported photo is not a supported image.");
}
