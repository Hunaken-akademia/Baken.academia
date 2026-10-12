import { NextRequest } from "next/server";
import { oddsTrendsResponse } from "@/lib/odds-trends-server";
export const dynamic="force-dynamic";
export const maxDuration=60;
export const GET=(request:NextRequest)=>oddsTrendsResponse(request,"jra");
