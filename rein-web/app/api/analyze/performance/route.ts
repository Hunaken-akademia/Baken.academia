import { NextRequest } from "next/server";
import { performanceResponse } from "@/lib/performance-server";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const GET = (request: NextRequest) => performanceResponse(request, "jra");
