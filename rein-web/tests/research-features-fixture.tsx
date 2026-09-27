import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PredictionJournal, HorseNotebook } from "../components/prediction-journal";
import { MarketRankMap } from "../components/market-rank-map";
import { PredictionDataStatus } from "../components/prediction-data-status";
import { RaceFormationMap } from "../components/race-formation-map";

// Synthetic browser QA; not exposed as a route or used for predictions.
const horses=Array.from({length:18},(_,i)=>({number:i+1,name:`表示検証の長い馬名テスト${i+1}`,popularity:18-i,odds:i+2,firstProbability:(18-i)/171,secondProbability:(i+1)/171,thirdProbability:(18-i)/171,gate:Math.min(8,Math.floor(i/2)+1),style:["逃げ","先行","好位","差し","追込"][Math.min(4,Math.floor(i/4))],mapPositions:i===17?[]:[`${Math.max(1,i-2)}-${Math.max(1,i-1)}-${i+1}-${Math.max(1,i)}`,`${i+1}-${i+1}-${Math.max(1,i-1)}-${Math.max(1,i-2)}`],firstSuitability:i === 15 ? 100 : i === 10 ? 99 : i === 12 ? 98 : 90-i*4,historySamples:i}));
function Fixture() {
  const [later,setLater]=useState(false),[finished,setFinished]=useState(false);
  const data={race:{raceId:"qa-feature",title:"表示検証 11R",startsAt:Date.parse("2026-09-28T06:00:00Z"),dataTimes:{odds:later ? "2026-09-28T05:30:00Z" : "2026-09-28T05:00:00Z"}},prediction:{phase:finished ? "final" : "prestart",source:finished ? "prestart" : "live",generatedAt:later ? "2026-09-28T05:30:00Z" : "2026-09-28T05:00:00Z"},model:{version:"qa-test",dateTo:"2026-09-13"},evaluation:{roleModel:"ready"},horses:horses.map(h=>({...h,odds:later ? h.odds+1 : h.odds})),review:{isFinished:finished,finishers:finished ? [{number:1,finish:1},{number:2,finish:2},{number:3,finish:3}] : []}};
  return <main style={{maxWidth:1100,margin:"0 auto",padding:12}}><p className="mb-4 text-amber-300">架空データ・表示検証専用</p><div className="mb-3 flex gap-3"><button onClick={()=>setLater(true)} className="min-h-11 rounded bg-slate-700 px-3">QA 予想更新</button><button onClick={()=>setFinished(true)} className="min-h-11 rounded bg-slate-700 px-3">QA 結果照合</button></div><PredictionJournal data={data}/><div className="mb-5 rounded-xl bg-[#0c192a] p-4"><PredictionDataStatus data={data}/></div><RaceFormationMap horses={horses} title="中山 11R" course="ダート右1800m" raceId="2606040911" pace="平均〜やや速い"/><MarketRankMap horses={data.horses}/><HorseNotebook horseId="9999999999" name={horses[0].name}/></main>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
