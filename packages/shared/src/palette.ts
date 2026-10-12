// Author colours. Okabe-Ito (colour-blind safe) plus four Tol colours. Colour is
// never the only signal: the UI always shows initials/name next to it.
export const AUTHOR_PALETTE = [
  "#E69F00", // orange
  "#56B4E9", // sky blue
  "#009E73", // bluish green
  "#F0E442", // yellow
  "#0072B2", // blue
  "#D55E00", // vermillion
  "#CC79A7", // reddish purple
  "#999999", // grey
  "#332288", // indigo
  "#882255", // wine
  "#117733", // forest
  "#44AA99", // teal
] as const;

/** Pick the first palette colour not already used; wrap around when all are taken. */
export function pickColor(used: readonly string[]): string {
  const free = AUTHOR_PALETTE.find((c) => !used.includes(c));
  return free ?? AUTHOR_PALETTE[used.length % AUTHOR_PALETTE.length]!;
}

/** "Ada Lovelace" -> "AL", "ada" -> "A". Falls back to "?" for empty names. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = Array.from(parts[0]!)[0] ?? "?";
  const last = parts.length > 1 ? (Array.from(parts[parts.length - 1]!)[0] ?? "") : "";
  return (first + last).toUpperCase();
}
