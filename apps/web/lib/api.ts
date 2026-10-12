import { cookies } from "next/headers";

const API_URL = process.env.API_URL ?? "http://localhost:4000";

/** Server-side call to the REST API on behalf of the signed-in user (forwards their cookie). */
export async function serverApi<T>(path: string): Promise<{ status: number; data: T | null }> {
  const cookie = (await cookies()).toString();
  const res = await fetch(`${API_URL}${path}`, { headers: { cookie }, cache: "no-store" });
  if (!res.ok) return { status: res.status, data: null };
  return { status: res.status, data: (await res.json()) as T };
}

/** Server-side POST on behalf of the visitor (used for the public link preview). */
export async function serverApiPost<T>(
  path: string,
  body: unknown,
): Promise<{ status: number; data: T | null; error?: { error: string; code?: string } }> {
  const cookie = (await cookies()).toString();
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) return { status: res.status, data: null, error: await res.json().catch(() => ({ error: "Request failed" })) };
  return { status: res.status, data: (await res.json()) as T };
}
