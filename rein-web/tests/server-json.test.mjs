import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync(new URL('../lib/server-json.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { serverJson, snapshotResponse } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
test('platform error and login HTML never reach JSON parsing', async () => {
  await assert.rejects(serverJson(new Response('<!DOCTYPE html>', { status: 503 }), 'Inference'), /Inference 503/);
  await assert.rejects(serverJson(new Response('<!DOCTYPE html>', { headers: { 'content-type': 'text/html' } }), 'Inference'), /non-JSON/);
  assert.deepEqual(await serverJson(Response.json({ runners: [1] }), 'Inference'), { runners: [1] });
});
test('snapshot reads retry transient status and network failure with bounded backoff', async () => {
  let count = 0; const delays = [];
  const response = await snapshotResponse('read', async () => {
    count++;
    if (count === 1) return new Response('unavailable', { status: 503 });
    if (count === 2) throw new TypeError('network');
    return Response.json({ snapshot: null });
  }, async ms => delays.push(ms));
  assert.equal(count, 3); assert.equal(response.status, 200);
  assert.ok(delays[0] >= 250 && delays[0] < 350);
  assert.ok(delays[1] >= 500 && delays[1] < 600);
});
test('persistent read failures stop after three attempts; auth failures and mutations are not retried', async () => {
  for (const [action, status, expected] of [['schedule', 503, 3], ['read', 401, 1], ['save', 503, 1], ['claim', 503, 1]]) {
    let count = 0;
    const result = await snapshotResponse(action, async () => { count++; return new Response('', { status }); }, async () => {});
    assert.equal(count, expected); assert.equal(result.status, status);
  }
  let count = 0;
  await assert.rejects(snapshotResponse('save', async () => { count++; throw new Error('timeout'); }), /timeout/);
  assert.equal(count, 1);
});
