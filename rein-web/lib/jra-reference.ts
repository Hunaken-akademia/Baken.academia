type Rate={samples:number;hits:number;rate:number|null};
type Period={races:number;winners:number;favoriteWinner:Rate;top3PopularityWinner:Rate;tenPlusWinner:Rate;frontWinner:Rate};
type Condition={kind:string;key:string;selection:Period;audit:Period};
export type Edition={date:string;year:number;venue:string;grade:string;surface:string;distanceM:number;going:string;fieldSize:number;winnerPopularity:number|null;winnerGate:number|null;winnerFirstCorner:number|null;placedPopularities:number[];placedFirstCorners:number[]};
type GradedRace={key:string;name:string;grades:string[];editions:Edition[]};
export type JraReferenceData={version:string;periods:{selection:string;audit:string};coverage:{dateFrom:string;dateTo:string;races:number;racecourses:number};minimumRacesPerYear:number;conditions:Condition[];gradedRaces:GradedRace[];limitations:string[]};
export type JraRaceReference=ReturnType<typeof jraReferenceForRace>;

const venues=["札幌","函館","福島","新潟","東京","中山","中京","京都","阪神","小倉"];
const pct=(value:number|null|undefined)=>typeof value==="number"?`${(value*100).toFixed(1)}%`:"母数不足";
const rate=(hits:number,samples:number)=>samples?hits/samples:null;
export function jraRaceNameKey(value:string){
  let text=value.normalize("NFKC").replace(/第\s*\d+\s*回/g,"").replace(/[（(]\s*(?:G|JPN)\s*(?:[123]|I{1,3})\s*[)）]/gi,"")
    .replace(/天皇賞[（(](春|秋)[)）]/g,"天皇賞$1").replace(/東京優駿[（(]日本ダービー[)）]/g,"東京優駿").replace(/優駿牝馬[（(]オークス[)）]/g,"優駿牝馬").replace(/[（(][^()（）]*[)）]/g,"");
  text=text.replaceAll("日本ダービー","東京優駿").replaceAll("オークス","優駿牝馬");
  for(const [full,short] of [["アメリカジョッキークラブカップ","AJCC"],["ニュージーランドトロフィー","NZT"],["京王杯スプリングカップ","京王杯SC"],["フューチュリティステークス","FS"],["ジュベナイルフィリーズ","JF"],["ジュベナイルF","JF"],["フィリーズレビュー","FR"],["フューチュリティS","FS"],["アメリカJCC","AJCC"],["ステークス","S"],["カップ","C"]])text=text.replaceAll(full,short);
  return text.replace(/\s+/g,"").trim();
}
export function jraDistanceBand(distanceM:number){return distanceM<1400?"short":distanceM<=1800?"mile":distanceM<=2400?"middle":"long";}
export function jraConditionKey(venue:string,surface:string,distanceM:number,going:string,kind:string){
  const course=`${venue}|${surface}`;
  if(kind==="courseDistance")return `${course}|${jraDistanceBand(distanceM)}`;
  if(kind==="courseGoing")return `${course}|${going||"不明"}`;
  return course;
}
function conditionDetail(entry:Condition|undefined){
  if(!entry)return "この条件は2025年・2026年とも100レース以上という集計基準を満たしていません。類似条件の数字を代用しません。";
  const a=entry.audit,s=entry.selection;
  const front=a.frontWinner.samples?`、最初の通過順位が3番手以内${pct(a.frontWinner.rate)}（通過順あり${a.frontWinner.samples}レース）`:"";
  return `2026年の${a.races.toLocaleString("ja-JP")}レース。勝ち馬に占める割合：1番人気${pct(a.favoriteWinner.rate)}、1〜3番人気${pct(a.top3PopularityWinner.rate)}、10番人気以下${pct(a.tenPlusWinner.rate)}${front}。2025年の1番人気の割合は${pct(s.favoriteWinner.rate)}。`;
}
function gradedTrend(race:GradedRace|undefined,currentYear:number){
  if(!race)return null;
  const editions=race.editions.filter(item=>item.year<currentYear).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,8);
  if(editions.length<5)return null;
  const knownWinners=editions.filter(item=>item.winnerPopularity!==null),front=editions.filter(item=>item.winnerFirstCorner!==null),knownGates=editions.filter(item=>item.winnerGate!==null);
  const favorite=knownWinners.filter(item=>item.winnerPopularity===1).length;
  const top3=knownWinners.filter(item=>(item.winnerPopularity??99)<=3).length;
  const sixPlus=knownWinners.filter(item=>(item.winnerPopularity??0)>=6).length;
  const tenPlusPlaced=editions.filter(item=>item.placedPopularities.some(pop=>pop>=10)).length;
  const frontWins=front.filter(item=>(item.winnerFirstCorner??99)<=3).length;
  const innerWins=knownGates.filter(item=>(item.winnerGate??99)<=4).length;
  const venueChanges=new Set(editions.map(item=>item.venue)).size>1;
  const courseChanges=new Set(editions.map(item=>`${item.venue}|${item.surface}|${item.distanceM}`)).size>1;
  const grade=({G1:"GⅠ",G2:"GⅡ",G3:"GⅢ"} as Record<string,string>)[editions[0].grade]??editions[0].grade;
  return {name:race.name,grade,editions:editions.length,yearFrom:Math.min(...editions.map(e=>e.year)),yearTo:Math.max(...editions.map(e=>e.year)),
    favoriteWinRate:rate(favorite,knownWinners.length),top3PopularityWinRate:rate(top3,knownWinners.length),sixPlusWinRate:rate(sixPlus,knownWinners.length),
    tenPlusPlacedRate:rate(tenPlusPlaced,editions.length),innerGateWinRate:rate(innerWins,knownGates.length),innerGateSamples:knownGates.length,
    frontWinRate:rate(frontWins,front.length),frontSamples:front.length,venueChanges,courseChanges,recent:editions.slice(0,5)};
}
export function jraReferenceForRace(data:JraReferenceData,input:{raceName:string;venue:string;surface:string;distanceM:number;going:string;year:number}){
  if(data.version!=="jra-condition-reference-v1"||!venues.includes(input.venue)||!input.distanceM)return null;
  const kinds=[{kind:"course",label:"競馬場"},{kind:"courseDistance",label:"距離"},{kind:"courseGoing",label:"今回の条件"}];
  const conditions=kinds.map(item=>{const key=jraConditionKey(input.venue,input.surface,input.distanceM,input.going,item.kind);return {...item,key,detail:conditionDetail(data.conditions.find(c=>c.kind===item.kind&&c.key===key))};});
  const graded=gradedTrend(data.gradedRaces.find(r=>r.key===jraRaceNameKey(input.raceName)),input.year);
  return {version:data.version,auditPeriod:data.periods.audit,coverage:data.coverage,conditions,graded,
    validation:{summary:"追加候補4種（左右回り適性・道悪適性・馬場状態適性・近3走上がり）は、2025年の安定性と2026年の確認を1〜3着すべてでは満たさず、追加補正は見送り。条件別の数字は傾向表示に使用します。",note:"現行の競馬場・距離・馬場履歴は既存評価内で継続。表示値は確定人気による事後集計で、今回の的中確率・回収率ではありません。"}};
}
