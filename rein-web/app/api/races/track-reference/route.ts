import { NextRequest } from "next/server";
import { trackReferenceResponse } from "@/lib/track-reference-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
export const GET = (request: NextRequest) => trackReferenceResponse(request, "jra");
