import type { Horse } from "@/lib/horse-types";
import { careerDifference, finite, historyFactors, historyRate, HORSE_CONDITIONS, percent, pointsDifference } from "@/lib/horse-research";

export function HorseConditionDetails({ horse, dateFrom, dateTo }: { horse: Horse; dateFrom?: string; dateTo?: string }) {
  const factors = historyFactors(horse);
  const career = factors.find(item => item.label === "通算成績");
  const own = HORSE_CONDITIONS.map(label => ({ label, factor: factors.find(item => item.label === label) }));
  const other = factors.filter(item => !HORSE_CONDITIONS.some(label => label === item.label));
  return (
    <section aria-label="馬の条件別成績" className="mt-4 overflow-hidden rounded-xl border border-slate-700 bg-[#0c192a]">
      <div className="p-4">
        <h3 className="font-bold text-white">条件別成績・通算との比較</h3>
        <p className="mt-1 text-xs leading-5 text-slate-400">馬自身の実績を比較。3着内率の通算差は、得意条件を探す参考です。</p>
        <p className="mt-1 text-xs leading-5 text-slate-400">{dateFrom && dateTo ? `保存予想の履歴集計期間：${dateFrom}〜${dateTo}` : "履歴の集計期間は未取得"}。各項目の出走数は重複するため合算しません。</p>
      </div>
      <div className="grid gap-2 px-3 pb-3 sm:grid-cols-2">
        {own.map(({ label, factor }) => {
          const win = historyRate(factor, "win"), top3 = historyRate(factor, "top3");
          const diff = factor ? careerDifference(factor, career) : null;
          const samples = factor && finite(factor.samples) && factor.samples > 0 ? factor.samples : 0;
          return (
            <article key={label} className="rounded-lg border border-slate-800 bg-black/10 p-3">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-sm font-semibold text-slate-100">{label}</h4>
                <span className="text-xs text-slate-400">{samples ? `${samples.toLocaleString()}走` : "実績未取得"}</span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <div><p className="text-[11px] text-slate-400">勝率</p><p className="text-lg font-bold text-slate-100">{percent(win)}</p></div>
                <div><p className="text-[11px] text-slate-400">3着内率</p><p className="text-lg font-bold text-cyan-200">{percent(top3)}</p></div>
              </div>
              {top3 !== null && <div aria-hidden="true" className="mt-2 h-1.5 overflow-hidden rounded bg-slate-800"><div className="h-full rounded bg-cyan-300/70" style={{ width: `${top3}%` }} /></div>}
              <p className="mt-2 text-xs leading-5 text-slate-400">{samples && finite(factor?.wins) ? `${factor.wins}勝` : "勝利数 未取得"} / {samples && finite(factor?.top3) ? `3着内 ${factor.top3}回` : "3着内数 未取得"} / 平均 {samples && finite(factor?.averageFinish) && factor.averageFinish > 0 ? `${factor.averageFinish.toFixed(1)}着` : "未取得"}</p>
              {diff !== null && <p className={`mt-1 text-xs font-semibold ${diff > 0 ? "text-emerald-300" : diff < 0 ? "text-amber-200" : "text-slate-400"}`}>3着内率：通算比 {pointsDifference(diff)}</p>}
              {samples > 0 && samples < 10 && <p className="mt-1 text-[11px] text-amber-200">少数の実績・参考</p>}
            </article>
          );
        })}
      </div>
      <p className="px-4 pb-3 text-[11px] leading-5 text-slate-400">距離適性は履歴の距離区分による集計です。同一距離だけの成績とは限りません。通算差のptはパーセントポイントで、予想への加点ではありません。</p>
      {other.length > 0 && <details className="border-t border-slate-800 p-4">
        <summary className="cursor-pointer text-sm font-semibold text-slate-300">騎手・厩舎など、馬以外の参考成績</summary>
        <div className="mt-3 space-y-2">{other.map(item => <div key={item.label} className="rounded-lg bg-black/10 p-3 text-xs leading-5 text-slate-300"><p className="font-semibold">{item.label}・{item.samples}走</p><p>勝率 {percent(historyRate(item, "win"))} / 3着内率 {percent(historyRate(item, "top3"))}</p></div>)}</div>
        <p className="mt-2 text-[11px] leading-5 text-slate-400">馬自身の通算成績とは集計対象が異なるため、通算との差は算出していません。</p>
      </details>}
      {factors.some(item => item.samples > 0 && finite(item.impact)) && <details className="border-t border-slate-800 p-4">
        <summary className="cursor-pointer text-sm font-semibold text-slate-300">履歴項目ごとの参考評価</summary>
        <dl className="mt-3 space-y-2 text-xs">{factors.filter(item => item.samples > 0 && finite(item.impact)).map(item => <div key={item.label} className="flex justify-between gap-3 rounded-lg bg-black/10 p-3"><dt className="text-slate-300">{item.label}・{item.samples}走</dt><dd className={item.impact > 0 ? "text-cyan-200" : "text-slate-300"}>{item.impact > 0 ? "+" : ""}{item.impact}</dd></div>)}</dl>
        <p className="mt-2 text-[11px] leading-5 text-slate-400">保存された履歴評価の参考値です。上の通算差とは指標が異なります。</p>
      </details>}
    </section>
  );
}
