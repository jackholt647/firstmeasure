import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
const helper=fileURLToPath(new URL('../../measure/internal/_editor_transport.php',import.meta.url)).replaceAll('\\','/');
const phpLiteral=s=>"'"+s.replaceAll("'","\\'")+"'";
// Windows' standalone PHP CLI ships cURL disabled; enable it for this process
// only. Linux/FPM uses the installed production extension configuration.
const phpArgs=process.platform==='win32'
  ? ['-d',`extension_dir=${path.join(path.dirname(execFileSync('php',['-r','echo PHP_BINARY;'],{encoding:'utf8'})),'ext')}`,'-d','extension=curl'] : [];

test('PHP streams a 140 MiB snapshot under a 32 MiB memory limit without truncation',async()=>{
  const block='x'.repeat(1024*1024),prefix='{"pdf_state":{"mainImage":"',suffix='"}}';
  const server=createServer(async(req,res)=>{
    if(req.url==='/failure'){res.writeHead(503);res.end('private upstream error');return;}
    res.writeHead(200,{'Content-Type':'application/json'});res.write(prefix);
    for(let i=0;i<140;i++) if(!res.write(block)) await new Promise(resolve=>res.once('drain',resolve));
    res.end(suffix);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const run=route=>new Promise((resolve,reject)=>{
    const code=`require ${phpLiteral(helper)}; $ok=fm_editor_stream_node_bundle('http://127.0.0.1:${server.address().port}${route}'); fwrite(STDERR,json_encode(['ok'=>$ok,'peak'=>memory_get_peak_usage(true)]));`;
    const child=spawn('php',[...phpArgs,'-d','memory_limit=32M','-r',code]);let bytes=0,stderr='';const hash=createHash('sha256');
    child.stdout.on('data',b=>{bytes+=b.length;hash.update(b);});child.stderr.on('data',b=>stderr+=b);child.on('error',reject);
    child.on('exit',status=>resolve({status,bytes,stderr,sha256:hash.digest('hex')}));
  });
  try {
    const good=await run('/bundle');assert.equal(good.status,0,good.stderr);
    assert.equal(good.bytes,Buffer.byteLength(prefix)+140*1024*1024+Buffer.byteLength(suffix),good.stderr);
    const expected=createHash('sha256').update(prefix);for(let i=0;i<140;i++)expected.update(block);expected.update(suffix);
    assert.equal(good.sha256,expected.digest('hex'),'every byte, including saved images, must be preserved');
    const report=JSON.parse(good.stderr);assert.equal(report.ok,true);assert.ok(report.peak<32*1024*1024);
    const bad=await run('/failure');assert.equal(bad.bytes,0,'upstream errors must not be streamed as successful bundles');assert.match(bad.stderr,/"ok":false/);
  } finally {await new Promise(resolve=>server.close(resolve));}
});
