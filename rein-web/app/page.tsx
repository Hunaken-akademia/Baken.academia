"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, ArrowLeft, ChevronRight, Clock3, Gauge, RefreshCw, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Horse = { number:number; gate?:number; name:string; score:number; odds:number; popularity:number; mark:string; style:string; verdict:string; historyAdjustment?:number; historySamples?:number; positives:string[]; cautions:string[] };
type TicketTier = { group:"本線"|"対抗"|"穴"; points:number; selections:string[] };
type Ticket = { type:string; tiers:TicketTier[] };
type Analysis = {
  race:{title:string;course:string;condition:string;start:string;updated:string;raceId:string};
  model?:{version:string;dateFrom:string;dateTo:string;races:number;runners:number;horses:number;strategy:string};
  pace:{label:string;detail:string;leaders:number[]}; horses:Horse[]; tickets:Ticket[];
};
type Race = { number:number; start:string; raceId:string; title:string; course:string; status:"確定"|"次レース"|"発売前" };
type Venue = { name:string; eventId:string; nextRace:number; nextStart:string; races:Race[] };
type Schedule = { dateLabel:string; updatedAt:string; venues:Venue[] };

const groupStyle={本線:"bg-sky-100 text-sky-800",対抗:"bg-amber-100 text-amber-800",穴:"bg-rose-100 text-rose-800"};

export default function Home(){
  const [schedule,setSchedule]=useState<Schedule|null>(null);
  const [venue,setVenue]=useState<Venue|null>(null);
  const [data,setData]=useState<Analysis|null>(null);
  const [activeHorse,setActiveHorse]=useState<Horse|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const danger=useMemo(()=>data?.horses.find(h=>h.popularity<=3&&h.score<78),[data]);

  async function loadSchedule(){
    setLoading(true); setError("");
    try{
      const response=await fetch("/api/races",{cache:"no-store"});
      const result=await response.json() as Schedule&{error?:string};
      if(!response.ok)throw new Error(result.error||"開催情報を取得できませんでした");
      setSchedule(result);
      if(venue){setVenue(result.venues.find(item=>item.eventId===venue.eventId)||null);}
    }catch(value){setError(value instanceof Error?value.message:"開催情報を取得できませんでした");}
    finally{setLoading(false);}
  }

  async function analyze(race:Race){
    setLoading(true); setError("");
    try{
      const response=await fetch(`/api/analyze?raceId=${race.raceId}`);
      const result=await response.json() as Analysis&{error?:string};
      if(!response.ok)throw new Error(result.error||"分析できませんでした");
      setData(result); setActiveHorse(result.horses[0]);
    }catch(value){setError(value instanceof Error?value.message:"分析に失敗しました");}
    finally{setLoading(false);}
  }

  useEffect(()=>{void loadSchedule();},[]);

  const back=()=>{if(data){setData(null);setActiveHorse(null);}else setVenue(null);};
  const showBack=Boolean(venue||data);

  return <main className="min-h-screen bg-[#07111f] text-slate-100"><div className="mx-auto max-w-6xl px-4 pb-20 pt-5 sm:px-6">
    <header className="mb-5 flex items-center justify-between"><div className="flex items-center gap-3">{showBack&&<Button aria-label="戻る" variant="ghost" size="icon" onClick={back} className="text-slate-300 hover:bg-white/10 hover:text-white"><ArrowLeft/></Button>}<div className="grid size-10 place-items-center rounded-xl bg-cyan-400 text-xl font-black text-[#07111f]">R</div><div><p className="text-lg font-bold tracking-[.12em]">REIN</p><p className="text-xs text-slate-400">馬券アカデミア</p></div></div><div className="flex items-center gap-2"><Button aria-label="更新" variant="ghost" size="icon" onClick={loadSchedule} disabled={loading} className="text-slate-400 hover:bg-white/10 hover:text-white"><RefreshCw className={loading?"animate-spin":""}/></Button><Badge className="border-cyan-400/25 bg-cyan-400/10 text-cyan-300">PERSONAL</Badge></div></header>
    {error&&<div className="mb-4 flex items-center gap-2 rounded-xl border border-rose-400/20 bg-rose-400/10 p-3 text-sm text-rose-200"><AlertTriangle className="size-4"/>{error}</div>}

    {!venue&&!data&&<VenueScreen schedule={schedule} loading={loading} onSelect={setVenue}/>}
    {venue&&!data&&<RaceScreen venue={venue} loading={loading} onAnalyze={analyze}/>}
    {data&&activeHorse&&<AnalysisScreen data={data} activeHorse={activeHorse} danger={danger} onHorse={setActiveHorse}/>}
  </div></main>;
}

function VenueScreen({schedule,loading,onSelect}:{schedule:Schedule|null;loading:boolean;onSelect:(venue:Venue)=>void}){
  return <><section className="mb-5 rounded-2xl border border-slate-700 bg-gradient-to-br from-[#10233a] to-[#0b1727] p-5"><p className="text-sm font-semibold text-cyan-300">TODAY&apos;S JRA</p><h1 className="mt-1 text-2xl font-black">開催場を選択</h1><p className="mt-2 text-sm text-slate-400">{schedule?.dateLabel||"本日の開催情報を取得中"}</p></section>
    {loading&&!schedule?<div className="grid min-h-56 place-items-center rounded-2xl border border-slate-800 bg-[#0c192a]"><RefreshCw className="size-8 animate-spin text-cyan-300"/></div>:schedule?.venues.length?<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{schedule.venues.map(item=><button key={item.eventId} onClick={()=>onSelect(item)} className="group rounded-2xl border border-slate-700 bg-[#0c192a] p-5 text-left transition hover:-translate-y-0.5 hover:border-cyan-400/60 hover:bg-[#10233a]"><div className="flex items-start justify-between"><div><p className="text-xs font-semibold tracking-widest text-cyan-300">JRA</p><h2 className="mt-1 text-3xl font-black">{item.name}</h2></div><ChevronRight className="text-slate-600 transition group-hover:translate-x-1 group-hover:text-cyan-300"/></div><div className="mt-6 flex items-end justify-between"><div><p className="text-xs text-slate-500">次レース</p><p className="text-xl font-bold">{item.nextRace}R <span className="text-sm font-normal text-slate-400">{item.nextStart}</span></p></div><Badge className="bg-cyan-400/10 text-cyan-300">全{item.races.length}R</Badge></div></button>)}</div>:<div className="rounded-2xl border border-slate-700 bg-[#0c192a] p-8 text-center text-slate-400">本日のJRA開催はありません</div>}</>;
}

function RaceScreen({venue,loading,onAnalyze}:{venue:Venue;loading:boolean;onAnalyze:(race:Race)=>void}){
  return <><section className="mb-5 flex items-end justify-between rounded-2xl border border-slate-700 bg-gradient-to-br from-[#10233a] to-[#0b1727] p-5"><div><p className="text-sm font-semibold text-cyan-300">開催場</p><h1 className="mt-1 text-3xl font-black">{venue.name}</h1><p className="mt-2 text-sm text-slate-400">レースを選択すると出馬表・オッズ・8年履歴から分析します</p></div><Badge className="bg-white/10 text-white">{venue.races.length}レース</Badge></section>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{venue.races.map(race=><button key={race.raceId} onClick={()=>onAnalyze(race)} disabled={loading} className={`rounded-2xl border p-4 text-left transition hover:border-cyan-400/60 ${race.status==="次レース"?"border-cyan-400/60 bg-cyan-400/10":"border-slate-700 bg-[#0c192a]"}`}><div className="flex items-start justify-between"><div className="flex items-center gap-3"><span className="grid size-11 place-items-center rounded-xl bg-white text-lg font-black text-[#07111f]">{race.number}R</span><div><p className="font-bold">{race.title}</p><p className="mt-1 line-clamp-1 text-xs text-slate-500">{race.course}</p></div></div><ChevronRight className="size-4 text-slate-600"/></div><div className="mt-4 flex items-center justify-between"><span className="flex items-center gap-1 text-sm text-slate-300"><Clock3 className="size-4"/>{race.start}</span><Badge className={race.status==="次レース"?"bg-cyan-300 text-[#07111f]":race.status==="確定"?"bg-slate-700 text-slate-300":"bg-amber-400/10 text-amber-300"}>{race.status}</Badge></div></button>)}</div></>;
}

function AnalysisScreen({data,activeHorse,danger,onHorse}:{data:Analysis;activeHorse:Horse;danger:Horse|undefined;onHorse:(horse:Horse)=>void}){
  return <>{data.model&&<section className="mb-4 flex flex-wrap gap-x-4 gap-y-1 rounded-xl border border-cyan-400/20 bg-cyan-400/5 px-4 py-2 text-xs text-slate-400"><span className="font-semibold text-cyan-300">8年履歴 接続済み</span><span>{data.model.races.toLocaleString()}レース・{data.model.runners.toLocaleString()}走</span><span>{data.model.strategy}</span></section>}
    <section className="mb-5 grid gap-4 lg:grid-cols-[1.45fr_.55fr]"><Card className="border-slate-700 bg-gradient-to-br from-[#10233a] to-[#0b1727] text-white"><CardContent className="p-5 sm:p-6"><p className="text-sm text-cyan-300">{data.race.start}発走 ・ {data.race.updated}</p><h1 className="mt-1 text-2xl font-bold sm:text-3xl">{data.race.title}</h1><p className="mt-1 text-slate-400">{data.race.course}　{data.race.condition}</p><div className="mt-5 grid grid-cols-3 gap-2">{data.horses.slice(0,3).map((horse,index)=><button key={horse.number} onClick={()=>onHorse(horse)} className={`rounded-xl border p-3 text-left ${index===0?"border-cyan-400/60 bg-cyan-400/10":"border-slate-700 bg-black/10"}`}><span className="text-xs text-slate-400">{index===0?"本命":index===1?"対抗":"単穴"}</span><div className="mt-1 flex items-center gap-2"><span className="grid size-7 place-items-center rounded-md bg-white font-bold text-slate-900">{horse.number}</span><span className="truncate text-sm font-semibold">{horse.name}</span></div><p className="mt-3 text-2xl font-black text-cyan-300">{horse.score}<span className="ml-1 text-xs font-normal text-slate-500">pt</span></p></button>)}</div></CardContent></Card><div className="grid gap-4"><Card className="border-slate-700 bg-[#0c192a] text-white"><CardContent className="flex gap-3 p-4"><Gauge className="text-amber-300"/><div><p className="text-xs text-slate-400">展開予測</p><p className="font-bold">{data.pace.label}</p><p className="mt-1 text-sm text-slate-400">{data.pace.detail}</p></div></CardContent></Card><Card className="border-slate-700 bg-[#0c192a] text-white"><CardContent className="flex gap-3 p-4"><AlertTriangle className="text-rose-300"/><div><p className="text-xs text-slate-400">危険人気馬</p><p className="font-bold">{danger?`${danger.number} ${danger.name}`:"該当なし"}</p><p className="mt-1 text-sm text-slate-400">{danger?.cautions.join("・")||"人気と評価が一致"}</p></div></CardContent></Card></div></section>
    <Tabs defaultValue="ranking"><TabsList className="mb-4 grid h-11 w-full grid-cols-3 bg-[#0c192a]"><TabsTrigger value="ranking">全頭評価</TabsTrigger><TabsTrigger value="tickets">買い目</TabsTrigger><TabsTrigger value="detail">診断</TabsTrigger></TabsList><TabsContent value="ranking"><div className="overflow-hidden rounded-2xl border border-slate-700 bg-[#0c192a]">{data.horses.map((horse,index)=><button key={horse.number} onClick={()=>onHorse(horse)} className="grid w-full grid-cols-[28px_36px_minmax(0,1fr)_58px_20px] items-center gap-2 border-b border-slate-800 px-3 py-3 text-left last:border-0 sm:grid-cols-[32px_40px_minmax(0,1fr)_105px_60px_20px]"><span className="text-center text-sm text-slate-500">{index+1}</span><span className="grid size-8 place-items-center rounded-md bg-white font-bold text-slate-900">{horse.number}</span><div className="min-w-0"><p className="truncate font-semibold">{horse.mark} {horse.name}</p><p className="truncate text-xs text-slate-500">{horse.style}・{horse.verdict}<span className="hidden sm:inline">　履歴 {horse.historySamples??0}走 / 補正 {horse.historyAdjustment&&horse.historyAdjustment>0?"+":""}{horse.historyAdjustment??0}</span></p></div><p className="text-right text-lg font-black text-cyan-300">{horse.score}<span className="text-xs text-slate-500">pt</span></p><span className="hidden text-right text-sm text-slate-400 sm:block">{horse.popularity}人気</span><ChevronRight className="size-4 text-slate-600"/></button>)}</div></TabsContent><TabsContent value="tickets"><div className="grid gap-3 sm:grid-cols-2">{data.tickets.map(ticket=><Card key={ticket.type} className="border-slate-700 bg-[#0c192a] text-white"><CardHeader className="pb-2"><CardTitle className="text-base">{ticket.type}</CardTitle></CardHeader><CardContent className="space-y-3">{ticket.tiers.map(item=><div key={item.group} className="rounded-lg border border-slate-800 bg-black/10 p-3"><div className="mb-2 flex justify-between"><Badge className={groupStyle[item.group]}>{item.group}</Badge><Badge variant="outline" className="border-slate-600 text-slate-300">{item.points}点</Badge></div><p className="font-mono text-xs leading-6 text-slate-200">{item.selections.join(" / ")||"該当なし"}</p></div>)}</CardContent></Card>)}</div></TabsContent><TabsContent value="detail"><Card className="border-slate-700 bg-[#0c192a] text-white"><CardContent className="p-5"><div className="flex justify-between"><div><p className="text-xl font-bold">{activeHorse.mark} {activeHorse.number} {activeHorse.name}</p><p className="text-sm text-slate-400">履歴 {activeHorse.historySamples??0}走・履歴補正 {activeHorse.historyAdjustment&&activeHorse.historyAdjustment>0?"+":""}{activeHorse.historyAdjustment??0}</p></div><p className="text-3xl font-black text-cyan-300">{activeHorse.score}</p></div><div className="mt-5 grid gap-3 sm:grid-cols-2"><div className="rounded-xl bg-cyan-400/8 p-4"><p className="mb-2 flex items-center gap-2 font-semibold text-cyan-300"><Sparkles className="size-4"/>プラス補正</p>{activeHorse.positives.length?activeHorse.positives.map(value=><p key={value} className="py-1 text-sm">＋ {value}</p>):<p className="text-sm text-slate-400">大きな加点なし</p>}</div><div className="rounded-xl bg-rose-400/8 p-4"><p className="mb-2 flex items-center gap-2 font-semibold text-rose-300"><Activity className="size-4"/>リスク</p>{activeHorse.cautions.length?activeHorse.cautions.map(value=><p key={value} className="py-1 text-sm">− {value}</p>):<p className="text-sm text-slate-400">大きな減点なし</p>}</div></div></CardContent></Card></TabsContent></Tabs>
  </>;
}
