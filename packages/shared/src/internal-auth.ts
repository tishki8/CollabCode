// Service-to-service authentication: the API calls the collab server's /internal endpoints (apply an
// edit as a given user, flush documents). Each request carries a timestamp and an HMAC of
// "timestamp.body" made with the secret both services already share, so a captured request cannot be
// replayed later or with a different body. The endpoints must also not be reachable from the internet.
import { createHmac, timingSafeEqual } from "node:crypto";

export const INTERNAL_MAX_SKEW_MS = 60_000;

const mac = (secret: string, ts: string, body: string) => createHmac("sha256", `collab-internal:${secret}`).update(`${ts}.${body}`).digest("hex");

export function signInternal(secret: string, body: string, now = Date.now()): { timestamp: string; signature: string } {
  const timestamp = String(now);
  return { timestamp, signature: mac(secret, timestamp, body) };
}

export function verifyInternal(secret: string, body: string, timestamp: string | undefined, signature: string | undefined, now = Date.now()): boolean {
  if (!timestamp || !signature || !/^\d{10,16}$/.test(timestamp)) return false;
  if (Math.abs(now - Number(timestamp)) > INTERNAL_MAX_SKEW_MS) return false;
  const expected = Buffer.from(mac(secret, timestamp, body));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
