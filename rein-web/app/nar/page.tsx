import RaceDashboard from "@/components/race-dashboard";
import { Suspense } from "react";
import { serverData } from "@/lib/server-snapshots";

export const dynamic = "force-dynamic";
type Report = {
 coverage:{chunks:number;date_from:string;date_to:string;races:number;runners:number;racecourses:number};
 market_baseline:{pop1_win_rate:number;pop1_top3_rate:number;top3_contains_winner_rate:number};
 live_model?:{status:string;roles:Record<string,{mode:string}>;comparison:Record<string,Record<string,{audit2026:Record<string,{races:number;hits:number;rate:number|null}>}>>;marketBaseline2026:Record<string,Record<string,{rate:number}>>};
};
export default function NarPage(){return <RaceDashboard area="nar"><Suspense fallback={<p className="mt-5 text-xs text-slate-400">地方の学習状況を読み込み中…</p>}><NarAnalysisStatus /></Suspense></RaceDashboard>;}
async function NarAnalysisStatus(){
 const {analysis,active}=await serverData<{analysis:{report:Report;updated_at:string}|null;active:{report:Report;activated_at:string}|null}>("nar-analysis").catch(()=>({analysis:null,active:null}));
 const c=analysis?.report.coverage,model=active?.report.live_model;
 return (
  <section className="mt-5 rounded-2xl border border-amber-300/20 bg-[#0c192a] p-4 sm:p-5">
   <h2 className="font-bold text-amber-200">地方競馬・先行公開中</h2>
   <p className="mt-2 text-sm leading-6 text-slate-300">現在ある地方データで利用できます。取得は継続中のため、予測は暫定版です。全データがそろった後、検証して補正を改訂します。</p>
   {c?<>
    <p className="mt-3 text-sm text-slate-400">取得済み {c.races.toLocaleString("ja-JP")}レース・{c.runners.toLocaleString("ja-JP")}頭分 / {c.chunks}期間</p>
    <p className="mt-1 text-xs leading-5 text-slate-500">{c.date_from}〜{c.date_to}の部分取得。期間内の全レース取得完了を意味しません。最終分析：{new Date(analysis.updated_at).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo"})}</p>
    <details className="mt-4 border-t border-slate-700 pt-3"><summary className="cursor-pointer text-sm font-semibold text-slate-200">暫定モデルと検証範囲</summary>
     <p className="mt-3 text-xs leading-6 text-slate-400">人気順ベースライン：1番人気の勝率 {(analysis.report.market_baseline.pop1_win_rate*100).toFixed(1)}%、3着内率 {(analysis.report.market_baseline.pop1_top3_rate*100).toFixed(1)}%。これはAIの的中率ではありません。</p>
     {model?.status==="provisional"?<div className="mt-3 grid gap-3 sm:grid-cols-3">{[1,2,3].map(t=>{const role=model.roles[String(t)];const metrics=model.comparison[String(t)]?.[role?.mode]?.audit2026;return <div key={t} className="rounded-lg bg-black/20 p-3 text-xs text-slate-400"><p className="font-semibold text-white">{t}着適性・{{absolute:"絶対",relative:"相対",hybrid:"ハイブリッド"}[role?.mode]??role?.mode}評価</p>{[1,4,10].map(p=>{const m=metrics?.[String(p)],baseline=model.marketBaseline2026?.[String(t)]?.[String(p)];return <p key={p} className="mt-2">{p===1?"全体":`${p}番人気以下が来た場合`}：Top5 {m?.races?`${m.hits}/${m.races}（${(m.rate!*100).toFixed(1)}%）`:"母数なし"}<span className="block text-slate-500">人気順Top5：{baseline?`${(baseline.rate*100).toFixed(1)}%`:"未集計"}</span></p>})}</div>})}</div>:<p className="mt-3 text-xs text-slate-400">地方専用モデルの初回学習・検証を準備中です。出走表は先に表示できます。</p>}
     <p className="mt-3 text-xs leading-6 text-amber-200">今回の暫定モデルは全体のTop5的中率で人気順を下回っています。参考評価として公開し、自動買い目・勝負度は未採用です。データ追加だけでは本番補正を切り替えず、再検証して改訂します。</p>
     <p className="mt-3 text-xs leading-6 text-slate-500">2019〜2024年で学習、2025年で方式選択、2026年の取得済み範囲で監査。分母は該当人気帯の馬がその着順に入ったレース数です。実運用の発走前記録とは別の過去検証です。画面の％は未校正の評価シェアで、的中確率ではありません。</p>
    </details>
   </>:<p className="mt-3 text-xs text-slate-400">分析状況を一時的に取得できません。レース一覧から確認できます。</p>}
  </section>
 );
}
