import { createRoot } from "react-dom/client";
import { ConditionMatrix } from "../components/condition-matrix";
import { PopularityGroups, PopularityResult } from "../components/popularity-groups";
import type { Horse } from "../lib/horse-types";
const horses = Array.from({length:18},(_,i)=>({number:i+1,name:`検証馬${i+1}`,popularity:i+1,odds:2+i,score:90-i,mark:"",style:"先行",verdict:"",positives:[],cautions:[],parameterFactors:[{label:"通算成績",samples:20,top3Rate:40,impact:0},{label:"距離適性",samples:10,top3Rate:i===0?60:30,impact:0}]} as Horse));
createRoot(document.getElementById("root")!).render(<main className="mx-auto max-w-4xl p-3 text-white"><ConditionMatrix horses={horses} onHorse={h=>{document.getElementById('detail')!.textContent=h.name}}/><PopularityGroups horses={horses} onHorse={()=>{}}/><PopularityResult horses={horses} finished finishers={[{number:3,finish:1,popularity:3},{number:5,finish:2,popularity:5},{number:1,finish:3,popularity:1}]}/><p id="detail" /></main>);
