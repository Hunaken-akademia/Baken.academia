"use client";
import { useEffect,useState } from 'react';
type Count={starts:number;top3:number;wins:number;races:number;days:number};
type Row={factor:string;label:string;near:Count;other:Count;years:Array<{year:string;near:Count;other:Count}>};
type Profile={minimum:number;maximum:number;date_from:string;date_to:string;near:Count;other:Count;rows:Row[]};
const pct=(n:number,d:number)=>d?`${(100*n/d).toFixed(1)}%`:'—';
const label=(s:string)=>(({front:'前目',middle:'中団',rear:'後方'} as Record<string,string>)[s]??s);
export function CushionComparison({venue,date,distance,value}:{venue:string;date:string;distance:number;value:number}){
 const key=`${venue}:${date}:${distance}:${value}`;
 const [state,setState]=useState<{key:string;profile?:Profile|null;error?:boolean}>({key:''});
 useEffect(()=>{const c=new AbortController();fetch('/api/races/cushion-comparison?'+new URLSearchParams({venue,date,distance:String(distance),value:String(value)}),{signal:c.signal}).then(async r=>{if(!r.ok)throw Error();return r.json();}).then(b=>{if(!c.signal.aborted)setState({key,profile:b.profile});}).catch(()=>{if(!c.signal.aborted)setState({key,error:true});});return()=>c.abort();},[key,venue,date,distance,value]);
 const p=state.key===key?state.profile:undefined;
 return <div aria-label="近いクッション値の過去成績比較" className="mt-3 rounded-xl border border-cyan-300/30 p-3 text-xs leading-5">
 <h3 className="font-bold text-cyan-100">{venue}・芝{distance}m：近いクッション値での実績</h3>
 {!p?<p className="mt-2">{state.key===key&&state.error?'比較データを取得できませんでした。':p===null?'対象日より前に集計を終えた比較データはありません。':'比較データを確認中…'}</p>:<>
 <p className="mt-2">比較範囲 {p.minimum.toFixed(1)}〜{p.maximum.toFixed(1)} ／ 範囲内 {p.near.races}レース・{p.near.days}日 ／ 範囲外 {p.other.races}レース・{p.other.days}日</p>
 <p className="text-slate-400">{p.date_from}〜{p.date_to}の取得済み結果。同じ競馬場・同じ距離で比較。</p>
 {['gate_group','prior_style','pop_group'].map(f=><details key={f} open={f==='gate_group'} className="mt-3"><summary className="min-h-11 cursor-pointer py-2 font-bold">{({gate_group:'枠別',prior_style:'過去の位置取り別',pop_group:'結果掲載人気別'} as Record<string,string>)[f]}の比較</summary><div className="overflow-x-auto" data-no-swipe><table className="w-full min-w-[300px] text-right"><thead><tr><th className="text-left">条件</th><th>範囲内<br/>勝率／3着内率</th><th>範囲外<br/>勝率／3着内率</th><th>3着内率差</th></tr></thead><tbody>{p.rows.filter(r=>r.factor===f).map(r=><tr key={r.label} className="border-t border-slate-700"><th className="py-2 text-left">{label(r.label)}</th><td>{pct(r.near.wins,r.near.starts)}／{pct(r.near.top3,r.near.starts)}<br/><span className="text-slate-400">{r.near.top3}/{r.near.starts}走</span></td><td>{pct(r.other.wins,r.other.starts)}／{pct(r.other.top3,r.other.starts)}<br/><span className="text-slate-400">{r.other.top3}/{r.other.starts}走</span></td><td>{r.near.starts&&r.other.starts?`${(100*(r.near.top3/r.near.starts-r.other.top3/r.other.starts)).toFixed(1)}pt`:'—'}</td></tr>)}</tbody></table></div></details>)}
 <details className="mt-2"><summary className="min-h-11 cursor-pointer py-2 text-cyan-200">年別の3着内率を確認</summary>{p.rows.map(r=><p key={r.factor+r.label} className="my-2"><strong>{label(r.label)}</strong>：{r.years.map(y=>`${y.year}年 ${pct(y.near.top3,y.near.starts)}（${y.near.starts}走）／範囲外 ${pct(y.other.top3,y.other.starts)}（${y.other.starts}走）`).join(' ・ ')}</p>)}</details>
 {(p.near.days<10||p.other.days<10)&&<p className="text-amber-200">開催日数が少ない比較です。少数日の結果に偏る可能性があります。</p>}
 <p className="mt-2 text-slate-400">差は過去の観測値。季節・馬場状態・人気構成は未調整のため、クッション値の効果とは限りません。位置取りは前日以前の近5走・180日以内（2走以上）から分類し、分類不能馬は除外。人気は結果掲載時点です。予想には加点しません。</p>
 </>}
 </div>;
}
