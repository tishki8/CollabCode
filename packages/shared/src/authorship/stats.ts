// Contribution statistics from the event log. Everything here works on plain event summaries, so it is
// cheap to compute in SQL-selected rows and easy to test.

export interface EventSummary {
  userId: string;
  startedAt: number; // ms
  endedAt: number; // ms
  added: number;
  removed: number;
  linesAdded: number;
  linesRemoved: number;
}

/** Gaps shorter than this between a person's edits count as one continuous working session. */
export const SESSION_GAP_MS = 5 * 60_000;

export interface Session {
  start: number;
  end: number;
}

/** A person's working sessions: events closer together than `gapMs` are bridged into one. */
export function sessionsOf(events: readonly Pick<EventSummary, "startedAt" | "endedAt">[], gapMs = SESSION_GAP_MS): Session[] {
  const sorted = [...events].sort((a, b) => a.startedAt - b.startedAt);
  const out: Session[] = [];
  for (const e of sorted) {
    const last = out[out.length - 1];
    if (last && e.startedAt - last.end <= gapMs) last.end = Math.max(last.end, e.endedAt);
    else out.push({ start: e.startedAt, end: Math.max(e.startedAt, e.endedAt) });
  }
  return out;
}

/** Total working time: the sum of the sessions. */
export const activeTimeOf = (events: readonly Pick<EventSummary, "startedAt" | "endedAt">[], gapMs = SESSION_GAP_MS): number =>
  sessionsOf(events, gapMs).reduce((t, s) => t + (s.end - s.start), 0);

export interface PersonTotals {
  userId: string;
  added: number;
  removed: number;
  linesAdded: number;
  linesRemoved: number;
  activeMs: number;
  sessions: number;
  firstAt: number;
  lastAt: number;
}

/** Totals per person. Returned in order of first activity (deliberately not by amount: no leaderboard). */
export function totalsByUser(events: readonly EventSummary[], gapMs = SESSION_GAP_MS): PersonTotals[] {
  const byUser = new Map<string, EventSummary[]>();
  for (const e of events) byUser.set(e.userId, [...(byUser.get(e.userId) ?? []), e]);
  return [...byUser.entries()]
    .map(([userId, list]) => {
      const sessions = sessionsOf(list, gapMs);
      return {
        userId,
        added: sum(list, "added"),
        removed: sum(list, "removed"),
        linesAdded: sum(list, "linesAdded"),
        linesRemoved: sum(list, "linesRemoved"),
        activeMs: sessions.reduce((t, s) => t + (s.end - s.start), 0), // same as activeTimeOf(list)
        sessions: sessions.length,
        firstAt: Math.min(...list.map((e) => e.startedAt)),
        lastAt: Math.max(...list.map((e) => e.endedAt)),
      };
    })
    .sort((a, b) => a.firstAt - b.firstAt || (a.userId < b.userId ? -1 : 1));
}

const sum = (list: readonly EventSummary[], key: "added" | "removed" | "linesAdded" | "linesRemoved") =>
  list.reduce((t, e) => t + e[key], 0);

export interface TimelineCell {
  added: number;
  removed: number;
  /** Milliseconds of working sessions that fall inside this bucket. */
  activeMs: number;
}

export interface Timeline {
  from: number;
  bucketMs: number;
  buckets: number;
  /** One lane per person, in order of first activity. */
  lanes: { userId: string; cells: TimelineCell[] }[];
}

/** Per-person activity over time: one lane per person, one cell per time bucket. */
export function timeline(events: readonly EventSummary[], from: number, to: number, bucketMs: number, gapMs = SESSION_GAP_MS): Timeline {
  const buckets = Math.max(1, Math.ceil((to - from) / bucketMs));
  const order = totalsByUser(events, gapMs).map((t) => t.userId);
  const lanes = order.map((userId) => {
    const cells: TimelineCell[] = Array.from({ length: buckets }, () => ({ added: 0, removed: 0, activeMs: 0 }));
    const mine = events.filter((e) => e.userId === userId);
    for (const e of mine) {
      const i = Math.floor((e.endedAt - from) / bucketMs);
      if (i >= 0 && i < buckets) {
        cells[i]!.added += e.added;
        cells[i]!.removed += e.removed;
      }
    }
    for (const s of sessionsOf(mine, gapMs)) {
      for (let i = Math.max(0, Math.floor((s.start - from) / bucketMs)); i < buckets; i++) {
        const bStart = from + i * bucketMs;
        if (bStart >= s.end) break;
        cells[i]!.activeMs += Math.max(0, Math.min(s.end, bStart + bucketMs) - Math.max(s.start, bStart));
      }
    }
    return { userId, cells };
  });
  return { from, bucketMs, buckets, lanes };
}

/** "1 h 5 min", "12 min", "< 1 min". */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "< 1 min";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
