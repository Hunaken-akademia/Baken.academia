import { createRemoteJWKSet, jwtVerify } from "jose";
import { hasBearerSecret } from "./internal-auth";
const issuer = "https://token.actions.githubusercontent.com";
const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks`));
export async function authorizedCapture(authorization: string | null, secret: string) {
  if (hasBearerSecret(authorization,secret)) return true;
  if (!authorization?.startsWith("Bearer ")) return false;
  try {
    const { payload } = await jwtVerify(authorization.slice(7),jwks,{issuer,audience:"rein-live-capture-v1"});
    const repository = payload.repository_id === "1376323200" && payload.repository === "Hunaken-akademia/Baken.academia" && payload.ref === "refs/heads/main";
    const workflow = String(payload.workflow_ref);
    const event = String(payload.event_name);
    const daily = workflow === "Hunaken-akademia/Baken.academia/.github/workflows/rein-daily-capture.yml@refs/heads/main" && ["schedule","workflow_dispatch","push"].includes(event);
    const backfill = workflow === "Hunaken-akademia/Baken.academia/.github/workflows/rein-year-backfill.yml@refs/heads/main" && event === "workflow_dispatch";
    return repository && (daily || backfill);
  } catch { return false; }
}
