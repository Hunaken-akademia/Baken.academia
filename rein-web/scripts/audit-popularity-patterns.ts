import {readFileSync} from "node:fs";
import {buildPopularityForecast} from "../lib/popularity-forecast";
import {conditionSymbol,CONDITION_ROWS,availableConditionRows} from "../lib/condition-symbols";
import {popularityPattern} from "../lib/race-day-trends";
const input=JSON.parse(readFileSync(process.argv[2],"utf8"));
const out={races:0,table:{top1:0,top3:0},model:{top1:0,top3:0},old:{known:0,total:0},current:{known:0,total:0},examples:[] as unknown[]};
for(const row of input){
 const fs=row.review.finishers.map((f:any)=>({number:f.number,finish:f.finish}));
 const actual=popularityPattern(fs,row.horses); // judge by the popularity known at prediction time
 if(!actual)continue;
 const forecast=buildPopularityForecast(row.horses,{rolesReady:row.evaluation?.roleModel==="ready"});
 if(!forecast.table.length||!forecast.model.length)continue;
 out.races++;
 for(const key of ["table","model"] as const){if(forecast[key][0].pattern===actual.pattern)out[key].top1++;if(forecast[key].some(p=>p.pattern===actual.pattern))out[key].top3++;}
 for(const h of row.horses){
  const factors=h.parameterFactors??h.historyFactors??[];const career=factors.find((f:any)=>f.label==="通算成績");
  for(const r of CONDITION_ROWS.filter(r=>r.factor!=="通算成績")){out.old.total++;const f=factors.find((f:any)=>f.label===r.factor);if((career?.samples??0)>=20&&(f?.samples??0)>=(r.factor==="近5走"?5:10)&&["近5走","芝ダ適性","距離適性","競馬場適性"].includes(r.factor))out.old.known++;}
  for(const r of availableConditionRows(row.horses)){out.current.total++;if(conditionSymbol(h,r.factor).symbol!=="—")out.current.known++;}
 }
 if(out.examples.length<3)out.examples.push({race:row.race.title,date:row.race_date,actual:actual.pattern,table:forecast.table.map(p=>p.pattern),model:forecast.model.map(p=>p.pattern)});
}
console.log(JSON.stringify(out,null,2));
