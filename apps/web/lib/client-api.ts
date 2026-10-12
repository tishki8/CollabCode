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

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = Array.isArray(json.details) ? `: ${json.details.map((d: { message: string }) => d.message).join(", ")}` : "";
    throw new ApiRequestError(res.status, (json.error ?? "Request failed") + detail, json.code);
  }
  return json as T;
}
