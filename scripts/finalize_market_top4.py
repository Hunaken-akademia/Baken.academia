"""Stage the verified Top4 rollout without changing legacy scores or tail order."""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

CACHE_VERSION = '2026-09-26-market-top4-v1'
RANKING_BLOCK = '''    // MARKET_TOP4_LEGACY_TAIL_V1: splice once from the untouched legacy order.
    const legacyOrder = [...raw];
    let marketTop4Applied = false;
    if (marketDifferenceOrder && marketDifferenceOrder.length === legacyOrder.length) {
      const byHorseNumber = new Map(legacyOrder.map((horse) => [horse.number, horse]));
      const completeOrder = new Set(marketDifferenceOrder).size === legacyOrder.length
        && marketDifferenceOrder.every((number) => byHorseNumber.has(number));
      const topFour = completeOrder ? marketDifferenceOrder.slice(0, 4).flatMap((number) => {
        const horse = byHorseNumber.get(number);
        return horse ? [horse] : [];
      }) : [];
      if (topFour.length === 4) {
        const selected = new Set(topFour.map((horse) => horse.number));
        raw.splice(0, raw.length, ...topFour,
          ...legacyOrder.filter((horse) => !selected.has(horse.number)));
        marketTop4Applied = true;
        console.info("REIN market-difference Top4 applied", JSON.stringify({
          modelVersion: roleModel.version,
          cacheVersion: ROLE_CACHE_VERSION,
          top4: topFour.map((horse) => horse.number),
          tailCount: raw.length - 4,
        }));
      }
    }
'''


def patch(source: str) -> str:
    if '// MARKET_TOP4_LEGACY_TAIL_V1:' not in source:
        start_marker = '    const legacyOrder = [...raw];\n    const marketDifferenceTop4 = raw\n'
        assert source.count(start_marker) == 1, 'Unexpected ranking implementation; refusing to patch'
        start = source.index(start_marker)
        end = source.index('    raw.forEach((horse, index) => {', start)
        old = source[start:end]
        assert 'if (marketDifferenceOrder?.length === raw.length)' in old
        source = source[:start] + RANKING_BLOCK + source[end:]
    else:
        assert RANKING_BLOCK in source, 'Rollout marker exists with different code'
    source, count = re.subn(r'const ROLE_CACHE_VERSION = "(?:2026-09-23-v1|2026-09-26-market-top4-v1)";',
                           f'const ROLE_CACHE_VERSION = "{CACHE_VERSION}";', source)
    assert count == 1, 'Unexpected cache version; refusing to overwrite newer code'
    marker = '          "x-rein-fallback": roleModel.feature_count ? "0" : "1",'
    if '"x-rein-market-difference"' not in source:
        assert source.count(marker) == 1, 'Unexpected response headers'
        source = source.replace(marker, marker + '\n          "x-rein-market-difference": marketTop4Applied ? "1" : "0",\n          "x-rein-role-cache-version": ROLE_CACHE_VERSION,')
    return source


def regression_tests() -> None:
    code = r'''
const assert = require('node:assert/strict');
const apply = new Function('raw', 'marketDifferenceOrder', 'roleModel', 'ROLE_CACHE_VERSION', 'console',
  BLOCK + '\nreturn {raw, marketTop4Applied};');
let seed = 71931;
function shuffle(a) {
  a = [...a];
  for (let i = a.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const silent = { info() {} };
let checks = 0;
for (let size = 4; size <= 18; size++) {
  for (let repeat = 0; repeat < 100; repeat++) {
    const ids = Array.from({length: size}, (_, i) => i + 1);
    const legacy = shuffle(ids).map(number => ({number, reinScore: 80, popularity: number}));
    const frozen = JSON.stringify(legacy);
    const market = shuffle(ids);
    const selected = new Set(market.slice(0, 4));
    const expected = [...market.slice(0, 4), ...legacy.map(h => h.number).filter(n => !selected.has(n))];
    const result = apply([...legacy], market, {version:'fixture'}, 'fixture', silent);
    assert.equal(result.marketTop4Applied, true);
    assert.deepEqual(result.raw.map(h => h.number), expected);
    assert.equal(new Set(result.raw.map(h => h.number)).size, size);
    assert.equal(JSON.stringify(legacy), frozen);
    checks++;
  }
  const legacy = Array.from({length:size}, (_, i) => ({number:i+1}));
  for (const invalid of [null, [], [1,2,3], Array(size).fill(1), Array.from({length:size}, (_, i) => i+2)]) {
    const result = apply([...legacy], invalid, {version:'fixture'}, 'fixture', silent);
    assert.equal(result.marketTop4Applied, false);
    assert.deepEqual(result.raw, legacy);
    checks++;
  }
}
console.log(`Top4/tail regression checks passed: ${checks}`);
'''.replace('BLOCK', json.dumps(RANKING_BLOCK))
    subprocess.run(['node', '-e', code], check=True)


def main() -> None:
    from stage_market_precision import stage_precision
    stage_precision()
    path = Path('rein-web/app/api/analyze/route.ts')
    original = path.read_text()
    updated = patch(original)
    assert patch(updated) == updated, 'Patch is not idempotent'
    regression_tests()
    path.write_text(updated)
    print('Staged single-pass market Top4 + exact legacy tail and fresh role cache')


if __name__ == '__main__':
    main()
