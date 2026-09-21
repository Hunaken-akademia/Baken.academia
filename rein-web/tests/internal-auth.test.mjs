import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../lib/internal-auth.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { hasBearerSecret } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);

test('accepts only the exact non-empty bearer secret', () => {
  assert.equal(hasBearerSecret('Bearer fixed-secret', 'fixed-secret'), true);
  assert.equal(hasBearerSecret('Bearer wrong-secret', 'fixed-secret'), false);
  assert.equal(hasBearerSecret('fixed-secret', 'fixed-secret'), false);
  assert.equal(hasBearerSecret(null, 'fixed-secret'), false);
  assert.equal(hasBearerSecret('Bearer ', ''), false);
});
