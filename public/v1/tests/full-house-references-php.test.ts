import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';

test('customer reference uploads preserve view assignments and support video ranges', async () => {
  const artifacts=new Map<string,Buffer>();
  const upstream = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url?.endsWith('/capability')) return response.end('{"email":"owner@example.test"}');
    if(request.method==='POST'){
      const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));const bytes=Buffer.concat(chunks),text=bytes.toString('latin1'),name=text.match(/filename="([^"]+)"/)?.[1];if(!name){response.statusCode=400;return response.end('{}');}const start=bytes.indexOf(Buffer.from('\r\n\r\n'))+4,end=bytes.lastIndexOf(Buffer.from('\r\n--'));artifacts.set(name,bytes.subarray(start,end));return response.end(JSON.stringify({ok:true,artifact:{name}}));
    }
    const name=decodeURIComponent(request.url?.split('/artifacts/')[1]||'');if(name){const data=artifacts.get(name);if(!data){response.statusCode=404;return response.end('{}');}return response.end(data);}
    response.end(JSON.stringify({files:[...artifacts].map(([name,data])=>({name,size:data.length}))}));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const port = (upstream.address() as { port: number }).port;
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const phpPort = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'full-house-address-'));
  const target = path.resolve('../measure/internal/project_resources.php').replace(/\\/g, '/');
  const router = path.join(temporary, 'router.php');
  await writeFile(router, `<?php session_save_path(${JSON.stringify(temporary.replace(/\\/g, '/'))}); session_id('address-test'); session_start(); $_SESSION=['user_email'=>'owner@example.test','full_house_csrf'=>'test-csrf']; session_write_close(); require ${JSON.stringify(target)};`);
  const binary = spawnSync('php', ['-r', 'echo PHP_BINARY;'], { encoding: 'utf8' }).stdout.trim();
  const extensions = process.platform === 'win32' ? ['-d', `extension_dir=${path.join(path.dirname(binary), 'ext')}`, '-d', 'extension=curl'] : [];
  const child = spawn(binary, [...extensions, '-S', `127.0.0.1:${phpPort}`, router], {
    env: { ...process.env, FIRSTMEASURE_API_BASE: `http://127.0.0.1:${port}/v1/firstmeasure`, FIRSTMEASURE_FULL_HOUSE_SIGNING_SECRET: 'test-signing-secret' }, stdio: 'ignore'
  });
  const url = `http://127.0.0.1:${phpPort}/project_resources.php?project=fullhouse_${'a'.repeat(32)}`;
  try {
    for (let attempt = 0; ; attempt++) {
      try { if ((await fetch(url)).ok) break; } catch { /* wait for the test PHP server */ }
      if (attempt >= 50) throw Error('Test PHP server failed to start');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const headers={'X-Resource-Request':'1','X-Resource-Origin':'customer-order','X-Full-House-CSRF':'test-csrf'};
    const post=(name:string,body:string|Buffer,extra={})=>fetch(url+'&name='+name,{method:'POST',headers:{...headers,...extra},body:typeof body==='string'?body:new Uint8Array(body)});
    const id='12345678-1234-4234-8234-123456789abc',part='internal-markup-part-'+id+'-00000000.bin',name='internal-resource-v2-'+id+'-front.jpg',bytes=Buffer.from('test photo bytes');
    const index={format:'firstmeasure-resource-chunks-v1',id,size:bytes.length,chunkSize:8*1024*1024,parts:1,original_name:'My front photo.jpg',elevation_view:'front',role:'qa'};
    assert.equal((await post(part,bytes,{'X-Full-House-CSRF':'wrong'})).status,403);
    assert.equal((await post(name,JSON.stringify(index))).status,409,'incomplete uploads stay unpublished');
    assert.equal((await post(part,bytes)).status,200);assert.equal((await post(name,JSON.stringify({...index,elevation_view:'invalid'}))).status,422);
    assert.equal((await post(name,JSON.stringify(index))).status,200);
    const listing=await(await fetch(url)).json();assert.equal(listing.files.length,1);assert.equal(listing.files[0].role,'customer');assert.equal(listing.files[0].elevation_view,'front');assert.equal(listing.files[0].original_name,'My front photo.jpg');assert.equal(listing.files[0].source,'customer-order');
    const video='internal-resource-v2-'+id+'-video.mp4';assert.equal((await post(video,JSON.stringify({...index,elevation_view:null,original_name:'Walkthrough.mp4'}))).status,200);
    const range=await fetch(url+'&name='+video,{headers:{Range:'bytes=2-5'}});assert.equal(range.status,206);assert.deepEqual(Buffer.from(await range.arrayBuffer()),bytes.subarray(2,6));
    assert.equal((await post(name,JSON.stringify(index),{'X-Resource-Origin':'editor','X-Resource-Role':'qa'})).status,200);const edited=JSON.parse(artifacts.get(name)!.toString());assert.equal(edited.role,'qa');assert.equal(edited.elevation_view,undefined,'ordinary uploads cannot claim customer assignments');
  } finally {
    child.kill();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
