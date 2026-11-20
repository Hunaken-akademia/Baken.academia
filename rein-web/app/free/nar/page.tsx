import type { Metadata } from "next";
import RaceDashboard from "@/components/race-dashboard";
import FreeFunnelBeacon from "@/components/free-funnel-beacon";

export const metadata: Metadata = { title: "REIN 無料版（地方競馬）｜馬券アカデミア", description: "毎日、地方競馬の1場の全レースをログイン無しで見られるREINの無料版" };

export default function FreeNarPage() {
  return <><FreeFunnelBeacon page="nar" /><RaceDashboard area="nar" free /></>;
}
