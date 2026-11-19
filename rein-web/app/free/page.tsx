import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "REIN 無料版｜馬券アカデミア",
  description: "毎日、中央1場・地方1場の全レースを会員版と同じ画面で、ログイン無しで見られるREINの無料版",
};

const PLANS = [
  { name: "地方競馬", price: "月額 800円", href: "https://bookers.tech/magazine/9aee480f-e4f7-4d14-b4b5-8ae381512a8f/", tone: "text-amber-300" },
  { name: "中央競馬", price: "月額 800円", href: "https://bookers.tech/magazine/4d1af8db-e934-46fe-b22c-9cfdbeee18b5/", tone: "text-cyan-300" },
  { name: "地方＋中央", price: "月額 1,000円", href: "https://bookers.tech/magazine/c9b4b8a8-f00f-4097-8cf4-334ec5ba62bd/", tone: "font-bold text-cyan-200" },
];

const FREE = ["本命・対抗・穴候補の印", "1着・2着・3着それぞれの適性ランキング", "人気とREINの評価の照合、全頭の適性早見表", "馬の比較・展開シナリオ・馬の詳細", "レース結果と人気別の結果"];
const MEMBER = ["その日の全場・全レース", "参考買い目（単勝〜3連単の7券種・本線/対抗/穴）", "明日の予想・過去1年の開催", "レース検索・オッズの動き一覧・成績", "馬場データ・騎手の成績・REIN辞典", "お気に入り・馬のメモ・予想の答え合わせ"];

export default function FreeHome() {
  return (
    <main className="min-h-screen bg-[#07111f] px-4 py-8 text-slate-100">
      <div className="mx-auto max-w-4xl">
        <header className="mb-8 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="grid size-11 place-items-center rounded-xl bg-cyan-400 text-xl font-black text-[#07111f]">R</div>
            <div>
              <p className="text-lg font-black tracking-[.12em]">REIN</p>
              <p className="text-xs text-slate-400">馬券アカデミア</p>
            </div>
          </div>
          <div className="rounded-full border border-cyan-400/25 bg-cyan-400/10 px-3 py-1.5 text-xs font-semibold text-cyan-300">無料版</div>
        </header>

        <section className="mb-6 rounded-3xl border border-slate-700 bg-gradient-to-br from-[#10233a] to-[#0b1727] p-6 sm:p-8">
          <p className="text-sm font-semibold text-cyan-300">ログイン不要</p>
          <h1 className="mt-2 text-3xl font-black">毎日、中央1場・地方1場を無料公開</h1>
          <p className="mt-3 text-sm leading-6 text-slate-300">
            その日に開催している場から、中央競馬・地方競馬それぞれ1場を選んで（重賞のある場を優先）、全レースを会員版と同じ画面で見られます。公開する場は日本時間の日付で決まり、その日は一日同じです。
          </p>
        </section>

        <div className="grid gap-4 sm:grid-cols-2">
          <Link href="/free/jra" className="group rounded-3xl border border-slate-700 bg-[#0c192a] p-6 transition hover:-translate-y-0.5 hover:border-cyan-400/60">
            <p className="text-xs font-semibold tracking-widest text-cyan-300">JRA</p>
            <h2 className="mt-2 text-2xl font-black">中央競馬の無料公開</h2>
            <p className="mt-3 text-sm leading-6 text-slate-400">本日の中央競馬から1場。土日・祝日の開催日に公開します。</p>
            <p className="mt-6 font-semibold text-cyan-300">中央競馬を開く →</p>
          </Link>
          <Link href="/free/nar" className="group rounded-3xl border border-slate-700 bg-[#0c192a] p-6 transition hover:-translate-y-0.5 hover:border-amber-400/60">
            <p className="text-xs font-semibold tracking-widest text-amber-300">NAR</p>
            <h2 className="mt-2 text-2xl font-black">地方競馬の無料公開</h2>
            <p className="mt-3 text-sm leading-6 text-slate-400">本日の地方競馬から1場。ほぼ毎日公開します。</p>
            <p className="mt-6 font-semibold text-amber-300">地方競馬を開く →</p>
          </Link>
        </div>

        <section className="mt-6 grid gap-4 sm:grid-cols-2">
          <div className="rounded-3xl border border-slate-700 bg-[#0c192a] p-6">
            <h2 className="text-lg font-black">無料版で見られるもの</h2>
            <ul className="mt-3 space-y-2 text-sm leading-6 text-slate-300">{FREE.map((item) => <li key={item}>✓ {item}</li>)}</ul>
          </div>
          <div className="rounded-3xl border border-cyan-300/30 bg-cyan-300/[.04] p-6">
            <h2 className="text-lg font-black text-cyan-100">会員版だけのもの</h2>
            <ul className="mt-3 space-y-2 text-sm leading-6 text-slate-300">{MEMBER.map((item) => <li key={item}>🔒 {item}</li>)}</ul>
          </div>
        </section>

        <section id="plans" className="mt-6 scroll-mt-6 rounded-3xl border border-slate-700 bg-[#0c192a] p-6">
          <h2 className="text-lg font-black">会員版を使う</h2>
          <p className="mt-2 text-sm leading-6 text-slate-400">BOOKERSでプランに加入し、会員限定記事の合言葉をREINに入れると使えるようになります。</p>
          <div className="mt-4 grid gap-2 text-sm">
            {PLANS.map((plan) => (
              <a key={plan.name} href={plan.href} target="_blank" rel="noreferrer" className="flex items-center justify-between rounded-xl border border-slate-700 bg-black/10 px-4 py-3 transition hover:bg-white/5">
                <span className="font-semibold">{plan.name}</span><span className={plan.tone}>{plan.price}</span>
              </a>
            ))}
          </div>
          <Link href="/login" className="mt-5 inline-flex min-h-11 items-center rounded-xl bg-cyan-300 px-5 text-sm font-bold text-[#07111f] hover:bg-cyan-200">加入済みの方はログイン →</Link>
        </section>

        <p className="mt-6 text-xs leading-5 text-slate-500">REINの評価・買い目は参考情報です。馬券の購入はご自身の判断でお願いします。</p>
      </div>
    </main>
  );
}
