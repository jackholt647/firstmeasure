import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import test from 'node:test';

test('catalog-backed real S3 client reads make zero LISTs when warm and see writes and deletes', {skip:!process.env.TEST_POSTGRES_URL}, async()=>{
  const objects=new Map<string,{body:Buffer;etag:string}>();let version=0,lists=0,gets=0;
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url!,'http://localhost'), key=decodeURIComponent(url.pathname.replace(/^\/bucket\//,''));
    if(req.method==='PUT') {
      const chunks=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
      const etag='"v'+(++version)+'"';objects.set(key,{body:Buffer.concat(chunks),etag});res.setHeader('ETag',etag);res.end();return;
    }
    if(req.method==='DELETE'){objects.delete(key);res.statusCode=204;res.end();return;}
    if(url.searchParams.has('list-type')) {
      lists++; const prefix=url.searchParams.get('prefix')||'';
      res.setHeader('Content-Type','application/xml');res.end('<ListBucketResult><IsTruncated>false</IsTruncated>'+[...objects].filter(([k])=>k.startsWith(prefix)).map(([k,v])=>`<Contents><Key>${k}</Key><Size>${v.body.length}</Size><ETag>${v.etag.replaceAll('"','&quot;')}</ETag><LastModified>2026-10-12T00:00:00Z</LastModified></Contents>`).join('')+'</ListBucketResult>');return;
    }
    gets++;const found=objects.get(key);if(!found){res.statusCode=404;res.end();return;}
    res.setHeader('ETag',found.etag);res.end(found.body);
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const port=(server.address() as {port:number}).port;
  Object.assign(process.env,{FIRSTMEASURE_DATABASE_MODE:'postgres',DATABASE_URL:process.env.TEST_POSTGRES_URL,
    POSTGRES_POOL_MAX:'1',FIRSTMEASURE_ARTIFACT_STORAGE:'spaces',SPACES_ENDPOINT:`http://127.0.0.1:${port}`,
    SPACES_BUCKET:'bucket',SPACES_REGION:'test',SPACES_PREFIX:'test',SPACES_FORCE_PATH_STYLE:'true',
    SPACES_ACCESS_KEY_ID:'test',SPACES_SECRET_ACCESS_KEY:'test',SPACES_READ_FALLBACK_PREFIX:'',FIRSTMEASURE_ARTIFACT_CATALOG_READS:'true'});
  const db=await import('../src/database/postgres.js');
  await db.queryPostgres('CREATE TABLE IF NOT EXISTS projects(id text PRIMARY KEY, revision bigint NOT NULL DEFAULT 1)');
  const s=await import('../src/storage/project_artifacts.js');
  try {
    await s.putProjectArtifact('synthetic','app_metadata.json','{"value":1}');
    const cold=await s.listProjectArtifacts('synthetic',true);assert.equal(lists,1);
    assert.deepEqual(await s.readListedProjectJson('synthetic','app_metadata.json',cold[0]!.etag),{value:1});
    const beforeGets=gets;
    await Promise.all(Array.from({length:100},async()=>{
      const files=await s.listProjectArtifacts('synthetic',true);
      assert.deepEqual(await s.readListedProjectJson('synthetic','app_metadata.json',files[0]!.etag),{value:1});
    }));
    assert.equal(lists,1);assert.equal(gets,beforeGets);
    await s.putProjectArtifact('synthetic','app_metadata.json','{"value":2}');
    const changed=await s.listProjectArtifacts('synthetic',true);
    assert.deepEqual(await s.readListedProjectJson('synthetic','app_metadata.json',changed[0]!.etag),{value:2});
    assert.equal(lists,1);
    await s.deleteProjectArtifact('synthetic','app_metadata.json');
    assert.deepEqual(await s.listProjectArtifacts('synthetic'),[]);assert.equal(lists,1);
    await s.putSharedObject('projects/synthetic/shared.json','{}');
    assert.equal((await s.listProjectArtifacts('synthetic'))[0]!.name,'shared.json');assert.equal(lists,1);
    await s.deleteSharedObject('projects/synthetic/shared.json');
    assert.deepEqual(await s.listProjectArtifacts('synthetic'),[]);
    await Promise.all([s.putProjectArtifact('synthetic','one.json','1'),s.putProjectArtifact('synthetic','two.json','2')]);
    assert.deepEqual((await s.listProjectArtifacts('synthetic')).map(x=>x.name).sort(),['one.json','two.json']);
    const reconciledLists=lists;
    await s.listProjectArtifacts('synthetic');assert.equal(lists,reconciledLists);
  } finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await db.getPostgresPool().end();}
});
