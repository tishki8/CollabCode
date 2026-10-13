// Browser-side calls go through the Next.js rewrite at /api/v1 (same origin as the page).
export class ApiRequestError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Machine-readable reason from the API (e.g. LINK_EXPIRED), when there is one. */
    public code?: string,
  ) {
    super(message);
  }
}

/**
 * Who this page believes it is signed in as. Sent with every call so the server can refuse (409
 * IDENTITY_CHANGED) when the session cookie has since been replaced by another sign-in in the same browser.
 */
let expectedUserId: string | null = null;
export const setExpectedUser = (id: string | null) => {
  expectedUserId = id;
};

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (expectedUserId) headers["x-expected-user"] = expectedUserId;
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = Array.isArray(json.details) ? `: ${json.details.map((d: { message: string }) => d.message).join(", ")}` : "";
    if (json.code === "IDENTITY_CHANGED" && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("cc:identity-changed", { detail: json.details?.signedInAs ?? null }));
    }
    throw new ApiRequestError(res.status, (json.error ?? "Request failed") + detail, json.code);
  }
  return json as T;
}
