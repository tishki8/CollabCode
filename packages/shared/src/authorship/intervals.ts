// Half-open integer intervals [start, end) over Yjs clocks. A client's clocks only ever grow, so the
// set of "clocks we have already attributed" is a short list of intervals (usually just one).

export type Interval = readonly [start: number, end: number];

/** Sort and merge overlapping/touching intervals; drops empty ones. */
export function normalize(list: readonly Interval[]): Interval[] {
  const sorted = list.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

export const addInterval = (list: readonly Interval[], range: Interval): Interval[] => normalize([...list, range]);

/** The parts of [start, end) that are NOT inside `covered` (which must be normalized). */
export function subtract(range: Interval, covered: readonly Interval[]): Interval[] {
  const [start, end] = range;
  const out: Interval[] = [];
  let cursor = start;
  for (const [s, e] of covered) {
    if (e <= cursor) continue;
    if (s >= end) break;
    if (s > cursor) out.push([cursor, Math.min(s, end)]);
    cursor = Math.max(cursor, e);
    if (cursor >= end) break;
  }
  if (cursor < end) out.push([cursor, end]);
  return out;
}
