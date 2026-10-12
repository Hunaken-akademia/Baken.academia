import type { TrendBet, TrendQuote, TrendRunner } from "./odds-trends";
export const oddsText=(s:string)=>s.replace(/<script[\s\S]*?<\/script>/gi,"").replace(/<[^>]*>/g," ").replace(/&nbsp;|&#160;/g," ").replace(/&amp;/g,"&").replace(/\s+/g," ").trim().normalize("NFKC");
const cells=(s:string)=>[...s.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m=>oddsText(m[1]));
const rows=(s:string)=>[...s.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m=>m[1]);
const scalar=(s:string)=>/^\d+(?:\.\d+)?$/.test(s.replaceAll(",",""))&&Number(s.replaceAll(",",""))>=1?Number(s.replaceAll(",","")):null;
function add(book:Map<string,TrendQuote>,numbers:number[],odds:number|null) {
  if(odds===null||!Number.isFinite(odds)||numbers.some(n=>!Number.isInteger(n)||n<1||n>18))return;
  const key=numbers.join("-"),old=book.get(key);if(old&&old.odds!==odds)throw new Error("Conflicting market prices");book.set(key,{numbers,odds});
}
export function parseYahooMarket(source:string,bet:TrendBet,raceId:string):TrendQuote[] {
  const canonical=[...source.matchAll(/<meta\b[^>]*>/gi)].find(m=>/property=["']og:url["']/i.test(m[0]))?.[0].match(/content=["']([^"']+)["']/i)?.[1];
  if(!canonical||new URL(canonical.replaceAll("&amp;","&")).pathname.split("/").at(-1)!==raceId)throw new Error("Market race mismatch");
  const book=new Map<string,TrendQuote>();
  for(const table of source.matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi)) {
    if(bet==="win") {
      if(!/hr-tableValue/.test(table[1])||!table[2].includes("単勝"))continue;
      for(const row of rows(table[2])) {const c=cells(row);if(c.length===5&&/^\d+$/.test(c[1]))add(book,[Number(c[1])],scalar(c[3]));}
    }else{
      if(!/hr-tableLeftTop--oddsW/.test(table[1]))continue;
      const heading=oddsText(table[2].match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/i)?.[1]??"");
      if(!/^\d+(?:[-－]\d+)?$/.test(heading))continue;
      const prefix=heading.match(/\d+/g)!.map(Number);if(prefix.length!==(bet==="trio"?2:1))continue;
      const body=table[2].match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i)?.[1]??"";
      for(const row of rows(body)){const c=cells(row);if(c.length===2&&/^\d+$/.test(c[0]))add(book,[...prefix,Number(c[0])].sort((a,b)=>a-b),scalar(c[1]));}
    }
  }
  return [...book.values()];
}
export function parseNarQuinella(source:string,raceId:string):TrendQuote[] {
  const date=`${raceId.slice(0,4)}年${Number(raceId.slice(4,6))}月${Number(raceId.slice(6,8))}日`,number=Number(raceId.slice(10));
  const heading=oddsText(source.match(/<h4\b[^>]*>([\s\S]*?)<\/h4>/i)?.[1]??"").replace(/\s/g,"");
  if(raceId.slice(8,10)!=="03"||!heading.startsWith(date)||!heading.includes(`帯広第${number}競走`))throw new Error("NAR market race mismatch");
  const book=new Map<string,TrendQuote>();
  for(const table of source.matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi)) {
    if(!/odd_ranking_table/.test(table[1]))continue;
    for(const row of rows(table[2])){const c=cells(row);if(c.length>=2&&/^\d+[-－]\d+$/.test(c[0]))add(book,c[0].match(/\d+/g)!.map(Number).sort((a,b)=>a-b),scalar(c[1]));}
  }
  return [...book.values()];
}
export function marketIsComplete(quotes:TrendQuote[],bet:TrendBet,horses:TrendRunner[]) {
  if(horses.length<3||new Set(horses.map(h=>h.number)).size!==horses.length)return false;
  const numbers=new Set(horses.map(h=>h.number)),legal=new Set<string>();
  if(bet==="win"){for(const n of numbers)legal.add(String(n));}
  else if(bet==="bracket_quinella"){
    if(horses.some(h=>!h.gate||!Number.isInteger(h.gate)||h.gate<1||h.gate>8))return false;
    for(const a of horses)for(const b of horses)if(a.number!==b.number)legal.add([a.gate!,b.gate!].sort((x,y)=>x-y).join("-"));
  }else {
    const ns=[...numbers].sort((a,b)=>a-b);
    for(let i=0;i<ns.length;i++)for(let j=i+1;j<ns.length;j++)if(bet==="trio"){
      for(let k=j+1;k<ns.length;k++)legal.add([ns[i],ns[j],ns[k]].join("-"));
    }else legal.add([ns[i],ns[j]].join("-"));
  }
  const got=new Set(quotes.map(q=>q.numbers.join("-")));
  return got.size===quotes.length&&got.size===legal.size&&[...got].every(k=>legal.has(k))&&quotes.every(q=>Number.isFinite(q.odds)&&q.odds>=1);
}
