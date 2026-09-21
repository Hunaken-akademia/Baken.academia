import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../lib/payouts.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { parsePayouts } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);

test('parses every standard Yahoo payout row including multiple place and wide returns', () => {
  const html = `<table>
    <tr><th>単勝</th><td>4</td><td>280円</td><td>1番人気</td></tr>
    <tr><th>複勝</th><td>4<br>11<br>1</td><td>110円<br>150円<br>280円</td><td>1番人気<br>3番人気<br>6番人気</td></tr>
    <tr><th>枠連</th><td>4－8</td><td>390円</td><td>1番人気</td></tr>
    <tr><th>馬連</th><td>4-11</td><td>610円</td><td>2番人気</td></tr>
    <tr><th>ワイド</th><td>4-11<br>1-4<br>1-11</td><td>330円<br>590円<br>1,140円</td><td>2番人気<br>7番人気<br>16番人気</td></tr>
    <tr><th>馬単</th><td>4→11</td><td>1,200円</td><td>3番人気</td></tr>
    <tr><th>3連複</th><td>1-4-11</td><td>2,340円</td><td>7番人気</td></tr>
    <tr><th>3連単</th><td>4→11→1</td><td>6,880円</td><td>13番人気</td></tr>
  </table>`;
  const rows = parsePayouts(html);
  assert.equal(rows.length, 12);
  assert.deepEqual(rows.find((row) => row.type === '馬単'), {
    type: '馬単', selection: '4→11', payout: 1200, popularity: 3,
  });
  assert.deepEqual(rows.find((row) => row.type === '3連単'), {
    type: '3連単', selection: '4→11→1', payout: 6880, popularity: 13,
  });
});

test('ignores result-table rows and incomplete payout rows', () => {
  const html = `<table><tr><td>1</td><td>4</td><td>競走馬</td><td>1:34.5</td></tr>
    <tr><th>単勝</th><td>発売なし</td><td>---</td></tr></table>`;
  assert.deepEqual(parsePayouts(html), []);
});

test('keeps rowspan continuation rows and numeric popularity from live Yahoo tables', () => {
  const html = `<table><tbody>
    <tr><th rowspan="3">複勝</th><td>15</td><td>170円</td><td>1</td></tr>
    <tr><td>9</td><td>710円</td><td>9</td></tr>
    <tr><td>12</td><td>300円</td><td>5</td></tr>
    <tr><th rowspan="3">ワイド</th><td>12-15</td><td>680円</td><td>7</td></tr>
    <tr><td>9-15</td><td>1,660円</td><td>13</td></tr>
    <tr><td>9-12</td><td>2,580円</td><td>30</td></tr>
  </tbody></table>`;
  assert.deepEqual(parsePayouts(html), [
    { type: '複勝', selection: '15', payout: 170, popularity: 1 },
    { type: '複勝', selection: '9', payout: 710, popularity: 9 },
    { type: '複勝', selection: '12', payout: 300, popularity: 5 },
    { type: 'ワイド', selection: '12-15', payout: 680, popularity: 7 },
    { type: 'ワイド', selection: '9-15', payout: 1660, popularity: 13 },
    { type: 'ワイド', selection: '9-12', payout: 2580, popularity: 30 },
  ]);
});
