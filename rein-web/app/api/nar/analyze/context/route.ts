import { NextRequest } from "next/server";
import { raceContextResponse } from "@/lib/race-context-server";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const GET = (request: NextRequest) => raceContextResponse(request, "nar");
