import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"
import { createRemoteJWKSet, jwtVerify } from "npm:jose@6"

const GITHUB_ISSUER = "https://token.actions.githubusercontent.com"
const AUDIENCE = "rein-supabase-model-v1"
const REPOSITORY = "Hunaken-akademia/Baken.academia"
const REF = "refs/heads/main"
const WORKFLOW_REF = `${REPOSITORY}/.github/workflows/rein-role-model-to-supabase.yml@${REF}`
const BUCKET = "baken-archive"
const PATH_PATTERN = /^rein\/models\/v4\/(rein-role-v4-[0-9a-f]{7,40})\/(?:bundle\.tar\.gz|manifest\.json)$/
const JWKS = createRemoteJWKSet(new URL(`${GITHUB_ISSUER}/.well-known/jwks`))

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  })
}

async function authorize(req: Request) {
  const header = req.headers.get("authorization") ?? ""
  if (!header.startsWith("Bearer ")) throw new Error("Missing GitHub OIDC token")
  const { payload } = await jwtVerify(header.slice(7), JWKS, {
    issuer: GITHUB_ISSUER,
    audience: AUDIENCE,
  })
  if (payload.repository !== REPOSITORY || payload.ref !== REF || payload.workflow_ref !== WORKFLOW_REF) {
    throw new Error("GitHub Actions claims are not authorized")
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
    if (Number(req.headers.get("content-length") ?? "0") > 32768) {
      return json({ error: "Request too large" }, 413)
    }
    const claims = await authorize(req)
    const body = await req.json()
    const action = String(body.action ?? "")
    if (action === "health") return json({ ok: true, repository: claims.repository, ref: claims.ref })

    if (action === "activate") {
      const version = String(body.version ?? "")
      const manifestPath = `rein/models/v4/${version}/manifest.json`
      const bundlePath = `rein/models/v4/${version}/bundle.tar.gz`
      if (!PATH_PATTERN.test(manifestPath) || !PATH_PATTERN.test(bundlePath)) {
        return json({ error: "Version is not allowed" }, 400)
      }
      const storage = supabase.storage.from(BUCKET)
      const [manifestExists, bundleExists] = await Promise.all([
        storage.exists(manifestPath), storage.exists(bundlePath),
      ])
      if (!manifestExists.data || !bundleExists.data) {
        return json({ error: "Bundle or manifest is missing" }, 409)
      }
      const { data, error } = await supabase.rpc("activate_rein_model_version", {
        p_version: version,
        p_manifest_path: manifestPath,
        p_trained_through: String(body.trained_through ?? ""),
        p_history_through: String(body.history_through ?? ""),
        p_feature_count: Number(body.feature_count ?? 0),
        p_artifact_sha256: String(body.artifact_sha256 ?? ""),
        p_artifact_size_bytes: Number(body.artifact_size_bytes ?? 0),
        p_source_commit: String(claims.sha ?? ""),
        p_metrics: body.metrics ?? {},
      })
      if (error) throw error
      return json({ ok: true, model: data })
    }

    const path = String(body.path ?? "")
    if (!PATH_PATTERN.test(path)) return json({ error: "Object path is not allowed" }, 400)
    const storage = supabase.storage.from(BUCKET)
    if (action === "exists") {
      const { data } = await storage.exists(path)
      return json({ exists: Boolean(data) })
    }
    if (action === "sign-upload") {
      const { data, error } = await storage.createSignedUploadUrl(path, { upsert: true })
      if (error) throw error
      return json({ path: data.path, signed_url: data.signedUrl, expires_in: 7200 })
    }
    if (action === "sign-download") {
      const { data, error } = await storage.createSignedUrl(path, 600)
      if (error) throw error
      return json({ path, signed_url: data.signedUrl, expires_in: 600 })
    }
    return json({ error: "Unknown action" }, 400)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return json({ error: "Unauthorized or invalid request" }, 401)
  }
})
