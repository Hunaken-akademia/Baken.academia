import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { createRemoteJWKSet,jwtVerify } from "npm:jose@5.10.0";
import { observationRecord,settleObservation } from "./records.ts";
const issuer="https://oidc.vercel.com/hunaken-akademia",jwks=createRemoteJWKSet(new URL(issuer+"/.well-known/jwks"));
const db=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{autoRefreshToken:false,persistSession:false}});
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json","cache-control":"no-store"}});
function checked(r:any){if(r.error)throw new Error(r.error.message);return r.data;}
Deno.serve(async req=>{
 if(req.method!=="POST")return json({error:"Method not allowed"},405);
 let environment:string;
 try {
  const token=(req.headers.get("authorization")??"").match(/^Bearer (.+)$/)?.[1];if(!token)throw new Error("Unauthorized");
  const {payload}=await jwtVerify(token,jwks,{issuer,audience:"https://vercel.com/hunaken-akademia"});
  if(payload.owner_id!=="team_JoV13Y5pkEXrjvf8JCKP6tNY"||payload.project_id!=="prj_8X6LIxRxvKKNyVQWxFKF6AQJ6wrm"||!["production","preview"].includes(String(payload.environment)))throw new Error("Unauthorized");
  environment=String(payload.environment);
 }catch{return json({error:"Unauthorized"},401);}
 try {
  const text=await req.text();if(text.length>40_000)return json({error:"Too large"},413);
  const b=JSON.parse(text),id=b?.raceId;if(typeof id!=="string"||!/^\d{8,10}(?:0[1-9]|1[0-2])$/.test(id)||![10,12].includes(id.length)||!["read","write"].includes(b.action))return json({error:"Invalid request"},400);
  const snapshots=checked(await db.from("rein_race_snapshots").select("race_id,payload,starts_at,slot").eq("race_id",id).in("slot",["live","preview"]).limit(2));
  const snapshot=snapshots.find((s:any)=>s.slot==="live")??snapshots[0];if(!snapshot)return json({error:"Snapshot unavailable"},404);
  if(b.action==="write") {
   if(environment!=="production")return json({saved:false,preview:true});
   if(!Array.isArray(b.items)||b.items.length>10)return json({error:"Invalid observations"},400);
   const rows=b.items.map((i:any)=>observationRecord(i,snapshot));
   if(rows.length)checked(await db.from("rein_odds_trend_observations").upsert(rows,{onConflict:"race_id,rule_id,odds_at",ignoreDuplicates:true}));
   return json({saved:true});
  }
  const rows=checked(await db.from("rein_odds_trend_observations").select("rule_id,odds_at,payload,stake_yen,settlement_status,return_yen").eq("race_id",id).order("odds_at",{ascending:false}).limit(1000));
  const latest=new Map<string,any>();
  for(const row of rows){
   if(environment==="production"&&row.settlement_status==="pending"){
    const settlement=settleObservation(row,snapshot.payload);
    if(settlement){checked(await db.from("rein_odds_trend_observations").update({...settlement,settled_at:new Date().toISOString()}).eq("race_id",id).eq("rule_id",row.rule_id).eq("odds_at",row.odds_at).eq("settlement_status","pending"));Object.assign(row,settlement);}
   }
   if(!latest.has(row.rule_id))latest.set(row.rule_id,{...row.payload,settlement:{status:row.settlement_status,returnYen:row.return_yen}});
  }
  return json({items:[...latest.values()]});
 }catch(e){console.error("REIN odds observations failed",e instanceof Error?e.message:"unknown");return json({error:"Observation operation failed"},500);}
});
