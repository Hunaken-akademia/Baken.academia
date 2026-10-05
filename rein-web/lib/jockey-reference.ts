export type JockeyCounts = [number, number, number, number]; // starts, wins, top2, top3
export type JockeyProfile = { name: string; groups: Record<string, Record<string, JockeyCounts>> };
export type JockeyReference = { meta: {league: string; dateFrom:string; dateTo:string; starts:number; races:number; jockeys:number; definition:string}; jockeys:Record<string,JockeyProfile> };
export type JockeyResponse = {meta:JockeyReference['meta'];profiles:Record<string,JockeyProfile|null>};
export const JOCKEY_GROUPS = [
 ['venue','競馬場'],['surface','芝・ダート'],['distance','距離'],['turn','右・左回り'],['gate','枠'],['venueSurface','競馬場 × 芝ダート'],['venueDistance','競馬場 × 芝ダート × 距離'],
] as const;
export function jockeyPercent(counts:JockeyCounts|undefined,index:1|2|3){return counts?.[0]?counts[index]/counts[0]*100:null;}
export function jockeyInterval(counts:JockeyCounts|undefined,index:1|2|3=3){
 if(!counts?.[0])return null;const n=counts[0],p=counts[index]/n,z=1.96,mid=(p+z*z/(2*n))/(1+z*z/n),half=z*Math.sqrt((p*(1-p)+z*z/(4*n))/n)/(1+z*z/n);
 return [Math.max(0,mid-half)*100,Math.min(1,mid+half)*100];
}
export function jockeyContext(title:string,course:string,gate?:number){
 const venue=title.match(/札幌|函館|福島|新潟|東京|中山|中京|京都|阪神|小倉|盛岡|水沢|浦和|船橋|大井|川崎|金沢|笠松|名古屋|園田|姫路|高知|佐賀|門別/)?.[0]??'';
 const surface=course.match(/ダート|芝/)?.[0]??'',distance=course.match(/(\d{3,4})\s*m/)?.[1]??'';
 const turn=/左/.test(course)?'左回り':/右/.test(course)?'右回り':/直線/.test(course)?'直線':'';
 const gateBand=gate&&gate<=2?'内枠（1〜2）':gate&&gate<=6?'中枠（3〜6）':gate&&gate<=8?'外枠（7〜8）':'';
 return {venue,surface,distance,turn,gate:gateBand,venueSurface:venue&&surface?`${venue}|${surface}`:'',venueDistance:venue&&surface&&distance?`${venue}|${surface}|${distance}`:''} as Record<string,string>;
}
export function conditionLabel(group:string,key:string){return key.split('|').map(part=>group==='distance'||group==='venueDistance'?/^\d+$/.test(part)?`${part}m`:part:part).join('・');}
export function matchJockey(reference:JockeyReference,id?:string,name?:string){
 if(id){const profile=reference.jockeys[id.replace(/^0+/,'')];if(profile)return profile;}
 const clean=(s:string)=>s.replace(/\s+/g,'');const matches=Object.values(reference.jockeys).filter(p=>name&&clean(p.name)===clean(name));return matches.length===1?matches[0]:null;
}
