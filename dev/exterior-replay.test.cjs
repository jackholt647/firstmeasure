const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const replay = require('./exterior-engine-replay.cjs');
for (const [file,count] of [['exterior-engine-saved.json',88],['exterior-engine-reloaded.json',72]]) {
  test('saved building extrusion replay: '+file,()=>{
    const result=replay(path.join(__dirname,'fixtures',file));
    assert.equal(result.failed,0,JSON.stringify(result.failures,null,2));
    assert.equal(result.previews,count);
  });
}
