import {NextRequest} from 'next/server';
import {dictionaryRequest} from '@/lib/dictionary-server';
export const dynamic='force-dynamic';
export async function GET(request:NextRequest){return dictionaryRequest(request,'jra');}
