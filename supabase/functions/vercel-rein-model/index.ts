import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"
import { createRemoteJWKSet, jwtVerify } from "npm:jose@6"

const ISSUER = "https://oidc.vercel.com/hunaken-akademia"
const AUDIENCE = "https://vercel.com/hunaken-akademia"
const OWNER_ID = "team_JoV13Y5pkEXrjvf8JCKP6tNY"
const PROJECT_ID = "prj_8X6LIxRxvKKNyVQWxFKF6AQJ6wrm"
const BUCKET = "baken-archive"
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks`))

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  })
}

async function authorize(req: Request) {
  const header = req.headers.get("authorization") ?? ""
  if (!header.startsWith("Bearer ")) throw new Error("Missing Vercel OIDC token")
  const { payload } = await jwtVerify(header.slice(7), JWKS, {
    issuer: ISSUER,
    audience: AUDIENCE,
  })
  if (payload.owner_id !== OWNER_ID || payload.project_id !== PROJECT_ID) {
    throw new Error("Vercel project is not authorized")
  }
  if (!new Set(["production", "preview"]).has(String(payload.environment ?? ""))) {
    throw new Error("Vercel environment is not authorized")
  }
  return payload
}

const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")
const adminKey = secretKeys.default ?? Object.values(secretKeys).find((value) => typeof value === "string")
if (!adminKey) throw new Error("No Supabase secret key is available to this function")
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, adminKey as string, {
  auth: { autoRefreshToken: false, persistSession: false },
})

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
  try {
    await authorize(req)
    const { data: model, error: registryError } = await supabase
      .from("rein_model_versions")
      .select("version,manifest_path,trained_through,history_through,feature_count,artifact_sha256,artifact_size_bytes,metrics,activated_at")
      .eq("status", "ready")
      .single()
    if (registryError || !model) return json({ error: "No active REIN model" }, 404)
    const bundlePath = model.manifest_path.replace(/manifest\.json$/, "bundle.tar.gz")
    const [{ data: bundle, error: bundleError }, { data: manifest, error: manifestError }] = await Promise.all([
      supabase.storage.from(BUCKET).createSignedUrl(bundlePath, 300),
      supabase.storage.from(BUCKET).createSignedUrl(model.manifest_path, 300),
    ])
    if (bundleError || manifestError) throw bundleError ?? manifestError
    return json({
      model,
      bundle_url: bundle.signedUrl,
      manifest_url: manifest.signedUrl,
      expires_in: 300,
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return json({ error: "Unauthorized request" }, 401)
  }
})
