import {NextRequest} from 'next/server';
import {jockeyReferenceRequest} from '@/lib/jockey-reference-server';
export const dynamic='force-dynamic';
export async function POST(request:NextRequest){return jockeyReferenceRequest(request,'nar');}
