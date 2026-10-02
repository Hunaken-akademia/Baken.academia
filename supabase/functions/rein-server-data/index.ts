import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5.10.0";
import { snapshotRecord, validGithubCaptureClaims, validGithubNarAnalysisClaims } from "./records.ts";

const ISSUER = "https://oidc.vercel.com/hunaken-akademia";
const VERCEL_JWKS = createRemoteJWKSet(new URL(ISSUER + "/.well-known/jwks"));
const GH_ISSUER = "https://token.actions.githubusercontent.com";
const GH_JWKS = createRemoteJWKSet(new URL(GH_ISSUER + "/.well-known/jwks"));
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { autoRefreshToken: false, persistSession: false } });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const summaryCache = new Map<string,{ value: unknown; until: number }>();

type Identity = "production" | "preview" | "github-capture" | "github-nar-analysis";

async function identity(req: Request): Promise<Identity> {
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) throw new Error("Unauthorized");
  const token = header.slice(7);
  // Issuer is only a routing hint here; signature, issuer, audience and claims are all verified below.
  const unverified = JSON.parse(atob(token.split(".")[1].replace(/-/g,"+").replace(/_/g,"/")));
  if (unverified.iss === GH_ISSUER) {
    const { payload } = await jwtVerify(token, GH_JWKS, { issuer: GH_ISSUER, audience: "rein-supabase-archive-v1" });
    if (validGithubCaptureClaims(payload)) return "github-capture";
    if (validGithubNarAnalysisClaims(payload)) return "github-nar-analysis";
    throw new Error("Unauthorized workflow");
  }
  const { payload } = await jwtVerify(token, VERCEL_JWKS, { issuer: ISSUER, audience: "https://vercel.com/hunaken-akademia" });
  if (payload.owner_id !== "team_JoV13Y5pkEXrjvf8JCKP6tNY" || payload.project_id !== "prj_8X6LIxRxvKKNyVQWxFKF6AQJ6wrm" || !["production","preview"].includes(String(payload.environment))) throw new Error("Unauthorized project");
  return payload.environment as "production" | "preview";
}

function checked<T>(result: { data: T; error: any }) { if (result.error) throw new Error(result.error.message); return result.data; }

function validNarAnalysis(report: any) {
  const coverage = report?.coverage;
  const baseline = report?.market_baseline;
  const rate = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
  return report?.status === "partial_rolling_analysis"
    && Number.isInteger(coverage?.chunks) && coverage.chunks > 0
    && dateValid(coverage?.date_from) && dateValid(coverage?.date_to) && coverage.date_from <= coverage.date_to
    && Number.isInteger(coverage?.races) && coverage.races >= 0
    && Number.isInteger(coverage?.runners) && coverage.runners >= 0
    && Number.isInteger(coverage?.racecourses) && coverage.racecourses >= 0
    && rate(baseline?.pop1_win_rate)
    && rate(baseline?.pop1_top3_rate);
}

const raceIdValid = (id: unknown) => typeof id === "string" && /^\d{10,12}$/.test(id);
const dateValid = (date: unknown) => typeof date === "string" && /^20\d{2}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date));

Deno.serve(async req => {
 if (req.method !== "POST") return json({error:"Method not allowed"},405);
 let who: Identity;
 try { who = await identity(req); } catch { return json({error:"Unauthorized"},401); }
 try {
  const text = await req.text();
  if (text.length > 1_000_000) return json({error:"Too large"},413);
  const b = JSON.parse(text);
  if (!b || typeof b !== "object" || Array.isArray(b)) return json({error:"Invalid request"},400);
  const action = b.action;
  if (action === "health") return json({ok:true,identity:who});

  if (who === "github-capture") {
   const path = b.path;
   if (typeof path !== "string" || !/^daily\/(?:jra|nar)\/20\d{2}\/20\d{2}-\d{2}-\d{2}\.(?:tar\.gz|manifest\.json)$/.test(path)) return json({error:"Invalid archive path"},400);
   const storage = admin.storage.from("baken-archive");
   if (action === "exists") {
    // HEAD/exists reports missing objects as errors on this Storage deployment.
    // Listing the exact basename distinguishes absence from an actual service error.
    const split = path.lastIndexOf("/"), name = path.slice(split + 1);
    const objects = checked(await storage.list(path.slice(0, split), {search:name, limit:1}));
    return json({exists:objects.some((object:any)=>object.name===name)});
   }
   if (action === "sign-upload") { const value = checked(await storage.createSignedUploadUrl(path, {upsert:true})); return json({signed_url:value.signedUrl}); }
   if (action === "sign-download") { const value = checked(await storage.createSignedUrl(path, 600)); return json({signed_url:value.signedUrl}); }
   return json({error:"Forbidden action"},403);
  }

  if (who === "github-nar-analysis") {
   if (action === "nar-profile-upload") {
    if (typeof b.sha !== "string" || !/^[a-f0-9]{64}$/.test(b.sha)) return json({error:"Invalid profile"},400);
    const upload = checked(await admin.storage.from("baken-archive").createSignedUploadUrl(`nar/profiles/${b.sha}.json.gz`,{upsert:true}));
    return json({signed_url:upload.signedUrl});
   }
   if (action !== "publish-nar-analysis") return json({error:"Forbidden action"},403);
   const serialized = JSON.stringify(b.report);
   if (typeof serialized !== "string" || serialized.length > 900_000 || !validNarAnalysis(b.report)) return json({error:"Invalid NAR analysis report"},400);
   if (b.report.profileSha) {
    if (!/^[a-f0-9]{64}$/.test(b.report.profileSha)) return json({error:"Invalid profile"},400);
    const object = checked(await admin.storage.from("baken-archive").download(`nar/profiles/${b.report.profileSha}.json.gz`));
    if (object.size > 16_000_000) return json({error:"Profile too large"},413);
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256",await object.arrayBuffer()))].map(v=>v.toString(16).padStart(2,"0")).join("");
    if (digest !== b.report.profileSha) return json({error:"Profile checksum mismatch"},400);
   }
   checked(await admin.from("rein_nar_analysis_snapshots").upsert({id:true,report:b.report,updated_at:new Date().toISOString()}));
   return json({published:true});
  }

  if (action === "publish-nar-analysis") return json({error:"GitHub analysis workflow required"},403);
  if (action === "nar-analysis" && who !== "production" && who !== "preview") return json({error:"REIN reader required"},403);
  if (["save","save-schedule","claim","release","run"].includes(action) && who !== "production") return json({error:"Production writer required"},403);

  if (action === "nar-analysis") {
   const analysis = checked(await admin.from("rein_nar_analysis_snapshots").select("report,updated_at").eq("id",true).maybeSingle());
   const active = checked(await admin.from("rein_nar_model_releases").select("report,activated_at").eq("id",true).maybeSingle());
   return json({analysis,active});
  }
  if (action === "nar-profile") {
   const release = checked(await admin.from("rein_nar_model_releases").select("report,activated_at").eq("id",true).maybeSingle());
   const analysis = release ? {report:release.report,updated_at:release.activated_at} : null;
   const sha = analysis?.report?.profileSha;
   if (!sha || !/^[a-f0-9]{64}$/.test(sha)) return json({analysis,signed_url:null});
   const download = checked(await admin.storage.from("baken-archive").createSignedUrl(`nar/profiles/${sha}.json.gz`,600));
   return json({analysis,signed_url:download.signedUrl});
  }
  if (action === "save") {
   const record = snapshotRecord(b.payload,b.preview === true);
   const saved = checked(await admin.rpc("rein_store_race_snapshot",{r:record}));
   summaryCache.clear();
   return json({saved});
  }
  if (action === "read") {
   if (!raceIdValid(b.raceId)||!["live","preview","prestart"].includes(b.slot)) return json({error:"Invalid race"},400);
   const snapshot = checked(await admin.from("rein_race_snapshots").select("payload,generated_at,starts_at,is_final,slot,captured_at").eq("race_id",b.raceId).eq("slot",b.slot).maybeSingle());
   return json({snapshot});
  }
  if (action === "metas") {
   if (!dateValid(b.date)) return json({error:"Invalid date"},400);
   const snapshots = checked(await admin.from("rein_race_snapshots").select("race_id,slot,generated_at,starts_at,is_final,captured_at").eq("race_date",b.date).in("slot",["live","preview"]));
   return json({snapshots});
  }
  if (action === "schedule" || action === "save-schedule") {
   if (!dateValid(b.date)) return json({error:"Invalid date"},400);
   const league = b.league ?? "jra";
   if (!["jra","nar"].includes(league)) return json({error:"Invalid league"},400);
   if (action === "schedule") return json({schedule:checked(await admin.from("rein_schedule_snapshots").select("payload,generated_at").eq("race_date",b.date).eq("league",league).maybeSingle())});
   if (!Array.isArray(b.payload?.venues)||b.payload.venues.some((v:any)=>!Array.isArray(v.races)||v.races.some((r:any)=>!raceIdValid(r.raceId)))) return json({error:"Invalid schedule"},400);
   checked(await admin.from("rein_schedule_snapshots").upsert({race_date:b.date,league,payload:b.payload,generated_at:new Date().toISOString()}));
   return json({saved:true});
  }
  if (action === "calendar") {
   if ((who !== "production" && who !== "preview") || !dateValid(b.from) || !dateValid(b.to) || b.from > b.to || Date.parse(b.to)-Date.parse(b.from) > 32*86400_000 || !["jra","nar"].includes(b.league)) return json({error:"Invalid calendar range"},400);
   const schedules = checked(await admin.from("rein_schedule_snapshots").select("race_date,payload,generated_at").eq("league",b.league).gte("race_date",b.from).lte("race_date",b.to).order("race_date"));
   return json({schedules});
  }
  if (action === "history") {
   if (!raceIdValid(b.raceId)) return json({error:"Invalid race"},400);
   const league=b.league??"jra";
   if(!["jra","nar"].includes(league)||(league==="nar")!==(b.raceId.length===12))return json({error:"Invalid league"},400);
   const [rows,outcome] = await Promise.all([
    admin.from("rein_prediction_history").select("entry").eq("race_id",b.raceId).order("generated_at").limit(1000),
    admin.from("rein_race_outcomes").select("roster,finishers").eq("race_id",b.raceId).maybeSingle()
   ]);
   const result = checked(outcome);
   const entries = checked(rows).map((r:any)=>({...r.entry,...(result?.finishers && result.roster===r.entry.roster?{finishers:result.finishers}:{})}));
   if (!summaryCache.has(league) || summaryCache.get(league)!.until < Date.now()) summaryCache.set(league,{value:checked(await admin.rpc("rein_area_journal_summary",{p_league:league})),until:Date.now()+300_000});
   return json({entries,scope:"server",league,...(summaryCache.get(league)!.value as object)});
  }
  if (action === "claim") {
   if (typeof b.key!=="string"||!(/^(?:cron:|race:)/.test(b.key))) return json({error:"Invalid key"},400);
   const token = checked(await admin.rpc("rein_acquire_capture",{p_key:b.key,p_ttl:Math.min(300,Math.max(10,Number(b.ttl)||180))}));
   return json({acquired:!!token,token});
  }
  if (action === "release") {
   if (typeof b.key!=="string" || typeof b.token!=="string") return json({error:"Invalid lease"},400);
   checked(await admin.from("rein_capture_leases").delete().eq("key",b.key).eq("token",b.token));
   return json({ok:true});
  }
  if (action === "run") {
   if (!b.summary || JSON.stringify(b.summary).length>50_000) return json({error:"Invalid summary"},400);
   checked(await admin.from("rein_capture_runs").insert({summary:b.summary}));
   // Operational logs expire after 31 days; predictions and results are retained.
   checked(await admin.from("rein_capture_runs").delete().lt("checked_at",new Date(Date.now()-31*86400_000).toISOString()));
   return json({ok:true});
  }
  return json({error:"Unknown action"},400);
 } catch(error) {
  console.error("REIN snapshot operation failed",error instanceof Error ? error.message : "unknown");
  return json({error:"Snapshot operation failed"},500);
 }
});
