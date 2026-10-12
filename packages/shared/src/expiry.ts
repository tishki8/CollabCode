import type { LinkExpiryChoice } from "./schemas";

const MS: Record<Exclude<LinkExpiryChoice, "never">, number> = {
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

/** The moment a link created `now` with this choice expires; null means it never does. */
export function expiryDate(choice: LinkExpiryChoice, now: Date = new Date()): Date | null {
  return choice === "never" ? null : new Date(now.getTime() + MS[choice]);
}

export function isExpired(expiresAt: Date | string | null, now: Date = new Date()): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() <= now.getTime();
}

/** "in 3 hours", "in 6 days", "never", or "expired": for the owner's link list. */
export function describeExpiry(expiresAt: Date | string | null, now: Date = new Date()): string {
  if (!expiresAt) return "never expires";
  const ms = new Date(expiresAt).getTime() - now.getTime();
  if (ms <= 0) return "expired";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `expires in ${minutes} min`;
  const hours = Math.ceil(ms / 3_600_000);
  if (hours < 48) return `expires in ${hours} h`;
  return `expires in ${Math.ceil(ms / 86_400_000)} days`;
}
