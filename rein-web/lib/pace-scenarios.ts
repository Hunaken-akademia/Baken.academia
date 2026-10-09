import { horseSequences, type MapHorse } from "./corner-reference";
import {roleOrder} from "./marks";
export const PACE_SCENARIOS = [
 {id:"baseline",label:"基本想定",flow:"近走の位置取り",premise:"近走の通過順から序盤の並びを確認。",watch:"逃げ候補の頭数と各馬の普段の位置。"},
 {id:"lone",label:"単騎逃げ・ゆったり",flow:"スロー寄り",premise:"選んだ馬がハナを取り、他の馬が競りかけずに落ち着く。",watch:"競りかけと後続の早めの進出。差し馬は位置取りも確認。"},
 {id:"steady",label:"逃げ争い控えめ",flow:"平均寄り",premise:"選んだ馬が前へ行くが、序盤の争いは長引かない。",watch:"前に付ける頭数と好位から動ける馬。"},
 {id:"duel",label:"逃げ争い激化",flow:"ハイ寄り",premise:"複数の馬がハナを譲らず、序盤からペースが上がる。",watch:"競り合いが続くか。前が消耗すれば差し勢に出番。"},
 {id:"sustain",label:"早めに動く展開",flow:"途中から加速",premise:"序盤は落ち着くが、中盤から動き、長く脚を使う。",watch:"近走で途中から位置を上げた馬。通過順だけでは持久力は判断できない。"},
 {id:"closers",label:"差しが届く展開",flow:"前が苦しくなる",premise:"前が消耗し、後方で脚をためた馬が届く条件を置く。",watch:"差し・追込馬の位置と着順適性。上がり時計や進路も別途確認。"},
] as const;
export type PaceScenarioId=typeof PACE_SCENARIOS[number]['id'];
export type ScenarioHorse=MapHorse & {popularity:number;firstProbability?:number;secondProbability?:number;thirdProbability?:number};
const styles=["逃げ","先行","好位","差し","追込"];
export function positionEvidence(horse:MapHorse){const sequences=horseSequences(horse);return {sequences,samples:sequences.length,early:sequences.length?sequences.reduce((s,v,i)=>s+v[0]*(5-i),0)/sequences.reduce((s,_,i)=>s+5-i,0):null,leads:sequences.filter(v=>v[0]===1).length,advances:sequences.filter(v=>v.at(-1)!<v[0]).length};}
export function escapeCandidates(horses:ScenarioHorse[]){return horses.filter(h=>h.style==="逃げ"||(positionEvidence(h).early??Infinity)<=3).sort((a,b)=>(positionEvidence(a).early??Infinity)-(positionEvidence(b).early??Infinity)||a.number-b.number);}
export function scenarioView(horses:ScenarioHorse[],id:PaceScenarioId,leaders:number[]){
 const chosen=new Set(leaders.filter(n=>horses.some(h=>h.number===n))),scenario=PACE_SCENARIOS.find(s=>s.id===id)??PACE_SCENARIOS[0];
 const rows=horses.map(horse=>{const evidence=positionEvidence(horse),front=horse.style==="逃げ"||horse.style==="先行",middle=horse.style==="好位",back=horse.style==="差し"||horse.style==="追込",known=styles.includes(horse.style),lead=chosen.has(horse.number);
 let fit: "追い風"|"注意"|"中立"|"未判定"=known?"中立":"未判定",reason="脚質の有利・不利を強く置かない条件。";
 if(id==="lone"){fit=lead||front?"追い風":back?"注意":known?"中立":"未判定";reason=lead?"単騎なら競り合いの負担が少ない。":front?"落ち着く流れなら前の位置を生かす余地。":back?"前が止まりにくい条件では差し届かない可能性。":"好位を確保できるか確認。";}
 if(id==="steady"){fit=front||middle?"追い風":known?"中立":"未判定";reason=front||middle?"争いが長引かなければ前・好位の位置を生かす余地。":"差しが届くかは後半の流れ次第。";}
 if(id==="duel"||id==="closers"){fit=lead||front?"注意":back?"追い風":known?"中立":"未判定";reason=lead||front?"前が消耗する条件では粘り込みに注意。":back?"差し込む余地。末脚の実績は別途確認。":"先行勢からの距離と仕掛けを確認。";}
 if(id==="sustain"){fit=evidence.samples?evidence.advances>=Math.ceil(evidence.samples/2)?"追い風":"中立":"未判定";reason=evidence.samples?`近${evidence.samples}走中${evidence.advances}走で最初から最後の通過点へ位置を上げた。`:"進出傾向の通過順がない。";}
 if(!known&&id!=="sustain"&&!lead)reason="脚質データ不足のため相性は未判定。";
 const style=styles.indexOf(horse.style),base=evidence.early??(style>=0?1+style*Math.max(1,(horses.length-1)/4):null),start=lead?1+[...chosen].indexOf(horse.number)*0.5:base;
 // Illustrative scenarios, deliberately separate from trained corner estimates.
 const shift=id==="sustain"&&evidence.samples?-Math.min(2,evidence.advances):(id==="duel"||id==="closers")?front||lead?2:back?-2:0:id==="lone"&&back?1:0;
 return {horse,evidence,fit,reason,positions:{0:start,1:start===null?null:Math.max(1,Math.min(horses.length,start+shift/4)),2:start===null?null:Math.max(1,Math.min(horses.length,start+shift/3)),3:start===null?null:Math.max(1,Math.min(horses.length,start+shift/2)),4:start===null?null:Math.max(1,Math.min(horses.length,start+shift))}};
 });
 // Normalize to ordinal slots; never show an invented decimal/error interval.
 for (const stage of [0,1,2,3,4] as const) {
  const ordered=rows.filter(r=>r.positions[stage]!==null).sort((a,b)=>
   (stage===0 ? Number(chosen.has(b.horse.number))-Number(chosen.has(a.horse.number)) : 0)
   || a.positions[stage]!-b.positions[stage]! || a.horse.number-b.horse.number);
  ordered.forEach((r,i)=>{r.positions[stage]=i+1;});
 }
 const warnings:string[]=[];if(id==="lone"&&chosen.size!==1)warnings.push("単騎逃げは先頭に立つ馬を1頭選んで比較してください。");if(id==="duel"&&chosen.size<2)warnings.push("逃げ争い激化は競り合う馬を2頭以上選ぶと比較しやすくなります。");if(rows.some(r=>chosen.has(r.horse.number)&&r.horse.style!=="逃げ"))warnings.push("普段は逃げ以外の馬を選んでいます。今回は前へ行く仮定です。");return {scenario,rows,warnings};
}

// A transparent scenario illustration, not fitted probabilities or model updates.
export function scenarioRanking(horses:ScenarioHorse[],id:PaceScenarioId,leaders:number[],roleReady:boolean){
 if(!roleReady)return [];
 if(horses.some(h=>typeof h.firstProbability!=="number"||!Number.isFinite(h.firstProbability)||h.firstProbability<0||h.firstProbability>1))return [];
 const validLeaders=[...new Set(leaders.filter(n=>horses.some(h=>h.number===n)))];
 if(id==="lone"&&validLeaders.length!==1||id==="duel"&&validLeaders.length<2)return [];
 const base=roleOrder(horses,"first");if(base.length!==horses.length)return [];
 const view=scenarioView(horses,id,leaders),chosen=new Set(leaders);
 return base.map((horse,i)=>{
  const row=view.rows.find(r=>r.horse.number===horse.number)!;
  let shift=0;
  if(id!=="baseline"){
   shift=row.fit==="追い風"?-2:row.fit==="注意"?2:0;
   if(id==="lone"&&chosen.has(horse.number))shift=-3;
   if(id==="duel"&&chosen.has(horse.number))shift=3;
   if(id==="closers")shift=row.fit==="追い風"?-3:row.fit==="注意"?3:0;
  }
  return {horse,baseRank:i+1,referenceScore:i+1+shift,shift,reason:row.reason};
 }).sort((a,b)=>a.referenceScore-b.referenceScore||a.baseRank-b.baseRank).map((row,i)=>({...row,rank:i+1}));
}

// Explicit, reproducible assumptions for comparing mutually exclusive scenarios.
export function scenarioLeaders(horses:ScenarioHorse[],id:PaceScenarioId,selected:number[]){
 const chosen=[...new Set(selected.filter(n=>horses.some(h=>h.number===n)))];
 const candidates=escapeCandidates(horses).map(h=>h.number);
 if(id==="lone")return (chosen.length?chosen:candidates).slice(0,1);
 if(id==="duel"&&chosen.length<2)return [...new Set([...chosen,...candidates])].slice(0,2);
 return chosen;
}
export function scenarioComparison(horses:ScenarioHorse[],selected:number[],roleReady:boolean){
 return PACE_SCENARIOS.map(scenario=>{const leaders=scenarioLeaders(horses,scenario.id,selected);return {scenario,leaders,ranking:scenarioRanking(horses,scenario.id,leaders,roleReady)};});
}
