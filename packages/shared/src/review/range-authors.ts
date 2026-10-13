// Whose code does a suggestion change? The authors of the characters in its range, from the same
// attribution pieces the blame view uses. An insertion point has no characters of its own, so it
// looks at the characters either side of it.
import type { Piece } from "../authorship/blame";

export interface RangeAuthor {
  /** null = no author on record (e.g. text written before tracking). */
  user: string | null;
  chars: number;
}

export function authorsOfRange(pieces: readonly Piece[], from: number, to: number): RangeAuthor[] {
  const a = from === to ? Math.max(0, from - 1) : from;
  const b = from === to ? from + 1 : to;
  const totals = new Map<string | null, number>();
  for (const p of pieces) {
    const overlap = Math.min(p.offset + p.length, b) - Math.max(p.offset, a);
    if (overlap > 0) totals.set(p.user, (totals.get(p.user) ?? 0) + overlap);
  }
  return [...totals.entries()]
    .map(([user, chars]) => ({ user, chars }))
    .sort((x, y) => y.chars - x.chars || String(x.user).localeCompare(String(y.user)));
}
