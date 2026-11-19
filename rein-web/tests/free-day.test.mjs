import test from "node:test";
import assert from "node:assert/strict";
import { freeLeagueOf, pickFreeVenue, raceGradeLevel, stripPaidAnalysis, venueGradeScore, venueHasRace } from "../lib/free-day.mjs";

const venue = (eventId, titles) => ({ eventId, name: eventId, races: titles.map((title, index) => ({ raceId: `${eventId}${String(index + 1).padStart(2, "0")}`, title })) });

test("reads JRA and NAR grade marks from race titles", () => {
  assert.equal(raceGradeLevel("ジャパンC(GI)"), 1);
  assert.equal(raceGradeLevel("京阪杯（G3）"), 3);
  assert.equal(raceGradeLevel("JBCクラシック（JpnI）"), 1);
  assert.equal(raceGradeLevel("浦和記念(JpnII)"), 2);
  assert.equal(raceGradeLevel("3歳未勝利"), null);
  assert.equal(raceGradeLevel("Gallop賞"), null);
});

test("prefers the venue holding the highest graded race", () => {
  const venues = [venue("26050508", ["2歳未勝利", "京阪杯（G3）"]), venue("26080508", ["1勝クラス", "ジャパンC(GI)"]), venue("26090508", ["2歳新馬"])];
  assert.equal(venueGradeScore(venues[1]), 3);
  for (const date of ["2026-11-29", "2026-11-30", "2026-12-01"]) assert.equal(pickFreeVenue(venues, date, "jra").eventId, "26080508");
});

test("picks the same venue for everyone on a date regardless of list order", () => {
  const venues = [venue("2026112042", ["C1"]), venue("2026112030", ["C2"]), venue("2026112021", ["B3"])];
  const first = pickFreeVenue(venues, "2026-11-20", "nar");
  assert.equal(pickFreeVenue([...venues].reverse(), "2026-11-20", "nar").eventId, first.eventId);
  const picks = new Set(Array.from({ length: 30 }, (_, day) => pickFreeVenue(venues, `2026-12-${String(day + 1).padStart(2, "0")}`, "nar").eventId));
  assert.ok(picks.size > 1, "the free venue rotates across days");
});

test("returns null when nothing is held and skips venues without races", () => {
  assert.equal(pickFreeVenue([], "2026-11-20", "jra"), null);
  assert.equal(pickFreeVenue([{ eventId: "x", races: [] }], "2026-11-20", "jra"), null);
});

test("classifies race ids and checks membership in the free venue", () => {
  assert.equal(freeLeagueOf("2605050811"), "jra");
  assert.equal(freeLeagueOf("202611204201"), "nar");
  assert.equal(freeLeagueOf("2605050813"), null);
  assert.equal(freeLeagueOf("../etc"), null);
  const free = venue("26050508", ["a", "b"]);
  assert.equal(venueHasRace(free, "2605050802"), true);
  assert.equal(venueHasRace(free, "2605050902"), false);
  assert.equal(venueHasRace(null, "2605050802"), false);
});

test("removes paid ticket content from free analysis responses", () => {
  const stripped = stripPaidAnalysis({ race: { raceId: "1" }, tickets: [{ type: "馬連", tiers: [{ group: "本線", points: 3, selections: ["1-2"] }] }] });
  assert.deepEqual(stripped.tickets, []);
  assert.equal(stripped.free, true);
  assert.equal(JSON.stringify(stripped).includes("1-2"), false);
});
