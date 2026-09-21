import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync(new URL('../lib/market-data.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { parseMarket } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
test('reads Yahoo popularity and odds with whitespace', () => {
  for (const value of ['1(3.8)', '1( 3.8 )', ' 1 (\n3.8\t) ', '1(\u00a03.8\u00a0)']) {
    assert.deepEqual(parseMarket(value), { popularity: 1, odds: 3.8 });
  }
});
test('missing or invalid market values never become numeric placeholders', () => {
  for (const value of ['', '発売前', '取消', '1(--)', '0(3.8)', '99(999)', '1(0.0)']) {
    assert.equal(parseMarket(value), null);
  }
});
