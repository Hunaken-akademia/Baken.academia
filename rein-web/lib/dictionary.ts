export type DictionaryLeague = 'jra' | 'nar';
export type DictionaryKind = 'horse' | 'jockey' | 'trainer' | 'course' | 'graded';
export type DictionaryCounts = [number, number, number, number];
export type DictionaryEntry = {id:string;kind:DictionaryKind;league:DictionaryLeague;name:string;counts:DictionaryCounts;from:string;to:string;grade?:string;editionCount?:number};
export type DictionaryEdition = {date:string;venue:string;surface:string;distanceM:number;going:string;grade:string;officialName?:string;fieldSize:number;winnerNames?:string[];winnerPopularities:number[];winnerGates:number[];placedPopularities:number[];sourceUrl?:string};
export type DictionaryProfile = DictionaryEntry & {recentCounts:DictionaryCounts;groups:Record<string,Record<string,DictionaryCounts>>;recent?:{date:string;race:string;course:string;finish:number|null;status:string;jockey:string;trainer:string}[];editions?:DictionaryEdition[];conditionChanges?:boolean};
export type DictionaryMeta = {version:string;league:DictionaryLeague;dateFrom:string;dateTo:string;races:number;starts:number;generatedAt:string;source:string;sourceUrl:string;definition:string;entities:Record<DictionaryKind,number>;coverage:Record<string,{races:number;starts:number}>};
export type DictionaryIndex = {meta:DictionaryMeta;entries:Record<DictionaryKind,DictionaryEntry[]>};
export type DictionarySearch = {meta:DictionaryMeta;entries:DictionaryEntry[];total:number;offset:number;limit:number};
export const DICTIONARY_KINDS: [DictionaryKind,string][] = [['horse','馬'],['jockey','騎手'],['trainer','厩舎'],['graded','重賞・グレード'],['course','コース']];
export const DICTIONARY_GROUPS: Record<string,string> = {venue:'競馬場',surface:'芝・ダート・障害',distance:'距離',going:'馬場状態',turn:'右・左回り',gate:'枠番',venueDistance:'競馬場 × コース × 距離',season:'季節',year:'年別',popularity:'確定人気',position:'過去の位置取り',interval:'レース間隔',jockeyPair:'馬・厩舎 × 騎手',trainerPair:'馬・騎手 × 厩舎'};
export const DICTIONARY_COURSE_GROUPS = ['gate','popularity','position','going','season','year'];
export function dictionaryCourseSubject(group:string,key:string){
  if(group==='gate')return key==='不明'?'枠不明の馬':`${dictionaryLabel(group,key)}の馬`;
  if(group==='popularity')return key==='不明'?'人気不明の馬':`${key}の馬`;
  if(group==='position')return key==='記録なし'?'位置取り不明の馬':`最初のコーナーで${key}の馬`;
  if(group==='going')return key==='不明'?'馬場状態不明の出走馬':`${key}馬場の出走馬`;
  return `${key}${group==='year'?'年':''}の出走馬`;
}
export function dictionaryRate(counts:DictionaryCounts|undefined,index:1|2|3=3){return counts?.[0]?counts[index]/counts[0]*100:null;}
export function dictionaryInterval(c:DictionaryCounts,index:1|2|3=3){if(!c[0])return null;const n=c[0],p=c[index]/n,z=1.96,k=1+z*z/n,m=(p+z*z/(2*n))/k,h=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/k;return [Math.max(0,m-h)*100,Math.min(1,m+h)*100];}
export function dictionaryNormalize(s:string){return s.normalize('NFKC').toLowerCase().replace(/\s+/g,'').replace(/[ぁ-ゖ]/g,c=>String.fromCharCode(c.charCodeAt(0)+0x60));}
export function dictionaryLabel(group:string,key:string){return key.split('|').map(s=>(group==='distance'||group==='venueDistance')&&/^\d+$/.test(s)?`${s}m`:group==='gate'&&/^\d+$/.test(s)?`${s}枠`:s).join('・');}
export function dictionarySort(a:DictionaryEntry,b:DictionaryEntry,sort:string){
  const value=(e:DictionaryEntry)=>sort==='recent'?Number(e.to.replaceAll('-','')):sort==='win'?dictionaryRate(e.counts,1)??-1:sort==='top3'?dictionaryRate(e.counts)??-1:sort==='wins'?e.counts[1]:e.kind==='graded'?e.editionCount??0:e.counts[0];
  return value(b)-value(a)||b.counts[0]-a.counts[0]||a.name.localeCompare(b.name,'ja')||a.id.localeCompare(b.id);
}
export function searchDictionary(index:DictionaryIndex,options:{kind:DictionaryKind;query?:string;minimum?:number;sort?:string;offset?:number;limit?:number}):DictionarySearch{
  const query=dictionaryNormalize(options.query??'');
  const entries=index.entries[options.kind].filter(e=>e.counts[0]>=(options.minimum??0)&&(!query||dictionaryNormalize(`${e.name} ${e.id} ${e.grade??''}`).includes(query))).slice().sort((a,b)=>dictionarySort(a,b,options.sort??'recent'));
  const offset=Math.max(0,Math.floor(options.offset??0)),limit=Math.max(1,Math.min(50,Math.floor(options.limit??30)));
  return {meta:index.meta,entries:entries.slice(offset,offset+limit),total:entries.length,offset,limit};
}
export function dictionaryHighlights(p:DictionaryProfile){
  const base=dictionaryRate(p.counts);if(base===null||p.kind==='graded'||p.kind==='course')return [];
  const minimum=p.kind==='horse'?5:30;
  return ['venue','surface','distance','going','turn'].flatMap(group=>Object.entries(p.groups[group]??{}).flatMap(([key,c])=>{
    const value=dictionaryRate(c);if(c[0]<minimum||c[0]===p.counts[0]||key==='不明'||value===null||value<base+8)return [];
    return [{group,key,counts:c,lift:value-base}];
  })).sort((a,b)=>b.lift-a.lift||b.counts[0]-a.counts[0]).slice(0,2);
}
export function editionTrends(editions:DictionaryEdition[]){
  const known=editions.filter(e=>e.winnerPopularities.length),gates=editions.filter(e=>e.winnerGates.length);
  return [
    {label:'1番人気が勝利',hits:known.filter(e=>e.winnerPopularities.includes(1)).length,n:known.length},
    {label:'1〜3番人気が勝利',hits:known.filter(e=>e.winnerPopularities.some(n=>n<=3)).length,n:known.length},
    {label:'6番人気以下が勝利',hits:known.filter(e=>e.winnerPopularities.some(n=>n>=6)).length,n:known.length},
    {label:'1〜4枠が勝利',hits:gates.filter(e=>e.winnerGates.some(n=>n<=4)).length,n:gates.length},
  ];
}
