const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const web = path.resolve(__dirname, '..'), output = process.env.REIN_RESEARCH_QA_DIR;
if (!output) throw new Error('Set REIN_RESEARCH_QA_DIR to an output directory');
const esbuild = require('esbuild');
const { chromium } = require(require.resolve('playwright', { paths: [process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES] }));
const factors = [
  { label: '通算成績', samples: 20, wins: 2, top3: 8, winRate: 10, top3Rate: 40, averageFinish: 4.2, impact: 0 },
  { label: '近5走', samples: 5, wins: 1, top3: 3, winRate: 20, top3Rate: 60, averageFinish: 3.5, impact: 2 },
  { label: '距離適性', samples: 6, wins: 1, top3: 3, winRate: 16.7, top3Rate: 50, averageFinish: 4, impact: 1 },
  { label: '騎手傾向', samples: 100, winRate: 12.5, top3Rate: 35, impact: 1 },
];
const horses = Array.from({ length: 8 }, (_, i) => ({ number: i + 1, gate: i + 1, name: `比較テストホース${i + 1}`, score: 95 - i * 2, odds: i === 7 ? null : 2 + i, popularity: i === 7 ? 0 : i + 1, mark: i === 0 ? '◎' : '', style: i < 2 ? '先行' : '差し', verdict: '参考', positives: ['距離の実績'], cautions: ['集計母数に注意'], firstProbability: .2 - i * .01, secondProbability: .1 + i * .01, thirdProbability: .15 - i * .008, firstSuitability: 100 - i * 4, secondSuitability: 65 + i * 4, thirdSuitability: 90 - i * 3, jockey: `テスト騎手${i + 1}`, trainer: 'テスト厩舎', weight: i === 7 ? undefined : 480 + i, weightChange: i === 1 ? 0 : 2, weightCarried: 56, historySamples: 20, historyFactors: factors, parameterFactors: [], recentPositions: [i < 2 ? `${i + 1}-${i + 1}-2-2` : '4-4-3-2'], mapPositions: [i < 2 ? `${i + 1}-${i + 1}-2-2` : '4-4-3-2'] }));
function analysis(area, held = false, id = 'qa-research') {
  return { race: { league: area, title: '東京 11R 比較検証レース', course: '芝1600m', condition: '良', start: '15:40', updated: '表示検証', raceId: id }, evaluation: { roleModel: held ? 'unavailable' : 'ready', overall: held ? 'held' : 'ready', tickets: 'held', held: [] }, model: { version: 'qa', dateFrom: '2019-01-01', dateTo: '2026-10-08', races: 100, runners: 1000, horses: 100, strategy: '表示検証', ...(area === 'nar' ? { probabilityKind: 'ranking-share' } : {}) }, pace: { label: '平均', detail: '表示検証', leaders: [1, 2] }, horses: horses.map(h => ({ ...h, ...(area === 'nar' ? { probabilityKind: 'ranking-share' } : {}) })), tickets: [] };
}
function contextData(id, empty = false) {
  const group = (label, runners, wins, top3) => ({ label, runners, wins, top3, winRate: runners ? wins / runners * 100 : null, top3Rate: runners ? top3 / runners * 100 : null });
  return { raceId: id, date: '2026-10-10', generatedAt: '2026-10-10T05:00:00Z', previousFetchedAt: '2026-10-10T05:00:00Z', previousError: null,
    previousRuns: Object.fromEntries(horses.map(h => [h.number, empty || h.number === 8 ? null : { date: '2026-09-27', venue: '阪神', surface: '芝', distanceM: 1800, going: '良', jockey: '前走テスト騎手', weightCarried: 55, bodyWeight: 470, finish: 2, fieldSize: 12 }])),
    trends: { supported: true, surface: '芝', cutoff: '2026-10-10T05:00:00Z', priorCount: 10, raceCount: empty ? 0 : 2, runnerCount: empty ? 0 : 8, unknownGate: 0, unknownStyle: 1, excluded: { missing: 3, pending: 1, afterCutoff: 1, otherSurface: 3, invalid: 0 }, gates: [group('内枠（1〜3枠）', 2, 0, 1), group('中枠（4〜6枠）', 2, 1, 2), group('外枠（7〜8枠）', 4, 1, 3)], styles: [group('逃げ・先行・好位', 4, 1, 3), group('差し・追込', 3, 1, 2)], races: empty ? [] : [1, 2].map(n => ({ raceId: `qa-${n}`, title: `東京${n}R 検証結果`, course: '芝1800m', condition: '良', capturedAt: '2026-10-10T02:15:00Z', runners: 4 })) } };
}
(async () => {
  fs.mkdirSync(output, { recursive: true });
  await esbuild.build({ entryPoints: [path.join(__dirname, 'horse-research-fixture.tsx')], bundle: true, outfile: path.join(output, 'dashboard.js'), platform: 'browser', jsx: 'automatic', alias: { '@': web }, define: { 'process.env.NODE_ENV': '"production"' } });
  const css = fs.readdirSync(path.join(web, '.next/static/chunks')).filter(n => n.endsWith('.css')).map(n => fs.readFileSync(path.join(web, '.next/static/chunks', n), 'utf8')).join('\n');
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const send = (v, t = 'application/json') => { res.setHeader('content-type', t + '; charset=utf-8'); res.end(t === 'application/json' ? JSON.stringify(v) : v); };
    const area = req.url.startsWith('/api/nar/') ? 'nar' : 'jra';
    if (req.url.includes('/analyze/context?')) return send(contextData(req.url.includes('qa-next') ? 'qa-next' : 'qa-research', req.headers.referer?.includes('empty=1')));
    if (/\/races\?/.test(req.url)) return send({ dateLabel: '表示検証', updatedAt: new Date().toISOString(), venues: [{ name: '東京', eventId: 'qa', nextRace: 11, nextStart: '15:40', races: [11, 12].map((number, i) => ({ number, start: '15:40', raceId: i ? 'qa-next' : 'qa-research', title: i ? '次の検証レース' : '比較検証レース', course: '芝1600m', status: '次レース' })) }] });
    if (/\/analyze\?/.test(req.url)) return send(analysis(area, req.headers.referer?.includes('held=1'), req.url.includes('qa-next') ? 'qa-next' : 'qa-research'));
    if (req.url.includes('/race-history')) return send({ scope: 'server', entries: [], races: 0, summary: [] });
    if (req.url.includes('/account-data')) return send({ userId: 'qa', notes: {} });
    if (req.url === '/qa-fonts.css' && process.env.REIN_QA_FONTS) return send(['400.css', '700.css'].map(file => fs.readFileSync(path.join(process.env.REIN_QA_FONTS, file), 'utf8')).join('\n').replaceAll('./files/', '/qa-fonts/'), 'text/css');
    if (/^\/qa-fonts\/[a-zA-Z0-9_.-]+$/.test(req.url) && process.env.REIN_QA_FONTS) return send(fs.readFileSync(path.join(process.env.REIN_QA_FONTS, 'files', req.url.slice('/qa-fonts/'.length))), 'font/woff2');
    if (req.url === '/dashboard.js') return send(fs.readFileSync(path.join(output, 'dashboard.js')), 'application/javascript');
    if (req.url === '/styles.css') return send(css, 'text/css');
    return send('<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/qa-fonts.css"><style>body{margin:0;background:#07111f;color:white;font-family:"Noto Sans JP",sans-serif}</style></head><body><div id="root"></div><script src="/dashboard.js"></script></body></html>', 'text/html');
  });
  await new Promise(resolve => server.listen(8152, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.REIN_QA_CHROMIUM ? { executablePath: process.env.REIN_QA_CHROMIUM } : {}), args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-zygote"] });
  try {
    const errors = [];
    for (const area of ['jra', 'nar']) {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(String(error)));
      await page.goto(`http://127.0.0.1:8152/?area=${area}`);
      await page.getByRole('button', { name: /東京/ }).first().click();
      await page.getByRole('button', { name: /比較検証レース/ }).click();
      assert.equal(requests.filter(url => url.startsWith(area === 'nar' ? '/api/nar/analyze/context?' : '/api/analyze/context?')).length, 0, 'context is fetched lazily');
      await page.getByRole('tab', { name: '比較', exact: true }).click();
      const panel = page.getByRole('region', { name: '気になる馬を比較', exact: true });
      await panel.getByRole('heading', { name: '気になる馬を最大4頭で比較' }).waitFor();
      const count = requests.filter(url => url.includes('/analyze?')).length;
      for (const n of [1, 2, 3, 4]) await panel.getByRole('button', { name: `${n} 比較テストホース${n}を比較に追加`, exact: true }).click();
      assert.equal(await panel.getByRole('button', { name: '5 比較テストホース5を比較に追加', exact: true }).isDisabled(), true);
      await panel.getByRole('button', { name: '選択をクリア', exact: true }).click();
      for (const n of [2, 5]) await panel.getByRole('button', { name: `${n} 比較テストホース${n}を比較に追加`, exact: true }).click();
      await panel.getByRole('button', { name: '比較表を見る', exact: true }).click();
      const table = page.getByRole('region', { name: '選択馬の比較表・横スクロール', exact: true });
      assert.match(await table.innerText(), /481kg（0）/);
      assert.match(await table.innerText(), /50.0% \/ 6走（少数）/);
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: path.join(output, `${area}-comparison-table.png`) });
      await page.setViewportSize({ width: 320, height: 844 });
      const box = await table.boundingBox(), cdp = await page.context().newCDPSession(page);
      const x = box.x + box.width - 30, y = Math.max(120, box.y + 80);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let i = 1; i <= 5; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - i * 30, y }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      assert.ok(await table.evaluate(el => el.scrollLeft) > 0);
      assert.equal(await page.getByRole('tab', { name: '比較', exact: true }).getAttribute('aria-selected'), 'true');
      await cdp.detach();
      await panel.getByRole('button', { name: '人気薄×上位5頭', exact: true }).click();
      assert.equal(await panel.locator('article').count(), 2);
      await panel.getByRole('button', { name: '2着適性', exact: true }).click();
      assert.equal(await panel.locator('article').count(), 4);
      await panel.getByRole('button', { name: '全頭', exact: true }).click();
      await panel.getByLabel('比較する馬を検索').fill('５');
      assert.equal(await panel.locator('article').count(), 1);
      await panel.getByLabel('比較する馬を検索').fill('');
      await panel.getByLabel('馬比較の並び順').selectOption('second');
      assert.match(await panel.locator('article').first().innerText(), /比較テストホース8/);
      await panel.getByRole('button', { name: '2 比較テストホース2の詳細を見る', exact: true }).click();
      assert.equal(await page.getByRole('tab', { name: '馬の詳細', exact: true }).getAttribute('aria-selected'), 'true');
      const previous = page.getByRole('region', { name: '前走との条件比較', exact: true });
      await previous.getByText('-200m 短縮', { exact: true }).waitFor();
      assert.match(await previous.innerText(), /掲載前走から13日/);
      assert.match(await previous.innerText(), /\+1kg/);
      assert.match(await previous.innerText(), /乗り替わり/);
      await previous.evaluate(el => window.scrollBy(0, el.getBoundingClientRect().top - 112));
      await page.screenshot({ path: path.join(output, `${area}-previous-run.png`) });
      const conditions = page.getByRole('region', { name: '馬の条件別成績' });
      await conditions.getByText('3着内率：通算比 +10.0pt', { exact: true }).waitFor();
      for (const width of [320, 390, 768, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `${area} detail ${width}`);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await conditions.evaluate(el => window.scrollBy(0, el.getBoundingClientRect().top - 112));
      await page.screenshot({ path: path.join(output, `${area}-condition-detail.png`) });
      await page.getByRole('tab', { name: '比較', exact: true }).click();
      assert.match(await panel.getByRole('status').innerText(), /比較 2 \/ 4頭/);
      await panel.getByRole('button', { name: '選択中 2頭', exact: true }).click();
      for (const width of [320, 390, 768, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `${area} comparison ${width}`);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await panel.evaluate(el => window.scrollBy(0, el.getBoundingClientRect().top - 112));
      await page.screenshot({ path: path.join(output, `${area}-comparison-mobile.png`) });
      assert.equal(requests.filter(url => url.includes('/analyze?')).length, count, 'comparison does not add analysis requests');
      await page.getByRole('tab', { name: '展開', exact: true }).click();
      const trends = page.getByRole('region', { name: '当日の結果傾向', exact: true });
      await trends.getByText('2レース', { exact: true }).waitFor();
      assert.match(await trends.innerText(), /0\.0%/);
      assert.match(await trends.innerText(), /当日の実際の通過順ではありません/);
      await trends.evaluate(el => window.scrollBy(0, el.getBoundingClientRect().top - 112));
      await page.screenshot({ path: path.join(output, `${area}-day-trends.png`) });
      const pace = page.getByRole('region', { name: '展開6パターンの順位比較', exact: true });
      assert.equal(await pace.locator('tbody tr').count(), 8);
      assert.equal(await pace.locator('thead th').count(), 7);
      assert.equal(await pace.locator('tbody').getByText('保留', { exact: true }).count(), 0, 'all six valid scenarios have ranks');
      await pace.getByRole('button', { name: '変化が大きい順', exact: true }).click();
      await pace.getByRole('button', { name: '逃げ争い激化で確認', exact: true }).click();
      assert.equal(await page.locator('[data-scenario="duel"]').getAttribute('aria-pressed'), 'true');
      await pace.getByRole('button', { name: '単騎逃げ・ゆったりで確認', exact: true }).click();
      assert.equal(await page.locator('[data-scenario="lone"]').getAttribute('aria-pressed'), 'true');
      for (const width of [320, 390, 768, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `${area} context ${width}`);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await pace.evaluate(el => window.scrollBy(0, el.getBoundingClientRect().top - 112));
      await page.screenshot({ path: path.join(output, `${area}-six-scenarios.png`) });
      const rankScroll = page.getByRole('region', { name: '展開順位の比較表・横スクロール', exact: true });
      await rankScroll.evaluate(el => el.scrollLeft = 300);
      assert.ok(await rankScroll.evaluate(el => el.scrollLeft) > 0);
      assert.equal(await page.getByRole('tab', { name: '展開', exact: true }).getAttribute('aria-selected'), 'true');
      assert.equal(requests.filter(url => url.startsWith(area === 'nar' ? '/api/nar/analyze/context?' : '/api/analyze/context?')).length, 1, 'details and trends share one context request');
      await page.getByRole('tab', { name: '予想', exact: true }).click();
      await page.getByText('レース全体の分析・データ状況を見る', { exact: true }).click();
      await page.getByText('人気とREINの評価差を見る', { exact: true }).click();
      await page.getByRole('button', { name: '次のレース・12R', exact: true }).click();
      await page.getByRole('tab', { name: '比較', exact: true }).click();
      assert.match(await panel.getByRole('status').innerText(), /比較 0 \/ 4頭/);
      await page.close();
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ leagues: ['jra', 'nar'], widths: [320, 390, 768, 1280], selectionLimit: 4, touchScroll: true, previousRun: true, sixScenarios: true, dayTrends: true, contextRequestsPerRace: 1, additionalAnalysisRequests: 0, errors }));
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exit(1); });
