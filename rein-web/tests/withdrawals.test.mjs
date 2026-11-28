import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const code = ts.transpileModule(readFileSync(new URL('../lib/race-card.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { withdrawnResultNumbers, isScratched, marketWithdrawnNumbers } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
test('result-only withdrawals exclude runners without dropping actual DNF starters', () => {
  const rows = ['取消', '競走除外', '競走中止', '失格', '1'].map((status, index) => ({ html: '', cells: [status, '3', String(index + 6)] }));
  assert.deepEqual([...withdrawnResultNumbers(rows)], [6, 7]);
  assert.equal(isScratched({html:'',cells:['3','6','Horse 牝2','','','','-(-)','16(****)']}), false);
  assert.equal(isScratched({html:'',cells:['3','6','Horse 牝2','','','','競走中止']}), false);
});

const card = (number, market) => ({ html: '', cells: [String(Math.ceil(number / 2)), String(number), `Horse${number} 牡2`, '', '', '', '480(+2)', market] });
test('race-day withdrawal shown only as hidden odds is removed once the market is open', () => {
  // 京都11R (2026-11-28): 9番 stayed on the card as "11(****)" with no win odds.
  const rows = Array.from({ length: 11 }, (_, i) => card(i + 1, i + 1 === 9 ? '11(****)' : `${i + 1}(${(i + 2).toFixed(1)})`));
  const odds = new Map(rows.filter(r => r.cells[1] !== '9').map(r => [+r.cells[1], 3.0]));
  assert.deepEqual([...marketWithdrawnNumbers(rows, odds)], [9]);
  // The odds table's own 取消 mark is enough even if the card cell is blank.
  const plain = rows.map(r => r.cells[1] === '9' ? card(9, '') : r);
  assert.deepEqual([...marketWithdrawnNumbers(plain, odds, [{ html: '', cells: ['5', '9', 'Horse9', '取消'] }])], [9]);
});
test('hidden odds never drop runners before sales or when the odds table is partly read', () => {
  const rows = Array.from({ length: 6 }, (_, i) => card(i + 1, `${i + 1}(****)`));
  assert.deepEqual([...marketWithdrawnNumbers(rows, new Map())], []);
  const partial = Array.from({ length: 6 }, (_, i) => card(i + 1, i === 0 ? '6(****)' : `${i}(3.0)`));
  assert.deepEqual([...marketWithdrawnNumbers(partial, new Map([[2, 3], [3, 4]]))], []);
  assert.deepEqual([...marketWithdrawnNumbers(partial, new Map([[2, 3], [3, 4], [4, 5], [5, 6], [6, 7]]))], [1]);
});
