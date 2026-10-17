import catalog from "./odds-trend-catalog.json";

export type TrendBet = "win" | "bracket_quinella" | "quinella" | "trio";
export type TrendQuote = { numbers: number[]; odds: number };
export type TrendRunner = { number: number; gate?: number; odds: number | null; name?: string };
export type TrendRace = { raceId: string; title: string; course: string; condition: string; startsAt?: number | null; league?: "jra" | "nar"; context?: { ageType?: string }; dataTimes?: { odds?: string | null; card?: string | null } };
export type TrendRule = { id: string; league: "jra" | "nar"; bet: TrendBet; policy: string; conditions: Record<string,string>; evidence?: { experimental: boolean; exclusionUnit: "race"; strictPass: boolean }; annual?: Array<{ year: string; races: number; roi: number }>; overall: { races: number; roi: number; race_hit_rate: number; points_per_race: number }; periods: Array<{ label: string; races: number; roi: number; roi_without_largest_ticket: number; date_from: string; date_to: string }> };
export type TrendItem = { ruleId: string; state: "ready" | "waiting" | "no-tickets" | "no-prestart"; selections: TrendQuote[]; fetchedAt: string | null; note?: string; saved?: boolean; settlement?: { status: string; returnYen: number | null } };
export type OddsTrendData = { raceId: string; version: string; phase: "provisional" | "saved-prestart" | "historical"; generatedAt: string; startsAt?: number | null; items: TrendItem[]; error?: string };
export const TREND_VERSION = catalog.version;
export const TREND_RULES:TrendRule[] = catalog.rules.map(rule=>({...rule,league:rule.league as "jra"|"nar",bet:rule.bet as TrendBet,evidence:rule.evidence?.exclusionUnit==="race"?{...rule.evidence,exclusionUnit:"race" as const}:undefined,conditions:Object.fromEntries(Object.entries(rule.conditions).filter(([,value])=>typeof value==="string"))}));
export const TREND_BET_LABELS: Record<TrendBet,string> = { win:"単勝", bracket_quinella:"枠連", quinella:"馬連", trio:"3連複" };

export function validTrendRaceId(id: string, league: "jra" | "nar") {
  return league === "jra" ? /^\d{8}(?:0[1-9]|1[0-2])$/.test(id) : /^20\d{8}(?:0[1-9]|1[0-2])$/.test(id);
}
export function ageTypeFromText(text: string) {
  const m=text.normalize("NFKC").match(/([234])歳(以上)?\s*(?:新馬|未勝利|[123]勝クラス|オープン|\()/);
  return m ? `${m[1]}歳${m[2]?"以上":"限定"}` : undefined;
}
export function ruleMatches(rule: TrendRule, race: TrendRace, horses: TrendRunner[], quotes?: TrendQuote[]): boolean | null {
  const league=race.league ?? (race.raceId.length===12?"nar":"jra");
  if(rule.league!==league)return false;
  const title=race.title.normalize("NFKC"),course=race.course.normalize("NFKC");
  const venue=title.match(/^(札幌|函館|福島|新潟|東京|中山|中京|京都|阪神|小倉|帯広)/)?.[1];
  let unknown=false;
  const win=horses.map(h=>h.odds).filter((v):v is number=>typeof v==="number"&&Number.isFinite(v)&&v>=1).sort((a,b)=>a-b);
  for(const [key,value] of Object.entries(rule.conditions)) {
    if(key==="venue"&&venue!==value)return false;
    if(key==="going"&&race.condition!==value)return false;
    if(key==="surface") {
      const surface=course.includes("障害")?"障害":course.includes("ダート")?"ダート":course.includes("芝")?"芝":undefined;
      if(!surface){unknown=true;continue;}if(surface!==value)return false;
    }
    if(key==="distance_band") {const d=Number(course.match(/(\d{3,4})\s*m/i)?.[1]);if(!d){unknown=true;continue;}if(d<1401||d>1800)return false;}
    if(key==="class") {if(/J[・.]?G/.test(title)||!/(?:^|\W)G(?:II|2)(?:\W|$)/.test(title))return false;}
    if(key==="age_type") {const age=race.context?.ageType??ageTypeFromText(title);if(!age){unknown=true;continue;}if(age!==value)return false;}
    if(key==="favorite_band"||key==="favorite_gap") {
      if(win.length!==horses.length||win.length<3){unknown=true;continue;}
      if(key==="favorite_band"&&(win[0]<3||win[0]>=3.6))return false;
      if(key==="favorite_gap"&&win[1]/win[0]>=1.3)return false;
    }
    if(key==="ticket_front_gap") {
      if(!quotes||quotes.length<3){unknown=true;continue;}
      const q=[...quotes].sort(compareQuotes);const gap=(q[1].odds+q[2].odds)/2/q[0].odds;
      if(gap<1.7||gap>=2.5)return false;
    }
  }
  return unknown?null:true;
}
export function compareQuotes(a:TrendQuote,b:TrendQuote) {return a.odds-b.odds||a.numbers.reduce((v,n,i)=>v||(n-(b.numbers[i]??0)),0);}
export function selectionProbability(horses:TrendRunner[],bet:TrendBet,selection:number[]) {
  if(horses.some(h=>h.odds===null||!Number.isFinite(h.odds)||h.odds!<1))return null;
  const total=horses.reduce((s,h)=>s+1/h.odds!,0),p=new Map(horses.map(h=>[h.number,1/h.odds!/total]));
  const ordered=(a:number,b:number,c?:number)=>{const x=p.get(a)??0,y=p.get(b)??0,z=c===undefined?0:p.get(c)??0;return c===undefined?x*y/(1-x):x*y/(1-x)*z/(1-x-y);};
  if(bet==="win")return p.get(selection[0])??null;
  if(bet==="quinella")return ordered(selection[0],selection[1])+ordered(selection[1],selection[0]);
  if(bet==="bracket_quinella") {
    if(horses.some(h=>!h.gate||h.gate<1||h.gate>8))return null;
    let out=0;for(const a of horses)for(const b of horses){if(a.number===b.number)continue;if((a.gate===selection[0]&&b.gate===selection[1])||(selection[0]!==selection[1]&&a.gate===selection[1]&&b.gate===selection[0]))out+=ordered(a.number,b.number);}return out;
  }
  const [a,b,c]=selection;return ordered(a,b,c)+ordered(a,c,b)+ordered(b,a,c)+ordered(b,c,a)+ordered(c,a,b)+ordered(c,b,a);
}
export function selectTrendTickets(rule:TrendRule,horses:TrendRunner[],quotes:TrendQuote[]) {
  const band=rule.policy.match(/^オッズ([\d.]+)〜([\d.]+)未満/),ev=rule.policy.match(/EV([\d.]+)以上/);
  return [...quotes].sort(compareQuotes).filter(q=>{
    if(band)return q.odds>=Number(band[1])&&q.odds<Number(band[2]);
    const probability=selectionProbability(horses,rule.bet,q.numbers);
    return !!ev&&probability!==null&&q.odds<=100&&q.odds*probability>=Number(ev[1]);
  }).slice(0,3);
}
export function ruleDescription(rule:TrendRule) {
  const names:Record<string,string>={going:"馬場",venue:"競馬場",surface:"コース",distance_band:"距離",favorite_band:"1番人気の単勝",favorite_gap:"単勝上位の開き",class:"クラス",age_type:"年齢条件",ticket_front_gap:"券種上位の開き"};
  return Object.entries(rule.conditions).map(([k,v])=>`${names[k]??k}：${v==="G2"?"GII":v}${k==="distance_band"?"m":k==="favorite_band"?"倍":""}`).join("・");
}
