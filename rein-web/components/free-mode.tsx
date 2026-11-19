"use client";
import { createContext, useContext } from "react";

// 無料版（/free）で描画しているかどうか。会員だけが使える機能は、これを見て隠すか案内に差し替える。
export const FreeModeContext = createContext(false);
export const useFreeMode = () => useContext(FreeModeContext);

export const MEMBER_PLANS_URL = "/free#plans";

export function FreeLocked({ title, text, className = "" }: { title: string; text?: string; className?: string }) {
  return (
    <div className={`rounded-xl border border-dashed border-cyan-300/40 bg-cyan-300/[.04] p-4 text-sm ${className}`} data-testid="free-locked">
      <p className="font-bold text-cyan-100">🔒 {title}は会員版で</p>
      {text && <p className="mt-1 text-xs leading-5 text-slate-400">{text}</p>}
      <a href={MEMBER_PLANS_URL} className="mt-3 inline-flex min-h-11 items-center rounded-lg bg-cyan-300 px-4 text-sm font-bold text-[#07111f] hover:bg-cyan-200">会員プランを見る（月800円から）</a>
    </div>
  );
}
