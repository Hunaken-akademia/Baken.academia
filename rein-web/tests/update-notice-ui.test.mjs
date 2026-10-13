import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
const require = createRequire(import.meta.url);
const uri = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
test('notice stays open on save failure, disappears after server success, stays hidden on remount and reappears for another account', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://rein.test' });
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // Any attempt to persist the acknowledgement in browser storage fails this test.
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('Browser storage is forbidden'); } });
  let onAuth, owner = 'account-a', fail = false;
  const confirmed = new Set();
  globalThis.__noticeAuth = { auth: { onAuthStateChange: callback => { onAuth = callback; return { data: { subscription: { unsubscribe() {} } } }; } } };
  const id = 'odds-trends-20261013-v1';
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.cache, 'no-store');
    if (options.method === 'POST') { if (fail) return Response.json({}, { status: 500 }); confirmed.add(owner); }
    return Response.json({ userId: owner, noticeId: id, acknowledged: confirmed.has(owner) });
  };
  let code = compile('../components/update-notice.tsx');
  for (const module of ['react', 'react/jsx-runtime']) code = code.replaceAll(JSON.stringify(module), JSON.stringify(pathToFileURL(require.resolve(module)).href));
  code = code.replace(/import \{ createClient \} from "@\/lib\/supabase\/client";/, 'const createClient=()=>globalThis.__noticeAuth;')
    .replace('"@/lib/update-notice"', JSON.stringify(uri(compile('../lib/update-notice.ts'))));
  const { UpdateNotice } = await import(uri(code));
  const container = document.getElementById('root'); let root = createRoot(container);
  await act(async () => { root.render(React.createElement(UpdateNotice)); });
  assert.match(container.textContent, /中央9・地方1/);
  fail = true;
  await act(async () => { container.querySelector('button').click(); });
  assert.match(container.textContent, /確認記録を保存できませんでした/);
  assert.ok(container.querySelector('section'));
  fail = false;
  await act(async () => { container.querySelector('button').click(); });
  assert.equal(container.textContent, '');
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => { root.render(React.createElement(UpdateNotice)); });
  assert.equal(container.textContent, '');
  owner = 'account-b';
  await act(async () => onAuth('SIGNED_IN'));
  assert.match(container.textContent, /確認しました/);
  await act(async () => root.unmount());
  dom.window.close(); delete globalThis.localStorage;
});
