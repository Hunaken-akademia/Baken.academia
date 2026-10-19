import { oddsTrendBoardResponse } from "@/lib/odds-trend-board-server";
export const dynamic="force-dynamic";
export const maxDuration=60;
export const GET=()=>oddsTrendBoardResponse("jra");
