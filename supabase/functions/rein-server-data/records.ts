// Pure validation; shared by the Edge Function and regression tests.
export function snapshotRecord(body: any, preview: boolean, now = Date.now()) {
  const id = body?.race?.raceId;
  const generated = Date.parse(body?.prediction?.generatedAt);
  const starts = body?.race?.startsAt;
  if (!/^\d{10,12}$/.test(id ?? "") || !Number.isFinite(generated) || generated > now + 60_000 || !Array.isArray(body?.horses) || !body.horses.length || body.horses.length > 18) throw new Error("Invalid snapshot");
  const numbers = body.horses.map((h: any) => h.number);
  if (numbers.some((n: unknown) => !Number.isInteger(n) || Number(n) < 1 || Number(n) > 18) || new Set(numbers).size !== numbers.length) throw new Error("Invalid runners");
  const roster = [...numbers].sort((a,b) => a-b).join("-");
  const hasStart = typeof starts === "number" && Number.isFinite(starts);
  const date = new Date((hasStart ? starts : generated) + 9 * 3600_000).toISOString().slice(0,10);
  const roles = ["firstProbability", "secondProbability", "thirdProbability"];
  const complete = body.capture?.complete !== false;
  const authentic = complete && !preview && hasStart && generated < starts && body.prediction.source !== "rebuilt" && (body.prediction.phase === "prestart" || body.prediction.source === "prestart") && body.evaluation?.roleModel === "ready" && body.horses.every((h: any) => roles.every(r => typeof h[r] === "number" && Number.isFinite(h[r]) && h[r] >= 0 && h[r] <= 1));
  const journal = authentic ? {
    schema: 1, id: `${id}:${body.prediction.generatedAt}`, raceId: id, title: body.race.title,
    generatedAt: body.prediction.generatedAt, startsAt: starts, model: body.model?.version ?? "不明",
    oddsAt: body.race.dataTimes?.odds ?? body.race.dataTimes?.card ?? null, roster,
    horses: body.horses.map((h: any) => ({ number: h.number, name: h.name, popularity: Number.isFinite(h.popularity) ? h.popularity : 0, odds: h.odds ?? null, firstProbability: h.firstProbability, secondProbability: h.secondProbability, thirdProbability: h.thirdProbability })),
  } : null;
  const finishers = body.review?.isFinished && Array.isArray(body.review.finishers) ? body.review.finishers.filter((r: any) => r.finish >= 1 && r.finish <= 3).map((r: any) => ({ number: r.number, finish: r.finish })) : [];
  const result = finishers.length === 3 && new Set(finishers.map((r: any) => r.number)).size === 3 && [1,2,3].every(n => finishers.filter((r: any) => r.finish === n && numbers.includes(r.number)).length === 1) ? finishers : null;
  return { race_id: id, race_date: date, slot: preview ? "preview" : "live", generated_at: body.prediction.generatedAt, starts_at: hasStart ? new Date(starts).toISOString() : null, is_final: complete && body.review?.isFinished === true, payload: body, journal, result, roster, prestart: authentic && body.prediction.phase === "prestart" };
}

function validGithubRepositoryClaims(claims: Record<string, unknown>) {
  return claims.repository_id === "1376323200"
    && claims.repository === "Hunaken-akademia/Baken.academia"
    && claims.ref === "refs/heads/main";
}

export function validGithubCaptureClaims(claims: Record<string, unknown>) {
  const workflow = String(claims.workflow_ref);
  const event = String(claims.event_name);
  return validGithubRepositoryClaims(claims)
    && workflow === "Hunaken-akademia/Baken.academia/.github/workflows/rein-daily-capture.yml@refs/heads/main"
    && ["schedule", "workflow_dispatch", "push"].includes(event);
}

export function validGithubNarAnalysisClaims(claims: Record<string, unknown>) {
  const workflow = String(claims.workflow_ref);
  const event = String(claims.event_name);
  return validGithubRepositoryClaims(claims)
    && workflow === "Hunaken-akademia/Baken.academia/.github/workflows/nar-partial-analysis.yml@refs/heads/main"
    && ["schedule", "workflow_dispatch", "push", "workflow_run"].includes(event);
}
