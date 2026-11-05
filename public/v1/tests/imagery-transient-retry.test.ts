// FM-338: under a burst of orders the worker's database pool ran short ("timeout exceeded when trying to
// connect") and map downloads failed; the imagery job treated both as permanent and the orders reached the
// drafting queue with no map ("no renderable map assets"). They must be retried by the durable job instead.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { fetchSolarWithRetry, isTransientHttpStatus, isTransientProviderFailure } from '../firstmeasure/transient_failure.js';
import { fetchRequiredSolarLayers, fetchRequiredSolarDsm } from '../firstmeasure/solar_imagery.js';
import { FirstMeasureError, badRequest } from '../firstmeasure/errors.js';

const compile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test('database pool, connection and transport failures are transient; real failures are not', () => {
  const transient = [
    new Error('timeout exceeded when trying to connect'),
    new Error('Connection terminated unexpectedly'),
    Object.assign(new Error('sorry, too many clients already'), { code: '53300' }),
    Object.assign(new Error('connection failure'), { code: '08006' }),
    Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }),
    Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }),
    Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError', code: 23 }),
    new FirstMeasureError('imagery_provider_busy', 503),
    Object.assign(new Error('Service Unavailable'), { $metadata: { httpStatusCode: 503 } })
  ];
  for (const error of transient) assert.equal(isTransientProviderFailure(error), true, String(error.message));
  const permanent = [
    badRequest('solar_imagery_no_coverage', 'no coverage'),
    badRequest('solar_layers_fetch_failed', 'HTTP 403'),
    new Error('boom'),
    new TypeError('Cannot read properties of undefined'),
    Object.assign(new Error('duplicate key'), { code: '23505' }),
    null
  ];
  for (const error of permanent) assert.equal(isTransientProviderFailure(error), false, String(error?.message));
});

test('order imagery job retries a database pool timeout instead of finishing without a map', async () => {
  const source = await readFile(new URL('../firstmeasure/api.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  registerFirstMeasureJobHandler("imagery.process",');
  const code = compile(source.slice(start, source.indexOf('  registerFirstMeasureJobHandler("pdf.sync",', start)));
  let handler: any, failure: unknown = null;
  const warnings: string[] = [];
  const context = vm.createContext({
    registerFirstMeasureJobHandler: (_type: string, fn: any) => { handler = fn; }, asRecord: (x: any) => x || {},
    readManifest: async () => ({ status: 'queued' }), patchManifest: async () => { throw new Error('unexpected patch'); },
    imageryFailurePatch: () => ({}), isTransientProviderFailure, runBackgroundImageryProcess: async () => {},
    processProjectImagery: async () => { if (failure) throw failure; },
    console: { warn: (line: string) => warnings.push(line) }
  });
  vm.runInContext(code, context);
  failure = new Error('timeout exceeded when trying to connect');
  await assert.rejects(handler({ payload: { project_id: 'a', input: {} } }), /timeout exceeded/);
  const logged = JSON.parse(warnings.at(-1)!);
  assert.equal(logged.transient, true);
  assert.equal(logged.message, 'timeout exceeded when trying to connect');
  failure = Object.assign(new Error('https://x/?key=SECRET&b=1 failed'), { code: 'solar_layers_fetch_failed' });
  assert.equal((await handler({ payload: { project_id: 'a', input: {} } })).needs_attention, true);
  assert.ok(!warnings.at(-1)!.includes('SECRET'));
});

test('imagery fails retryably when every map download was only busy, and completes once one arrives', async () => {
  const source = await readFile(new URL('../firstmeasure/processing.ts', import.meta.url), 'utf8');
  const helpers = source.slice(source.indexOf('type ProviderFetchOutcome'), source.indexOf('async function geocodeProjectAddress('));
  const body = source.slice(source.indexOf('export async function processProjectImagery('), source.indexOf('export async function processProjectMask(')).replace('export ', '');
  const original = globalThis.fetch;
  const tiff = new Uint8Array([73, 73, 42, 0, 8, 0, 0, 0]);
  try {
    for (const staticMapStatus of [503, 200]) {
      const saved: string[] = [], patches: any[] = [];
      const calls = new Map<string, number>();
      globalThis.fetch = (async (input: any) => {
        const url = String(input);
        const kind = url.includes('dataLayers') ? 'layers' : url.includes('/dsm') ? 'dsm' : url.includes('/rgb') ? 'rgb' : url.includes('/mask') ? 'mask' : url.includes('staticmap') ? 'static' : 'other';
        calls.set(kind, (calls.get(kind) ?? 0) + 1);
        if (kind === 'layers') return new Response(JSON.stringify({ dsmUrl: 'https://solar.example/dsm?id=1', rgbUrl: 'https://solar.example/rgb?id=1', maskUrl: 'https://solar.example/mask?id=1' }));
        if (kind === 'dsm' || kind === 'mask') return new Response(tiff);
        if (kind === 'rgb') return new Response('', { status: 503 });
        if (kind === 'static') return staticMapStatus === 200 ? new Response(new Uint8Array([137, 80, 78, 71])) : new Response('', { status: staticMapStatus });
        return new Response('', { status: 404 });
      }) as typeof fetch;
      const manifest = { instant_enabled: false, pins: [{ lat: 39.1, lng: -86.9 }] };
      const context = vm.createContext({
        fetchRequiredSolarLayers, fetchRequiredSolarDsm, isTransientHttpStatus, FirstMeasureError,
        fetchSolarWithRetry: (url: any, init: any) => fetchSolarWithRetry(url, init, async () => {}),
        normalizeSolarGeoTiffUrl: (url: string) => url, requireGoogleKey: () => 'fake', readManifest: async () => manifest,
        resolveProjectLocation: async () => ({ lat: 39.1, lng: -86.9, address: 'fixture' }),
        collectStructureInsights: async () => ({ primaryText: '{}', primaryInsights: {}, artifact: { structures: [] }, segmentCount: 0, hasCoverageAtAnyPin: false }),
        resolveProjectImageryArea: (_m: any, _i: any, l: any) => ({ ...l, radius_meters: 60 }), resolveSolarPixelSizeMeters: () => 0.1,
        saveArtifact: async (_p: string, n: string) => saved.push(n), INSTANT_STRUCTURE_INSIGHTS_FILE_NAME: 'structures.json', computeComplexityRating: () => 1,
        generateStructureSupplementalImagery: async () => {}, env: {}, patchManifest: async (_p: string, p: any) => { patches.push(p); return { ...manifest, ...p }; },
        buildMultiStructurePointPatch: () => ({}), solarImageryQualityPatchFromSolarResponse: () => ({}), buildPartialInstantRefundPatch: () => ({}),
        readBrandingDefaults: async () => null, ensureInstantPdfArtifact: async () => null, readArtifactBytes: async () => new Uint8Array(),
        badRequest, URL, Response, Uint8Array, AbortSignal
      });
      vm.runInContext(compile(helpers + '\n' + body), context);
      const run = vm.runInContext("processProjectImagery('fixture',{})", context);
      await run.catch(() => undefined);
      assert.equal(calls.get('rgb'), 3, 'the RGB download is retried before giving up');
      if (staticMapStatus === 503) {
        await assert.rejects(run, (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'imagery_provider_busy');
          assert.equal(isTransientProviderFailure(error), true);
          return true;
        });
        assert.equal(patches.length, 0, 'the order is never marked ready without a map');
      } else {
        const result = await run;
        assert.equal(result.project.status, 'ready');
        assert.ok(saved.includes('google.png') && !saved.includes('rgb.tif'));
      }
    }
  } finally { globalThis.fetch = original; }
});
