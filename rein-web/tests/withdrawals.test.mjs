import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const code = ts.transpileModule(readFileSync(new URL('../lib/race-card.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { withdrawnResultNumbers, isScratched } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
test('result-only withdrawals exclude runners without dropping actual DNF starters', () => {
  const rows = ['取消', '競走除外', '競走中止', '失格', '1'].map((status, index) => ({ html: '', cells: [status, '3', String(index + 6)] }));
  assert.deepEqual([...withdrawnResultNumbers(rows)], [6, 7]);
  assert.equal(isScratched({html:'',cells:['3','6','Horse 牝2','','','','-(-)','16(****)']}), false);
  assert.equal(isScratched({html:'',cells:['3','6','Horse 牝2','','','','競走中止']}), false);
});
