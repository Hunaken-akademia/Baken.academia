import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const code=ts.transpileModule(readFileSync(new URL('../lib/lineage.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
const {lineageKey,parseCardLineage,pedigreeFactors,pairFactors}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
test('JRA card cells give sire and dam sire; foreign runners stay blank',()=>{
 // Cell text from the Yahoo! card for the 2024 Japan Cup.
 assert.deepEqual(parseCardLineage('父： ハーツクライ 母：ダストアンドダイヤモンズ (母父：Vindication)'),{sire:'ハーツクライ',damSire:'Vindication'});
 assert.deepEqual(parseCardLineage('父： エピファネイア 母： オートクレール (母父： デュランダル )'),{sire:'エピファネイア',damSire:'デュランダル'});
 assert.deepEqual(parseCardLineage('父： 母： (母父：)'),{});assert.deepEqual(parseCardLineage(undefined),{});
 assert.equal(lineageKey(' St Mark\'s　Basilica '),"StMark'sBasilica");
});
test('JRA sire rows use surface and distance band; pair records keep first rides',()=>{
 const profile={sire:{'ハーツクライ':{n:100,w:16.5/120,t:34.5/120,f:5}},sireSurfaceDistance:{'ハーツクライ|芝|12':{n:40,w:9.5/60,t:20.5/60,f:4.2}}};
 const [f]=pedigreeFactors(profile,'ハーツ クライ','芝',2400);
 assert.equal(f.subject,'ハーツ クライ産駒・芝2400〜2599m');assert.equal(f.top3Rate,40);assert.equal(f.baseline,30);
 assert.deepEqual(pedigreeFactors(profile,'ハーツクライ','ダート',2400),[]);
 assert.deepEqual(pairFactors([7,3,2,1]),[{label:'騎手相性',samples:7,impact:0,wins:3,top3:6,winRate:42.9,top3Rate:85.7,record:'3-2-1-1'}]);
 assert.equal(pairFactors(undefined)[0].record,'0-0-0-0');assert.equal(pairFactors(undefined)[0].samples,0);
});
