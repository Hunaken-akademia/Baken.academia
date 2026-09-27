import { createRoot } from "react-dom/client";
import { RaceFormationMap } from "../components/race-formation-map";

// Browser QA fixture only. Not an application route or real race prediction.
const horses = Array.from({length:18},(_,i)=>({number:i+1,name:`テスト馬${i+1}`,gate:Math.min(8,Math.floor(i/2)+1),style:["逃げ","先行","好位","差し","追込"][Math.min(4,Math.floor(i/4))],mapPositions:i===17?[]:[`${Math.max(1,i-2)}-${Math.max(1,i-1)}-${i+1}-${Math.max(1,i)}`,`${i+1}-${i+1}-${Math.max(1,i-1)}-${Math.max(1,i-2)}`],firstSuitability:100-i*4}));
createRoot(document.getElementById("root")!).render(<main style={{maxWidth:1100,margin:"0 auto",padding:12}}><p style={{color:"#fbbf24",marginBottom:12}}>表示検証用の架空データ</p><RaceFormationMap horses={horses} title="中山 11R" course="ダート右1800m" raceId="2606040911" pace="平均〜やや速い" /></main>);
