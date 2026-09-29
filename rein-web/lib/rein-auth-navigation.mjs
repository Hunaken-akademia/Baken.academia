export const ADMIN_MEMBERS_PATH = "/admin/members";
export const LOGIN_DESTINATION_COOKIE = "rein_login_destination";

export function safeNextPath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u0020]/.test(value)) return "/";
  const base = "https://rein.invalid";
  const url = new URL(value, base);
  return url.origin === base ? url.pathname + url.search + url.hash : "/";
}

// Preserve the admin destination without changing the allowlisted OAuth callback URL.
export function loginDestination(next, cookieValue) {
  return cookieValue === ADMIN_MEMBERS_PATH ? ADMIN_MEMBERS_PATH : safeNextPath(next);
}
