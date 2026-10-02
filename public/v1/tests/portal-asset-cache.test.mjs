import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

test('portal asset URLs reuse unchanged bytes and change when file contents change',async t=>{
  if(spawnSync('php',['--version']).error){t.skip('PHP is not installed');return;}
  const dir=await mkdtemp(path.join(tmpdir(),'fm-asset-cache-'));
  try {
    await writeFile(path.join(dir,'asset-version.php'),await readFile(new URL('../../portal/asset-version.php',import.meta.url)));
    const asset=path.join(dir,'app.js');
    const version=()=>{
      const result=spawnSync('php',['-r',"require 'asset-version.php'; echo portalAssetVersion('app.js');"],{cwd:dir,encoding:'utf8'});
      assert.equal(result.status,0,result.stderr);
      return result.stdout;
    };
    await writeFile(asset,'const value=1;');
    const first=version();
    assert.match(first,/^[a-f0-9]{16}$/);
    assert.equal(version(),first,'a separate page request has the same asset URL');
    await writeFile(asset,'const value=2;');
    assert.notEqual(version(),first,'even a same-size change invalidates the cache');
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('every portal timestamp asset is now content versioned',async()=>{
  const portal=await readFile(new URL('../../portal/index.php',import.meta.url),'utf8');
  assert.doesNotMatch(portal,/\$ver\s*=\s*time\(/);
  const assets=[...portal.matchAll(/(?:src|href)="([^"?]+)\?v=<\?= portalAssetVersion\('([^']+)'\) \?>"/g)];
  assert.ok(assets.length>100);
  for(const [,url,file] of assets)assert.equal(file,url);
});
