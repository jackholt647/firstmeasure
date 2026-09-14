import { badRequest } from './errors.js';

export async function fetchRequiredSolarLayers<T>(url:string):Promise<T> {
  let response=await fetch(url);
  if(response.status===404) {
    // Exhaust Google's documented expanded-coverage option without moving pins.
    const fallback=new URL(url);
    fallback.searchParams.set('requiredQuality','BASE');
    fallback.searchParams.set('experiments','EXPANDED_COVERAGE');
    fallback.searchParams.set('view','IMAGERY_LAYERS');
    fallback.searchParams.set('exactQualityRequired','false');
    response=await fetch(fallback);
  }
  if(response.status===404)throw badRequest('solar_imagery_no_coverage','Google returned no height-map imagery at the selected structure pins, including expanded coverage.');
  if(!response.ok)throw badRequest('solar_layers_fetch_failed',`Google imagery request failed (HTTP ${response.status}). This is a provider failure, not confirmed missing coverage; retry or ask an administrator to check the provider.`);
  try{return await response.json() as T;}
  catch{throw badRequest('solar_layers_parse_failed','Google returned an unreadable imagery response. Retry or contact an administrator.');}
}

export async function fetchRequiredSolarDsm(rawUrl:string|undefined,key:string) {
  if(!rawUrl)throw badRequest('solar_dsm_not_returned','Google returned imagery metadata without a height-map download. This is not confirmed missing coverage; ask an administrator to investigate.');
  const url=new URL(rawUrl);url.searchParams.set('key',key);url.searchParams.set('alt','media');
  const response=await fetch(url,{headers:{Accept:'image/tiff,application/octet-stream,*/*'}});
  if(!response.ok)throw badRequest('solar_dsm_download_failed',`Google height-map download failed (HTTP ${response.status}). Retry to obtain a fresh download; this does not confirm missing coverage.`);
  const bytes=new Uint8Array(await response.arrayBuffer());
  if(bytes.length<8 || !((bytes[0]===73&&bytes[1]===73&&(bytes[2]===42||bytes[2]===43)&&bytes[3]===0)||(bytes[0]===77&&bytes[1]===77&&bytes[2]===0&&(bytes[3]===42||bytes[3]===43))))throw badRequest('solar_dsm_invalid','Google height-map download was empty or not a TIFF. Retry or ask an administrator to investigate.');
  return bytes;
}

export function imageryFailurePatch(error:unknown) {
  const noCoverage=(error as {code?:string})?.code==='solar_imagery_no_coverage';
  return {
    status:noCoverage?'needs_coverage_review':'needs_structure_pins',
    structure_pin_status:noCoverage?'coverage_review':'failed',
    structure_pin_error:String((error as Error)?.message||'Pin generation failed.'),
    timestamps:{structure_pins_failed_at:new Date().toISOString()}
  };
}
