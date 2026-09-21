import { timingSafeEqual } from "node:crypto";

export function hasBearerSecret(authorization: string | null, secret: string) {
  if (!secret) return false;
  const supplied = Buffer.from(authorization || "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
