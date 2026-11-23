import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const code=ts.transpileModule(readFileSync(new URL('../lib/reference-results.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
const {referenceResults}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const tickets=type=>[{type,tiers:[{group:'本線',selections:['2-1','3-4']}]}];
test('unordered bets match reverse order; exacta preserves order',()=>{
 const [line]=referenceResults(tickets('馬連'),true,[{type:'馬連',selection:'1－2',payout:1230}]);
 assert.equal(line.status,'hit');assert.equal(line.returnYen,1230);
 assert.equal(referenceResults(tickets('馬単'),true,[{type:'馬単',selection:'1-2',payout:1230}])[0].status,'miss');
});
test('pending or missing payouts never become misses',()=>{
 assert.equal(referenceResults(tickets('馬連'),false,[])[0].status,'pending');
 assert.equal(referenceResults(tickets('馬連'),true,[])[0].status,'unavailable');
});
test('normalizes trio labels, includes every tier and sums multiple winners',()=>{
 const lines=referenceResults([{type:'三連複',tiers:[{group:'穴',selections:['3-2-1']},{group:'本線',selections:['4-5-6']}]}],true,[{type:'3連複',selection:'1-2-3',payout:9990}]);
 assert.equal(lines[0].returnYen,9990);assert.equal(lines[1].status,'miss');
 const [line]=referenceResults([{type:'複勝',tiers:[{group:'本線',selections:['1','2']}]}],true,[{type:'複勝',selection:'1',payout:110},{type:'複勝',selection:'2',payout:120}]);
 assert.equal(line.returnYen,230);
});
test('withdrawals are excluded from hit/miss judgments',()=>{
 assert.equal(referenceResults(tickets('馬連'),true,[{type:'馬連',selection:'1-2',payout:1230}],true)[0].status,'excluded');
});
test('venue, bet type, tier and hit filters apply together to the same line',async()=>{
 const {filterReferenceRaces}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
 const lines=referenceResults([{type:'馬連',tiers:[{group:'本線',selections:['1-2']},{group:'穴',selections:['3-4']}]},{type:'馬単',tiers:[{group:'本線',selections:['2-1']}]}],true,[{type:'馬連',selection:'1-2',payout:100},{type:'馬単',selection:'2-1',payout:200}]);
 const races=[{raceId:'a',venue:'東京',lines,saved:true},{raceId:'b',venue:'京都',lines,saved:true},{raceId:'c',venue:'東京',lines:[],saved:false}];
 const filters={venue:'東京',type:'馬連',group:'本線',hitsOnly:true};
 const result=filterReferenceRaces(races,filters);
 assert.deepEqual(result.map(r=>r.raceId),['a']);assert.equal(result[0].lines.length,1);
 assert.equal(filterReferenceRaces(races,{...filters,group:'穴'}).length,0);
 assert.equal(filterReferenceRaces(races,{...filters,hitsOnly:false,group:'穴'})[0].lines[0].status,'miss');
 assert.equal(filterReferenceRaces(races,{venue:'',type:'',group:'',hitsOnly:false}).length,3);
 assert.equal(races[0].lines.length,3);
});
