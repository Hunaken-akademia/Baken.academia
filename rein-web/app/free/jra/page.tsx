import type { Metadata } from "next";
import RaceDashboard from "@/components/race-dashboard";

export const metadata: Metadata = { title: "REIN 無料版（中央競馬）｜馬券アカデミア", description: "毎日、中央競馬の1場の全レースをログイン無しで見られるREINの無料版" };

export default function FreeJraPage() {
  return <RaceDashboard area="jra" free />;
}
