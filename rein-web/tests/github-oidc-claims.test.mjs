import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../../supabase/functions/rein-server-data/records.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { validGithubCaptureClaims, validGithubNarAnalysisClaims } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);

const baseClaims = {
  repository_id: '1376323200',
  repository: 'Hunaken-akademia/Baken.academia',
  ref: 'refs/heads/main',
};

const captureClaims = (event_name = 'schedule') => ({
  ...baseClaims,
  event_name,
  workflow_ref: 'Hunaken-akademia/Baken.academia/.github/workflows/rein-daily-capture.yml@refs/heads/main',
});

const narAnalysisClaims = (event_name = 'workflow_run') => ({
  ...baseClaims,
  event_name,
  workflow_ref: 'Hunaken-akademia/Baken.academia/.github/workflows/nar-partial-analysis.yml@refs/heads/main',
});

test('capture OIDC claims cannot be used by the NAR analysis workflow', () => {
  assert.equal(validGithubCaptureClaims(captureClaims()), true);
  assert.equal(validGithubNarAnalysisClaims(captureClaims()), false);
  assert.equal(validGithubCaptureClaims(captureClaims('workflow_run')), false);
});

test('NAR analysis OIDC claims are separate from archive capture claims', () => {
  assert.equal(validGithubNarAnalysisClaims(narAnalysisClaims()), true);
  assert.equal(validGithubCaptureClaims(narAnalysisClaims()), false);
  assert.equal(validGithubNarAnalysisClaims(narAnalysisClaims('schedule')), true);
  assert.equal(validGithubNarAnalysisClaims({ ...narAnalysisClaims(), repository_id: 'wrong' }), false);
  assert.equal(validGithubNarAnalysisClaims({ ...narAnalysisClaims(), ref: 'refs/heads/feature' }), false);
});
