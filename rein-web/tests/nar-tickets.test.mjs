import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
function moduleUrl(path, replacements = []) {
  let source = readFileSync(new URL(path, import.meta.url), "utf8");
  for (const [pattern, replacement] of replacements) source = source.replace(pattern, replacement);
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
  return "data:text/javascript;base64," + Buffer.from(code).toString("base64");
}
const ticketUrl = moduleUrl("../lib/tickets.ts");
const { buildTickets } = await import(ticketUrl);
const { withNarTickets } = await import(moduleUrl("../lib/nar-tickets.ts", [[/from "\.\/tickets"/, "from " + JSON.stringify(ticketUrl)]]));
const horses = Array.from({ length: 6 }, (_, i) => ({
  number: i + 1, gate: i + 1, popularity: i + 1, odds: 2 + i,
  score: 80 - i, firstProbability: (6 - i) / 21,
  secondProbability: (i + 1) / 21, thirdProbability: 1 / 6,
}));
const snapshot = () => ({ horses: structuredClone(horses), evaluation: { roleModel: "ready", tickets: "held" }, tickets: [], prediction: { source: "prestart", generatedAt: "2026-10-01T00:00:00Z" }, review: { isFinished: true } });
test("NAR uses current seven types with identical selections and no trifecta", () => {
  const source = snapshot(), before = structuredClone(source);
  const result = withNarTickets(source);
  assert.equal(result.evaluation.tickets, "ready");
  assert.deepEqual(result.tickets, buildTickets(horses.map(h => ({ ...h, reinScore: h.score, marketScore: 0 }))));
  assert.deepEqual(result.tickets.map(t => t.type), ["単勝", "複勝", "枠連", "馬連", "ワイド", "馬単", "三連複"]);
  assert.deepEqual(source, before);
  assert.deepEqual(result.prediction, source.prediction);
});
test("Missing model, role shares or complete market keeps tickets held", () => {
  for (const change of [
    s => s.evaluation.roleModel = "unavailable",
    s => s.horses[0].odds = null,
    s => s.horses[0].firstProbability = NaN,
    s => s.horses[0].popularity = 0,
    s => s.horses[0].popularity = 2,
  ]) {
    const source = snapshot(); change(source);
    const result = withNarTickets(source);
    assert.equal(result.evaluation.tickets, "held"); assert.deepEqual(result.tickets, []);
  }
});
