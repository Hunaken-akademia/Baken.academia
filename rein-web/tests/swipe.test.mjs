import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

test('touch navigation: left advances, right returns, with boundaries, vertical, edge, and normal tab clicks', async () => {
  const dom = new JSDOM('<div id="app"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'CustomEvent', 'Event']) {
    Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
  }
  globalThis.getComputedStyle = dom.window.getComputedStyle;
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const require = createRequire(import.meta.url);
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const module = { exports: {} };
  const source = readFileSync(new URL('../components/ui/tabs.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  new Function('require', 'module', 'exports', compiled)(name => name === '@/lib/utils' ? { cn: (...values) => require('tailwind-merge').twMerge(require('clsx').clsx(values)) } : require(name), module, module.exports);
  const { Tabs, TabsList, TabsTrigger, TabsContent } = module.exports;
  const h = React.createElement;
  const root = createRoot(document.getElementById('app'));
  let backCount = 0;
  await React.act(async () => root.render(h(Tabs, { defaultValue: 'a', onSwipeBack: () => backCount++ },
    h(TabsList, null, ...['a', 'b', 'c'].map(value => h(TabsTrigger, { key: value, value }, value))),
    ...['a', 'b', 'c'].map(value => h(TabsContent, { key: value, value }, value)))));
  const selected = () => document.querySelector('[role="tab"][aria-selected="true"]').textContent;
  const swipe = async (x1, y1, x2, y2) => {
    await React.act(async () => {
      const target = document.querySelector('[data-slot="tabs"]');
      for (const [type, x, y] of [['touchstart', x1, y1], ['touchmove', x2, y2], ['touchend', x2, y2]]) {
        const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, { touches: { value: type === 'touchend' ? [] : [{ clientX: x, clientY: y }] }, changedTouches: { value: [{ clientX: x, clientY: y }] } });
        target.dispatchEvent(event);
      }
    });
  };
  assert.equal(selected(), 'a');
  await swipe(250, 100, 100, 100); assert.equal(selected(), 'b'); assert.equal(backCount, 0);
  await swipe(250, 100, 100, 100); assert.equal(selected(), 'c');
  await swipe(250, 100, 100, 100); assert.equal(selected(), 'c');
  await swipe(100, 100, 250, 100); assert.equal(selected(), 'b');
  await swipe(250, 100, 230, 250); assert.equal(selected(), 'b');
  await swipe(10, 100, 250, 100); assert.equal(selected(), 'b');
  await swipe(250, 100, 220, 100); assert.equal(selected(), 'b');
  await React.act(async () => document.querySelector('[data-tab-value="a"]').dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 })));
  assert.equal(selected(), 'a');
  await swipe(100, 100, 250, 100); assert.equal(backCount, 1); assert.equal(selected(), 'a');
  await React.act(async () => root.unmount());
  dom.window.close();
});
