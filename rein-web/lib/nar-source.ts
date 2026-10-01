// NAR pages have nested tables. Split on runner blocks, not arbitrary <tr>s.
export const NAR_COURSES: Record<string, string> = {"03":"帯広","10":"盛岡","11":"水沢","18":"浦和","19":"船橋","20":"大井","21":"川崎","22":"金沢","23":"笠松","24":"名古屋","27":"園田","28":"姫路","31":"高知","32":"佐賀","36":"門別"};
export const narText = (s: string) => s.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g," ").replace(/&nbsp;|&#160;/g," ").replace(/&amp;/g,"&").replace(/\s+/g," ").trim();
const contents = (html: string, tag: string, cls: string) => [...html.matchAll(new RegExp(`<${tag}\\b[^>]*class=["'][^"']*\\b${cls}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/${tag}>`,"gi"))].map(m=>m[1]);
const cell = (html: string, cls: string) => narText(contents(html,"td",cls)[0] ?? "");
const idFrom = (html: string, key: string) => html.match(new RegExp(`${key}=(\\d+)`))?.[1] ?? "";
const finite = (value: string) => value.trim() && Number.isFinite(Number(value)) ? Number(value) : null;
export function narRaceKey(id: string) {
  if (!/^20\d{10}$/.test(id)) return null;
  const date = `${id.slice(0,4)}-${id.slice(4,6)}-${id.slice(6,8)}`, code = id.slice(8,10), number = Number(id.slice(10));
  if (!NAR_COURSES[code] || number < 1 || number > 12 || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date) return null;
  return {date, code, number, venue:NAR_COURSES[code]};
}
export function narUrl(page: "TodayRaceInfoTop" | "RaceList" | "DebaTable" | "RaceMarkTable", date: string, code?: string, number?: number) {
  const q = new URLSearchParams({k_raceDate:date.replaceAll("-","/")});
  if (code) q.set("k_babaCode",String(Number(code)));
  if (number) q.set("k_raceNo",String(number));
  return `https://www.keiba.go.jp/KeibaWeb/TodayRaceInfo/${page}?${q}`;
}
export function narVenueCodes(html: string, date: string) {
  if (!html.includes('TodayRaceInfo') || /<title>エラー/.test(html)) throw new Error("地方開催情報を確認できません");
  const codes = new Set<string>();
  for (const match of html.matchAll(/href=["']([^"']*\/RaceList\?[^"']+)["']/g)) {
    const url = new URL(match[1].replaceAll("&amp;","&"),"https://www.keiba.go.jp");
    if (url.searchParams.get("k_raceDate")?.replaceAll("/","-") !== date) continue;
    const code = (url.searchParams.get("k_babaCode") ?? "").padStart(2,"0");
    if (NAR_COURSES[code]) codes.add(code);
  }
  if (!codes.size && !narText(html).includes(`${Number(date.slice(5,7))}月${Number(date.slice(8))}日`)) throw new Error("対象日の地方開催情報が未確認です");
  return [...codes];
}
export function parseNarSchedule(html: string, date: string, code: string) {
  const races = contents(html,"tr","data").flatMap(row=>{
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m=>narText(m[1]));
    const number = Number(cells[0]?.match(/^(\d+)R/)?.[1]);
    if (!number || number > 12 || !/\d{1,2}:\d{2}/.test(cells[1] ?? "")) return [];
    return [{number,start:cells[1].match(/\d{1,2}:\d{2}/)![0].padStart(5,"0"),raceId:date.replaceAll("-","")+code+String(number).padStart(2,"0"),title:cells[4],course:cells[5],status:row.includes('/RaceMarkTable?')?"確定" as const:"発売前" as const}];
  });
  if (!races.length) throw new Error(`${NAR_COURSES[code]}の出走予定は未発表です`);
  return {name:NAR_COURSES[code],eventId:date.replaceAll("-","")+code,nextRace:1,nextStart:races[0].start,races};
}
export type NarHorse = {
  horseId:string; number:number; gate:number; name:string; jockeyId:string; trainerId:string;
  jockey:string; trainer:string; odds:number|null; popularity:number; weight?:number; weightChange?:number;
  age?:number; sex?:string; weightCarried?:number; style:string; earlyPosition:number|null;
  recentPositions:string[]; mapPositions:string[]; pastCorners:number[];
};
function raceHeading(html: string, raceId: string) {
  const key = narRaceKey(raceId); if (!key) throw new Error("Invalid NAR race");
  const heading = narText(html.match(/<h4>\s*(\d{4}年[\s\S]*?)<\/h4>/)?.[1] ?? "");
  const compact = heading.replace(/\s/g, "");
  const date = `${key.date.slice(0,4)}年${Number(key.date.slice(5,7))}月${Number(key.date.slice(8))}日`;
  if (!compact.startsWith(date) || !compact.includes(`${key.venue}第${key.number}競走`)) throw new Error("対象レースの情報を確認できません");
  return heading;
}
export function parseNarCard(html: string, raceId: string) {
  const key = narRaceKey(raceId); if (!key) throw new Error("Invalid NAR race");
  const heading = raceHeading(html, raceId);
  const start = heading.match(/(\d{1,2}:\d{2})発走/)?.[1]?.padStart(5,"0");
  if (!start) throw new Error("発走時刻を確認できません");
  const titleBlock = contents(html,"section","raceTitle")[0] ?? "";
  const raceName = narText(titleBlock.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1] ?? "");
  const condition = narText(contents(titleBlock,"ul","dataArea")[0] ?? "").split("賞金")[0];
  const distance = Number(condition.match(/(\d+)\s*ｍ/)?.[1]);
  const surface = key.code === "03" ? "ばんえい" : condition.includes("芝") ? "芝" : "ダート";
  const course = `${surface}${distance}m ${condition.match(/ｍ（([^）]+)）/)?.[1] ?? ""}`;
  const going = condition.match(/馬場[：:]\s*(良|稍重|重|不良)/)?.[1] ?? "未発表";
  const table = contents(html,"section","cardTable")[0] ?? "";
  const blocks = table.split(/<tr\s+class=["']tBorder["'][^>]*>/i).slice(1);
  const horses:NarHorse[] = [], scratched:Array<{number:number;name:string}> = [];
  let gate = 0;
  for (const block of blocks) {
    const number = Number(cell(block,"horseNum"));
    const name = narText(contents(block,"a","horseName")[0] ?? "");
    if (!number || !name) continue;
    gate = Number(cell(block,"courseNum")) || gate;
    const info = cell(block,"info");
    if (/取消|除外/.test(info)) { scratched.push({number,name}); continue; }
    const markets = contents(block,"td","odds_weight").map(narText);
    const odds = finite(markets[0]?.match(/^([\d.]+)\s*\(/)?.[1] ?? "");
    const popularity = Number(markets[0]?.match(/\((\d+)人気\)/)?.[1] ?? 0);
    // First-time starters have no previous weight, so NAR publishes only the
    // current value (for example "447") without a parenthesized change.
    const weight = markets[1]?.match(/^(\d+)(?:\s*\(([+-]?\d+)\))?$/);
    const age = narText(block).match(/(せん|セン|牡|牝)\s*(\d+)/);
    // Only the past-race timing cells contain time + passing order + final 3f.
    const positions = [...block.matchAll(/\d+:\d{2}\.\d\s*[　\s]+(\d{1,2}(?:-\d{1,2}){1,3})\s*[　\s]+\d+\.\d/g)].map(m=>m[1]).slice(0,5);
    const early = positions.length ? positions.reduce((s,p,i)=>s+Number(p.split("-")[0])*(5-i),0)/positions.reduce((s,_,i)=>s+5-i,0) : null;
    const weightCarried = narText(block).match(/(?:生|毛)\s+(\d{2,3}\.\d)\s+/)?.[1];
    horses.push({horseId:idFrom(block,"k_lineageLoginCode"),number,gate,name,jockeyId:idFrom(block,"k_riderLicenseNo"),trainerId:idFrom(block,"k_trainerLicenseNo"),jockey:narText(contents(block,"a","jockeyName")[0] ?? "").split("（")[0],trainer:narText(block.match(/<a[^>]*href=["'][^"']*TrainerMark[^"']*["'][^>]*>([\s\S]*?)<\/a>/)?.[1] ?? ""),odds,popularity,...(weight?{weight:Number(weight[1]),...(weight[2]!==undefined?{weightChange:Number(weight[2])}:{})}:{}),...(age?{sex:age[1],age:Number(age[2])}:{}),...(weightCarried?{weightCarried:Number(weightCarried)}:{}),style:early===null?"不明":early<=2?"逃げ":early<=4?"先行":early<=6?"好位":early<=9?"差し":"追込",earlyPosition:early,recentPositions:positions,mapPositions:positions,pastCorners:positions.map(p=>p.split("-").length)});
  }
  if (!horses.length || new Set(horses.map(h=>h.number)).size!==horses.length || horses.some(h=>h.gate<1||h.gate>8)) throw new Error("地方出走表を安全に読み取れませんでした");
  return {race:{raceId,title:`${key.venue} ${key.number}R ${raceName}`,course,condition:going,start,startsAt:Date.parse(`${key.date}T${start}:00+09:00`),updated:"",league:"nar" as const},horses,scratched,context:{racecourse:key.venue,surface,distanceM:distance,going,code:key.code,date:key.date}};
}
export function parseNarResult(html: string, raceId?: string) {
  const grade = contents(html,"section","gradeTable")[0] ?? "";
  const rows = contents(grade,"tr","tBorder").map(row=>({number:Number(cell(row,"c")),finish:Number(cell(row,"a")),status:cell(row,"a"),name:cell(row,"horseName"),odds:Number(cell(row,"p")),popularity:Number(cell(row,"o"))})).filter(r=>r.number>0);
  if (rows.length && raceId) raceHeading(html, raceId);
  const finishers = rows.filter(r=>r.finish>0).sort((a,b)=>a.finish-b.finish);
  const scratched = rows.filter(r=>/取消|除外/.test(r.status)).map(r=>r.number);
  let type = "";
  const payouts = [...(contents(html,"div","twoRefundTable")[0] ?? "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].flatMap(m=>{
    const rawType = cell(m[1],"title"); if (rawType) type = ({"馬連複":"馬連","馬連単":"馬単","三連複":"三連複","三連単":"三連単"} as Record<string,string>)[rawType] ?? rawType;
    const payout = Number(cell(m[1],"refundMoney").replace(/[,円]/g,""));
    const selection = cell(m[1],"a") || cell(m[1],"d");
    return type && payout && selection ? [{type,selection,payout,popularity:Number(cell(m[1],"c").replace("人気",""))||null}] : [];
  });
  return {isFinished:finishers.some(h=>h.finish===1)&&payouts.length>0,finishers,payouts,scratched};
}
