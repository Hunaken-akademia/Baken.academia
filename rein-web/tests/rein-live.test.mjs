import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../lib/rein-live.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { jstMinutes, liveRefreshTargets, mapWithConcurrency } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);

test('selects only unfinished races in the next 60 JST minutes', () => {
  const now = new Date('2026-09-21T01:00:00.000Z'); // 10:00 JST
  const venues = [{ races: [
    { raceId: 'past', start: '09:59', status: '発売前' },
    { raceId: 'now', start: '10:00', status: '次レース' },
    { raceId: 'thirty', start: '10:30', status: '発売前' },
    { raceId: 'thirtyfive', start: '10:35', status: '発売前' },
    { raceId: 'sixty', start: '11:00', status: '発売前' },
    { raceId: 'finished', start: '10:20', status: '確定' },
    { raceId: 'later', start: '11:01', status: '発売前' },
  ] }];
  assert.equal(jstMinutes(now), 600);
  assert.deepEqual(liveRefreshTargets(venues, now).map((race) => race.raceId), ['now', 'thirty', 'thirtyfive', 'sixty']);
});

test('caps refresh work and bounds concurrency', async () => {
  const races = Array.from({ length: 20 }, (_, index) => ({
    raceId: String(index).padStart(2, '0'), start: '10:30', status: '発売前',
  }));
  assert.equal(liveRefreshTargets([{ races }], new Date('2026-09-21T01:00:00.000Z')).length, 12);

  let active = 0;
  let maximum = 0;
  const results = await mapWithConcurrency(races.slice(0, 6), 2, async (race) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return race.raceId;
  });
  assert.equal(maximum, 2);
  assert.deepEqual(results, races.slice(0, 6).map((race) => race.raceId));
});
