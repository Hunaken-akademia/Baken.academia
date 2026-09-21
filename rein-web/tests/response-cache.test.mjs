import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../lib/response-cache.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { responseCache } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('coalesces concurrent requests and returns independently readable responses', async () => {
  const cached = responseCache(1000);
  let calls = 0;
  const run = async () => { calls++; return Response.json({ calls }); };
  const responses = await Promise.all(Array.from({ length: 20 }, () => cached('a', run)));
  assert.equal(calls, 1);
  for (const response of responses) assert.deepEqual(await response.json(), { calls: 1 });
  await cached('a', run);
  assert.equal(calls, 1);
});

test('expired responses are not reused', async () => {
  const cached = responseCache(0);
  let calls = 0;
  const run = async () => Response.json(++calls);
  await cached('a', run);
  await cached('a', run);
  assert.equal(calls, 2);
});

test('errors and degraded model responses are not cached', async () => {
  for (const init of [{ status: 502 }, { headers: { 'x-rein-fallback': '1' } }]) {
    const cached = responseCache(1000);
    let calls = 0;
    const run = async () => { calls++; return Response.json({}, init); };
    await cached('a', run); await cached('a', run);
    assert.equal(calls, 2);
  }
});

test('rejected work releases its slot', async () => {
  const cached = responseCache(1000);
  await assert.rejects(cached('a', async () => { throw new Error('upstream'); }));
  assert.equal((await cached('a', async () => Response.json({}))).status, 200);
});

test('bounds concurrent distinct requests while allowing coalescing', async () => {
  const cached = responseCache(1000);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const run = async () => { await gate; return Response.json({}); };
  const pending = Array.from({ length: 8 }, (_, i) => cached(String(i), run));
  const duplicate = cached('0', run);
  const limited = await cached('overflow', run);
  assert.equal(limited.status, 503);
  assert.equal(limited.headers.get('retry-after'), '5');
  release();
  await Promise.all([...pending, duplicate]);
});

test('evicts old entries when size bound is reached', async () => {
  const cached = responseCache(1000, 1);
  let calls = 0;
  const run = async () => Response.json(++calls);
  await cached('a', run); await cached('b', run); await cached('a', run);
  assert.equal(calls, 3);
});
