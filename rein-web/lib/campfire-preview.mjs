import { createHmac, timingSafeEqual } from "node:crypto";
const sign = (key, subject, snapshot, time) => createHmac("sha256", key).update(JSON.stringify([subject, snapshot, time])).digest("hex");
export function createPreviewToken(key, subject, snapshot, now = Date.now()) {
  return String(now) + "." + sign(key, subject, snapshot, now);
}
export function verifyPreviewToken(token, key, subject, snapshot, now = Date.now()) {
  if (typeof token !== "string" || !/^\d+\.[a-f0-9]{64}$/.test(token)) return false;
  const [stamp, signature] = token.split(".");
  const time = Number(stamp);
  if (!Number.isSafeInteger(time) || time > now || now - time >= 600000) return false;
  return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(sign(key, subject, snapshot, time), "hex"));
}
