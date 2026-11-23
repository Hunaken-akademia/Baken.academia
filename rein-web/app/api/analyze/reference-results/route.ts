import { referenceResultsResponse } from "@/lib/reference-results-server";
export const dynamic="force-dynamic";
export const maxDuration=60;
export const GET=()=>referenceResultsResponse("jra");
