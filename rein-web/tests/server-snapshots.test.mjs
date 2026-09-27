import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync(new URL('../../supabase/functions/rein-server-data/records.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
const { snapshotRecord, validGithubCaptureClaims } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const before='2026-09-27T05:00:00Z', start=Date.parse('2026-09-27T06:00:00Z'), after=start+3600000;
const body=()=>({race:{raceId:'2606040911',title:'Test',startsAt:start},prediction:{generatedAt:before,phase:'prestart',source:'live'},evaluation:{roleModel:'ready'},horses:Array.from({length:3},(_,i)=>({number:i+1,name:`Horse${i}`,popularity:i+1,odds:2+i,firstProbability:.2,secondProbability:.3,thirdProbability:.4}))});
test('only authentic prestart predictions enter shared performance history',()=>{
 const value=body(); const record=snapshotRecord(value,false,after);
 assert.equal(record.prestart,true); assert.equal(record.race_date,'2026-09-27'); assert.ok(record.journal);
 assert.equal(snapshotRecord(value,true,after).journal,null);
 for (const change of [{generatedAt:new Date(after).toISOString(),phase:'final',source:'rebuilt'},{generatedAt:before,phase:'final',source:'rebuilt'}]) {
  assert.equal(snapshotRecord({...value,prediction:change},false,after).journal,null);
 }
 assert.equal(snapshotRecord({...value,evaluation:{roleModel:'unavailable'}},false,after).journal,null);
});
test('results and forecast are separated; tied/ambiguous top three cannot be scored',()=>{
 const value=body(); value.prediction.phase='final';value.prediction.source='prestart';
 value.review={isFinished:true,finishers:[{number:1,finish:1},{number:2,finish:2},{number:3,finish:3}]};
 const record=snapshotRecord(value,false,after);
 assert.equal(record.is_final,true);assert.ok(record.journal);assert.equal(record.journal.finishers,undefined);assert.equal(record.result.length,3);
 value.review.finishers[2].finish=2;
 assert.equal(snapshotRecord(value,false,after).result,null);
});
test('invalid and duplicate runners are rejected rather than persisted',()=>{
 const value=body();value.horses[1].number=1;
 assert.throws(()=>snapshotRecord(value,false,after));
 assert.throws(()=>snapshotRecord({...body(),race:{raceId:'arbitrary'}},false,after));
 assert.throws(()=>snapshotRecord(body(),false,Date.parse(before)-120000));
});
test('only the bound main-branch workflow may archive daily data',()=>{
 const good={repository_id:'1376323200',repository:'Hunaken-akademia/Baken.academia',ref:'refs/heads/main',workflow_ref:'Hunaken-akademia/Baken.academia/.github/workflows/rein-daily-capture.yml@refs/heads/main',event_name:'schedule'};
 assert.equal(validGithubCaptureClaims(good),true);
 for(const patch of [{repository_id:'evil'},{ref:'refs/pull/2/merge'},{event_name:'pull_request'},{workflow_ref:'other'}])assert.equal(validGithubCaptureClaims({...good,...patch}),false);
});
