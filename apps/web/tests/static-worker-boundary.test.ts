import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker from '../../../scripts/public-audio-worker.mjs';

test('both static Worker purposes reject generation paths for every HTTP method without invoking bindings', async()=>{
  let called=0;
  const env={ASSETS:{fetch:async()=>{called++;return new Response('static asset')}}};
  for(const method of ['GET','HEAD','POST','PUT','OPTIONS']) for(const path of ['/generate','/generate/','/_serverFn/startGeneration','/api/local-generation','/api/local-audio/test.wav']) {
    const response=await worker.fetch(new Request(`https://personal.example${path}`,{method}),env);
    assert.equal(response.status,404);
  }
  assert.equal(called,0);
  assert.equal((await worker.fetch(new Request('https://personal.example/'),env)).status,200);
  assert.equal(called,1);
});

test('public examples send generation paths to the rejecting Worker and contain only static bindings', async () => {
  for (const name of ['cloudflare.example', 'personal.example', 'public-preview.example']) {
    const text = await readFile(new URL(`../../../deployment/${name}.wrangler.jsonc`, import.meta.url), 'utf8');
    const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
    assert.equal(config.main, '../scripts/public-audio-worker.mjs');
    assert.equal(config.assets.binding, 'ASSETS');
    assert.equal(config.assets.not_found_handling, 'none');
    for (const path of ['/_serverFn/*', '/api/local-*', '/generate', '/generate/*']) {
      assert.ok(config.assets.run_worker_first.includes(path), `${name}: ${path} must reach the rejecting handler`);
    }
    for (const field of ['ai', 'vars', 'account_id', 'r2_buckets', 'd1_databases']) assert.equal(config[field], undefined);
  }
});
