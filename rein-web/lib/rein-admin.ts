const normalize = (email) => String(email || "").trim().toLowerCase();

export function isReinAdmin(email) {
  if (!email) return false;
  const allowed = (process.env.REIN_ADMIN_EMAILS || "")
    .split(/[;,\n]/)
    .map(normalize)
    .filter(Boolean);
  return allowed.includes(normalize(email));
}
