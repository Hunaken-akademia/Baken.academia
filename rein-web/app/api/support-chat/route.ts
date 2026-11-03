import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { SUPABASE_URL } from '@/lib/supabase/config';
import { isReinAdmin } from '@/lib/rein-admin';
import { chatAction } from '@/lib/support-chat.mjs';
export const dynamic='force-dynamic';
export const runtime='nodejs';
const json=(body:unknown,status=200)=>NextResponse.json(body,{status,headers:{'cache-control':'private, no-store'}});
async function handle(request:NextRequest){
 try {
  if(request.method==='POST'&&((request.headers.get('origin')&&request.headers.get('origin')!==request.nextUrl.origin)||request.headers.get('sec-fetch-site')==='cross-site'))return json({ok:false,error:'許可されていない送信元です。'},403);
  const auth=await createClient();const {data,error}=await auth.auth.getUser();
  if(error||!data.user?.id||!data.user.email)return json({ok:false,error:'ログインしてください。'},401);
  const email=data.user.email.trim().toLowerCase(),admin=isReinAdmin(email);
  if(!admin){const m=await auth.from('rein_memberships').select('member_key').eq('auth_user_id',data.user.id).limit(1);if(m.error||!m.data?.length)return json({ok:false,error:'REIN会員アカウントでログインしてください。'},403);}
  const key=process.env.SUPABASE_SERVICE_ROLE_KEY||process.env.SUPABASE_SECRET_KEY;if(!key)throw Error('Missing service configuration');
  const db=async(path:string,body?:unknown)=>{const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method:body?'POST':'GET',headers:{apikey:key,Authorization:`Bearer ${key}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),cache:'no-store',signal:AbortSignal.timeout(10000)});const text=await r.text();if(!r.ok)throw Error(text);return text?JSON.parse(text):null;};
  let body={};if(request.method==='POST'){if(Number(request.headers.get('content-length')||0)>1450000)return json({ok:false,error:'送信データが大きすぎます。'},413);const text=await request.text();if(text.length>1450000)return json({ok:false,error:'送信データが大きすぎます。'},413);try{body=JSON.parse(text);}catch{return json({ok:false,error:'入力内容を確認してください。'},400);}if(!body||typeof body!=='object'||Array.isArray(body))return json({ok:false,error:'入力内容を確認してください。'},400);}
  const query=(table:string,params:Record<string,string>)=>db(`${table}?${new URLSearchParams(params)}`);
  const rpc=(name:string,payload:unknown)=>db(`rpc/${name}`,payload);
  return json(await chatAction({member:{email},admin,query,rpc},request.method,Object.fromEntries(request.nextUrl.searchParams),body));
 }catch(e){const error=e as Error&{status?:number};const rate=error.message.includes('CHAT_RATE_LIMIT');return json({ok:false,error:rate?'続けて送信する場合は5秒お待ちください。':error.status?error.message:'通信できませんでした。少し待って再試行してください。'},rate?429:error.status||503);}
}
export const GET=handle;
export const POST=handle;
