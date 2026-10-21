import { createRoot } from "react-dom/client";
import { ConditionMatrix } from "../components/condition-matrix";
import { PopularityForecast } from "../components/popularity-forecast";
import { PopularityResult } from "../components/popularity-groups";
import type { Horse } from "../lib/horse-types";
const horses = Array.from({length:18},(_,i)=>({number:i+1,name:`検証馬${i+1}`,popularity:i+1,odds:2+i,score:90-i,mark:"",style:"先行",verdict:"",positives:[],cautions:[],parameterFactors:[{label:"通算成績",samples:20,top3Rate:40,impact:0},{label:"距離適性",samples:10,top3Rate:i===0?60:30,winRate:i===0?30:10,impact:0},...(i<2?[{label:"騎手相性",samples:i?0:7,top3Rate:i?0:85.7,impact:0,record:i?"0-0-0-0":"3-2-1-1"}]:[])],jockey:`騎手${i+1}`,...(i===0?{sire:"フリオーソ",damSire:"モンテロッソ"}:{})} as Horse));
createRoot(document.getElementById("root")!).render(<main className="mx-auto max-w-4xl p-3 text-white"><ConditionMatrix horses={horses} onHorse={h=>{document.getElementById('detail')!.textContent=h.name}}/><PopularityForecast horses={horses} race={{raceId:"qa",title:"検証",course:"芝1600m",condition:"良"}} rolesReady={false} finished={false} predictionSafe onHorse={()=>{}}/><PopularityResult horses={horses} finished finishers={[{number:3,finish:1,popularity:3},{number:5,finish:2,popularity:5},{number:1,finish:3,popularity:1}]}/><p id="detail" /></main>);
