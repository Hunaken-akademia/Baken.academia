import { NextRequest } from "next/server";
import { comparisonResponse } from "@/lib/cushion-comparison-server";
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const GET=(request:NextRequest)=>comparisonResponse(request);
