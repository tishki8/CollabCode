/**
 * Accepts only same-site relative paths ("/join/abc", "/p/1?file=2") for post-login redirects,
 * so a crafted `?callbackUrl=https://evil.example` or `//evil.example` can't bounce a user
 * to another site after they sign in.
 */
export function safeRedirectPath(input: unknown, fallback = "/dashboard"): string {
  if (typeof input !== "string" || input.length === 0 || input.length > 2048) return fallback;
  // must be a single-slash path; "//host" and "/\host" are treated as absolute by browsers
  if (!input.startsWith("/") || input.startsWith("//") || input.startsWith("/\\")) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(input)) return fallback;
  try {
    const u = new URL(input, "http://placeholder.invalid");
    if (u.origin !== "http://placeholder.invalid") return fallback;
  } catch {
    return fallback;
  }
  return input;
}
