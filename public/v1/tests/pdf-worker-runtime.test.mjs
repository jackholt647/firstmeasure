import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../firstmeasure/api.ts',import.meta.url),'utf8');
const expression=source.match(/const assetBaseUrl = (String\(process\.env\.FIRSTMEASURE_PDF_RUNTIME_BASE_URL[^;]+);/)[1];
test('dedicated worker uses configured runtime instead of producer loopback',()=>{
  for(const [configured,payload,expected] of [
    ['https://dev.1m8.ai/v1/firstmeasure/pdf-runtime','http://127.0.0.1:3201/v1/firstmeasure/pdf-runtime','https://dev.1m8.ai/v1/firstmeasure/pdf-runtime'],
    [undefined,'http://localhost:3111/v1/firstmeasure/pdf-runtime','http://localhost:3111/v1/firstmeasure/pdf-runtime'],
    [undefined,undefined,''],
  ]) assert.equal(vm.runInNewContext(expression,{process:{env:{FIRSTMEASURE_PDF_RUNTIME_BASE_URL:configured}},payload:{asset_base_url:payload}}),expected);
});
