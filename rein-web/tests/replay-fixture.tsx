import { createRoot } from "react-dom/client";
import { RaceReplay } from "@/components/race-replay";

// Browser QA fixture only. Made-up horses, not an application route or real race prediction.
const styles = ["逃げ", "先行", "先行", "好位", "好位", "差し", "差し", "差し", "追込", "追込", "好位", "先行"];
const names = ["サンプルアロー","テストブリーズ","ダミーキング","モックスター","フィクスチャー","ケンショウマル","プレビューラン","サンプルベル","テストゴールド","ダミーウイング","モックリバー","ケンショウボーイ"];
const horses = names.map((name, i) => {
  const early = [1, 3, 2, 5, 6, 9, 8, 10, 12, 11, 4, 2][i];
  return { number: i + 1, name, gate: Math.ceil((i + 1) / 1.5) > 8 ? 8 : Math.ceil((i + 1) / 1.5), popularity: i + 1, style: styles[i],
    earlyPosition: early, mapPositions: [`${early}-${early}-${Math.max(1, early - (i % 3))}-${Math.max(1, early - (i % 4))}`, `${early}-${early + 1}-${early}-${early}`],
    firstProbability: [0.08, 0.12, 0.05, 0.16, 0.07, 0.2, 0.06, 0.04, 0.09, 0.03, 0.06, 0.04][i] };
});
const picks = { status: "ready", main: { number: 6, role: "本命", firstRank: 1 }, rival: { number: 4, role: "対抗", firstRank: 2 }, longshot: { number: 9, role: "穴候補", firstRank: 4 }, longshotStatus: "selected" } as const;
createRoot(document.getElementById("root")!).render(
  <main style={{ maxWidth: 1100, margin: "0 auto", padding: 12 }}>
    <RaceReplay horses={horses} title="京都9R りんどう賞" course="芝・右・外 1400m" raceId="2608040909" pace="平均〜やや速い" league="jra" picks={picks as never} roleReady />
  </main>,
);
