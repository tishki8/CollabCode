// Blame: who wrote each line, computed from the LIVE Y.Text plus the attribution ranges.
//
// Every live character sits in a Yjs item with an immutable ID (client, clock). Consecutive typing by
// one client is one item, and a paste is one item, so the number of runs follows how often authorship
// changes, not the number of characters. An attribution range says "ids client:[start,end) were
// first delivered by user U at time T"; blame is just a join between the two.
import type * as Y from "yjs";

export interface TextRun {
  /** Offset of the run's first character in the text (UTF-16 units, same as Monaco). */
  offset: number;
  length: number;
  client: number;
  clock: number;
}

/** The live characters of `ytext` as runs of consecutive item ids. */
export function textRuns(ytext: Y.Text): TextRun[] {
  const out: TextRun[] = [];
  let offset = 0;
  for (let item = ytext._start; item !== null; item = item.right) {
    if (item.deleted || !item.countable) continue;
    out.push({ offset, length: item.length, client: item.id.client, clock: item.id.clock });
    offset += item.length;
  }
  return out;
}

export interface AttributionRange {
  client: number;
  /** Item ids client:[start, end). */
  start: number;
  end: number;
  user: string;
  /** Server time (ms since epoch) the range was written. */
  at: number;
}

/** Lookup of attribution ranges by Yjs item id. */
export class AttributionIndex {
  private byClient = new Map<number, AttributionRange[]>();
  private dirty = new Set<number>();

  constructor(ranges: Iterable<AttributionRange> = []) {
    this.add(ranges);
  }

  add(ranges: Iterable<AttributionRange>) {
    for (const r of ranges) {
      if (r.end <= r.start) continue;
      const list = this.byClient.get(r.client) ?? [];
      list.push(r);
      this.byClient.set(r.client, list);
      this.dirty.add(r.client);
    }
  }

  private sorted(client: number): AttributionRange[] {
    const list = this.byClient.get(client) ?? [];
    if (this.dirty.has(client)) {
      list.sort((a, b) => a.start - b.start);
      this.dirty.delete(client);
    }
    return list;
  }

  /** Index of the last range starting at or before `clock`, or -1. */
  private floor(list: AttributionRange[], clock: number): number {
    let lo = 0;
    let hi = list.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]!.start <= clock) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  }

  lookup(client: number, clock: number): AttributionRange | null {
    const list = this.sorted(client);
    const i = this.floor(list, clock);
    return i >= 0 && list[i]!.end > clock ? list[i]! : null;
  }

  /** Start of the first range after `clock` (where an unattributed gap ends), or null. */
  nextStart(client: number, clock: number): number | null {
    const list = this.sorted(client);
    const i = this.floor(list, clock);
    return list[i + 1]?.start ?? null;
  }

  get size() {
    let n = 0;
    for (const l of this.byClient.values()) n += l.length;
    return n;
  }
}

/** A stretch of text with one author. `user` is null when nothing is on record (e.g. text from before tracking). */
export interface Piece {
  offset: number;
  length: number;
  user: string | null;
  at: number | null;
}

/**
 * Split runs into pieces by author. `fallback` lets a caller attribute ids the server has not
 * reported yet, e.g. your own fresh typing, which you know is yours before it is saved.
 */
export function attribute(
  runs: readonly TextRun[],
  index: AttributionIndex,
  fallback?: (client: number) => { user: string; at: number } | null,
): Piece[] {
  const pieces: Piece[] = [];
  for (const run of runs) {
    let clock = run.clock;
    let offset = run.offset;
    const end = run.clock + run.length;
    while (clock < end) {
      const range = index.lookup(run.client, clock);
      if (range) {
        const len = Math.min(range.end, end) - clock;
        pieces.push({ offset, length: len, user: range.user, at: range.at });
        clock += len;
        offset += len;
      } else {
        const next = index.nextStart(run.client, clock);
        const len = Math.min(next ?? Infinity, end) - clock;
        const fb = fallback?.(run.client) ?? null;
        pieces.push({ offset, length: len, user: fb?.user ?? null, at: fb?.at ?? null });
        clock += len;
        offset += len;
      }
    }
  }
  return pieces;
}

export interface LineAuthor {
  user: string | null;
  /** Non-whitespace characters on this line written by them. */
  chars: number;
  /** Latest time they wrote something on this line. */
  lastAt: number | null;
}

export interface LineBlame {
  /** 1-based, like editors show. */
  line: number;
  /** Everyone with text on the line, main author first. */
  authors: LineAuthor[];
  main: LineAuthor | null;
  /** How many other authors besides the main one. */
  others: number;
}

/** Per-line authors. The main author is whoever wrote the most (non-whitespace) characters on the line. */
export function blameLines(text: string, pieces: readonly Piece[]): LineBlame[] {
  const lineStarts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lineStarts.push(i + 1);

  const lineOf = (offset: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  type Acc = { nonWs: number; all: number; lastAt: number | null };
  const perLine: Map<string, Acc>[] = lineStarts.map(() => new Map());

  for (const p of pieces) {
    const end = Math.min(p.offset + p.length, text.length);
    for (let pos = p.offset; pos < end; ) {
      const li = lineOf(pos);
      const lineEnd = li + 1 < lineStarts.length ? lineStarts[li + 1]! : text.length;
      const segEnd = Math.min(end, lineEnd);
      let nonWs = 0;
      for (let i = pos; i < segEnd; i++) if (!/\s/.test(text[i]!)) nonWs++;
      const key = p.user ?? "";
      const acc = perLine[li]!.get(key) ?? { nonWs: 0, all: 0, lastAt: null };
      acc.nonWs += nonWs;
      acc.all += segEnd - pos;
      if (p.at !== null) acc.lastAt = Math.max(acc.lastAt ?? 0, p.at);
      perLine[li]!.set(key, acc);
      pos = segEnd;
    }
  }

  return perLine.map((m, i) => {
    const authors = [...m.entries()]
      .sort(
        ([ka, a], [kb, b]) =>
          b.nonWs - a.nonWs || b.all - a.all || (b.lastAt ?? 0) - (a.lastAt ?? 0) || (ka < kb ? -1 : ka > kb ? 1 : 0),
      )
      .map(([key, a]) => ({ user: key === "" ? null : key, chars: a.nonWs, lastAt: a.lastAt }));
    return { line: i + 1, authors, main: authors[0] ?? null, others: Math.max(0, authors.length - 1) };
  });
}

/** Convenience: blame for a Y.Text in one call. */
export function blameYText(
  ytext: Y.Text,
  index: AttributionIndex,
  fallback?: (client: number) => { user: string; at: number } | null,
): { lines: LineBlame[]; pieces: Piece[] } {
  const text = ytext.toString();
  const pieces = attribute(textRuns(ytext), index, fallback);
  return { lines: blameLines(text, pieces), pieces };
}
