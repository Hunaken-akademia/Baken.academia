import {jraRaceNameKey, type Edition} from "./jra-reference";
import type {PaceScenarioId} from "./pace-scenarios";

export type HistoricalRunner = {finish:number;number:number;name:string;corners:number[];stages:string[]};
export type HistoricalFlow = {sourceUrl:string;date:string;venue:string;surface:string;distanceM:number;going:string;fieldSize:number;laps:number[];runners:HistoricalRunner[]};
export type GradedFlowData = {version:string;entries:Record<string,HistoricalFlow>};
export type HistoricalPace = {label:string;earlySeconds:number|null;earlyMeters:number;lateSeconds:number|null;median:number|null;difference:number|null;samples:number;kind:"slow"|"average"|"fast"|"unknown"};

export function historicalPosition(position:number|null|undefined, fieldSize:number) {
  if(!Number.isInteger(position)||!position||position<1||position>fieldSize)return "記録なし";
  if(position===1)return "逃げ（先頭）";
  if(position<=Math.min(4, Math.ceil(fieldSize/2)))return "先行";
  if(position<=Math.ceil(fieldSize/2))return "好位・中団";
  return "後方（差し・追込の位置）";
}

function validLaps(flow:HistoricalFlow) {
  return flow.laps.length===Math.ceil(flow.distanceM/200) && flow.laps.length>=3 && flow.laps.every(n=>Number.isFinite(n)&&n>=5&&n<=30);
}

export function historicalPace(flow:HistoricalFlow|null, peers:HistoricalFlow[]):HistoricalPace {
  const earlyMeters=flow ? (flow.distanceM%200||200)+400 : 600;
  const empty:HistoricalPace={label:"ラップ未取得",earlySeconds:null,earlyMeters,lateSeconds:null,median:null,difference:null,samples:0,kind:"unknown"};
  if(!flow||!validLaps(flow))return empty;
  const sum=(values:number[])=>Math.round(values.reduce((a,b)=>a+b,0)*10)/10;
  const earlySeconds=sum(flow.laps.slice(0,3)),lateSeconds=sum(flow.laps.slice(-3));
  const times=peers.filter(p=>p.date!==flow.date && p.venue===flow.venue && p.surface===flow.surface && p.distanceM===flow.distanceM && p.going===flow.going && validLaps(p)).map(p=>sum(p.laps.slice(0,3))).sort((a,b)=>a-b);
  if(times.length<3)return {...empty,label:"比較母数不足",earlySeconds,lateSeconds,samples:times.length};
  const middle=Math.floor(times.length/2),median=times.length%2?times[middle]:(times[middle-1]+times[middle])/2;
  const difference=Math.round((earlySeconds-median)*100)/100;
  const kind=difference>=0.6?"slow":difference<=-0.6?"fast":"average";
  return {label:kind==="slow"?"ゆっくり（同条件比）":kind==="fast"?"速め（同条件比）":"標準（同条件比）",earlySeconds,earlyMeters,lateSeconds,median,difference,samples:times.length,kind};
}

export function gradedEditionFlow(data:GradedFlowData,name:string,edition:Edition,currentYear:number) {
  if(edition.year>=currentYear)return {flow:null,pace:historicalPace(null,[]),position:"記録なし",scenario:"baseline" as PaceScenarioId,winner:undefined};
  const key=jraRaceNameKey(name),record=data.version==="jra-graded-flow-v1"?data.entries[`${key}|${edition.date}`]:undefined;
  const flow=record && edition.year<currentYear && record.date===edition.date && record.venue===edition.venue && record.surface===edition.surface && record.distanceM===edition.distanceM && record.going===edition.going ? record:null;
  const peers=Object.entries(data.entries).filter(([k,v])=>k.startsWith(`${key}|`) && Number(v.date.slice(0,4))<currentYear).map(([,v])=>v);
  const pace=historicalPace(flow,peers);
  const winner=flow?.runners.find(r=>r.finish===1);
  const first=winner?.corners[0]??edition.winnerFirstCorner;
  const position=historicalPosition(first,flow?.fieldSize??edition.fieldSize);
  const back=typeof first==="number" && first>Math.ceil((flow?.fieldSize??edition.fieldSize)/2);
  // A hypothesis for this year's horses, not a reconstruction of old finish order.
  const scenario:PaceScenarioId=pace.kind==="fast"?"duel":pace.kind==="slow"?"lone":back?"closers":position==="記録なし"?"baseline":"steady";
  return {flow,pace,position,scenario,winner};
}
