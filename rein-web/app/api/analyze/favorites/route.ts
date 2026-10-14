import { NextRequest } from "next/server";
import { favoritesGet, favoritesPost } from "@/lib/favorites-server";
export const dynamic = "force-dynamic";
export const GET = (request: NextRequest) => favoritesGet(request, "jra");
export const POST = (request: NextRequest) => favoritesPost(request, "jra");
