const normalize = (email: string | null | undefined) => String(email || "").trim().toLowerCase();

export function isReinAdmin(email: string | null | undefined) {
  if (!email) return false;
  const allowed = (process.env.REIN_ADMIN_EMAILS || "")
    .split(/[;,\n]/)
    .map(normalize)
    .filter(Boolean);
  return allowed.includes(normalize(email));
}
