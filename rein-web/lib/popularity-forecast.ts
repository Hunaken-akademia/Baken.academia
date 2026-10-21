import type { Horse } from "./horse-types";
import type { DayTrends } from "./race-day-trends";
import { popularityGroup } from "./race-day-trends";
import { availableConditionRows } from "./condition-symbols";
import { historyFactors, historyRate } from "./horse-research";


export function patternPredictionSafe(prediction: {phase:string;source:string;generatedAt:string}|undefined, startsAt:number|null|undefined, finished:boolean) {
  if (!prediction || prediction.source === "rebuilt") return false;
  const generated=Date.parse(prediction.generatedAt);
  if (!Number.isFinite(generated)) return false;
  if (typeof startsAt === "number" && Number.isFinite(startsAt) && generated >= startsAt) return false;
  if (finished) return prediction.source === "prestart" && typeof startsAt === "number" && Number.isFinite(startsAt) && generated < startsAt;
  return prediction.phase === "preview" || prediction.phase === "prestart" || prediction.source === "prestart";
}

type Entry = { pattern: string; weight: number; best: { numbers: number[]; weight: number } };
export type PatternView = { pattern: string; rank: number; examples: number[]; relativeScore: number; todayCount: number };
const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const roleKeys = ["firstProbability", "secondProbability", "thirdProbability"] as const;

// A transparent approximation of ordered finishes, NOT a calibrated joint probability.
// Each successive role is re-normalized over horses not already selected.
export function rankPopularityPatterns(horses: Horse[], weights: number[][]): Entry[] {
  if (horses.length < 3 || horses.some(h => !popularityGroup(h.popularity)) || new Set(horses.map(h => h.number)).size !== horses.length || weights.length !== 3 || weights.some(row => row.length !== horses.length || row.some(w => !valid(w)) || row.reduce((a,b)=>a+b,0) <= 0)) return [];
  const totals = weights.map(row => row.reduce((a,b)=>a+b,0)), patterns = new Map<string,Entry>();
  for (let i=0;i<horses.length;i++) for(let j=0;j<horses.length;j++) {
    if (i===j || totals[1]-weights[1][i]<=0) continue;
    for(let k=0;k<horses.length;k++) {
      if(k===i||k===j||totals[2]-weights[2][i]-weights[2][j]<=0)continue;
      const weight=weights[0][i]/totals[0]*weights[1][j]/(totals[1]-weights[1][i])*weights[2][k]/(totals[2]-weights[2][i]-weights[2][j]);
      if (!(weight>0)) continue;
      const pattern=[i,j,k].map(n=>popularityGroup(horses[n].popularity)).join("-");
      const old=patterns.get(pattern)??{pattern,weight:0,best:{numbers:[],weight:0}};
      old.weight+=weight;
      if(weight>old.best.weight)old.best={numbers:[i,j,k].map(n=>horses[n].number),weight};
      patterns.set(pattern,old);
    }
  }
  return [...patterns.values()].sort((a,b)=>b.weight-a.weight||a.pattern.localeCompare(b.pattern));
}

export function tableRoleWeights(horses: Horse[]) {
  const rows=availableConditionRows(horses);
  const coverage=horses.map(h=>rows.filter(r=>historyRate(historyFactors(h).find(f=>f.label===r.factor),"top3")!==null).length);
  const known=coverage.filter(n=>n>0).length;
  if(known<3||!rows.length)return {weights:null,known,rows:rows.map(r=>r.label)};
  const scores=horses.map(h=>{
    const factors=historyFactors(h);
    const values=rows.flatMap(row=>{
      const f=factors.find(f=>f.label===row.factor),top3=historyRate(f,"top3"),win=historyRate(f,"win");
      if(top3===null||!f)return [];
      const reliability=Math.min(f.samples,20)/(Math.min(f.samples,20)+5);
      // Wins and place rates describe different roles; missing wins fall back to a neutral fraction of places.
      return [{first:(win??top3/3)*reliability+10*(1-reliability),place:top3*reliability+30*(1-reliability)}];
    });
    if(!values.length)return null;
    const first=values.reduce((s,v)=>s+v.first,0)/values.length;
    const place=values.reduce((s,v)=>s+v.place,0)/values.length;
    return [Math.max(.01,first),Math.max(.01,place-first/2),Math.max(.01,place-first/3)];
  });
  const means=[0,1,2].map(role=>scores.reduce((s,v)=>s+(v?.[role]??0),0)/known);
  return {weights:[0,1,2].map(role=>scores.map(v=>v?.[role]??means[role])),known,rows:rows.map(r=>r.label)};
}

export function buildPopularityForecast(horses: Horse[], options: { rolesReady: boolean; trends?: DayTrends; finished?: boolean; predictionSafe?: boolean }) {
  const table=tableRoleWeights(horses), tableRanking=table.weights?rankPopularityPatterns(horses,table.weights):[];
  const completeModel=options.rolesReady&&horses.every(h=>roleKeys.every(key=>valid(h[key])&&h[key]!<=1));
  const modelRanking=completeModel?rankPopularityPatterns(horses,roleKeys.map(key=>horses.map(h=>h[key]!))):[];
  const base=modelRanking.length?modelRanking:tableRanking;
  // DayTrends has already excluded current/later races and late-observed results.
  const usable=options.trends?.races.filter(r=>r.popularity?.source==="結果掲載人気")??[];
  const counts=new Map<string,number>();
  usable.forEach(r=>counts.set(r.popularity!.pattern,(counts.get(r.popularity!.pattern)??0)+1));
  const observations=[...counts].map(([pattern,count])=>({pattern,count})).sort((a,b)=>b.count-a.count||a.pattern.localeCompare(b.pattern));
  // Small daily samples get only a bounded reference adjustment; there is no trained "hot-pattern" model.
  const strength=usable.length>=3?Math.min(.15,usable.length/(usable.length+30)):0;
  const adjusted=base.map(e=>({...e,weight:e.weight*(1+strength*Math.min(2,(counts.get(e.pattern)??0)/Math.max(1,usable.length)/(1/Math.max(1,base.length))))})).sort((a,b)=>b.weight-a.weight||a.pattern.localeCompare(b.pattern));
  const view=(list:Entry[]):PatternView[]=>list.slice(0,3).map((e,i)=>({pattern:e.pattern,rank:i+1,examples:e.best.numbers,relativeScore:list[0]?.weight?Math.round(e.weight/list[0].weight*100):0,todayCount:counts.get(e.pattern)??0}));
  const safe=options.predictionSafe!==false;
  return {
    table:safe?view(tableRanking):[],model:safe?view(modelRanking):[],combined:safe?view(adjusted):[],
    tableKnown:table.known,total:horses.length,tableRows:table.rows,
    observations,dayRaces:usable.length,dayApplied:strength>0,dayStrength:strength,
    basis:modelRanking.length?"REIN着順モデル":"適性表の参考評価",
    review:options.finished===true,safe,
    reason:!safe?"発走前の保存予想ではないため、結果判明後のパターン予測は作りません。":horses.some(h=>!popularityGroup(h.popularity))?"人気未発表の馬がいるため、人気パターンの順位は保留します。":!base.length?"条件別成績・着順適性が不足しています。":"",
  };
}
