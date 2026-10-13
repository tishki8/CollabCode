// History diff: replay a file's events, in order, onto a document that keeps deleted text, and record
// exactly what one person inserted and removed (with line numbers) in a time range.
//
// Limits (documented in the README): replay starts from the beginning of the log because there are no
// older snapshots until checkpoints exist, and events are ordered by when they started, so under
// heavy concurrent editing the line numbers are "as of replay" and approximate.
import * as Y from "yjs";

export interface ReplayEvent {
  id: bigint | number | string;
  userId: string;
  startedAt: number;
  endedAt: number;
  update: Uint8Array;
}

export interface Hunk {
  kind: "add" | "del";
  /** 1-based line where the change happened. */
  line: number;
  text: string;
}

export interface EventChange {
  eventId: string;
  userId: string;
  at: number;
  hunks: Hunk[];
}

const lineAt = (text: string, offset: number) => {
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) n++;
  return n;
};

/** Order used for replay: when each batch started, then log order. */
export const replayOrder = (a: ReplayEvent, b: ReplayEvent) =>
  a.startedAt - b.startedAt || (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);

export function replayChanges(
  events: readonly ReplayEvent[],
  filter: { userId?: string; from?: number; to?: number },
): EventChange[] {
  const doc = new Y.Doc({ gc: false }); // keep deleted content so removed text can be shown
  const text = doc.getText("content");
  const out: EventChange[] = [];
  let current: EventChange | null = null;

  text.observe((ev) => {
    if (!current) return;
    const before = prev;
    let oldPos = 0;
    let newPos = 0;
    const after = text.toString();
    for (const op of ev.delta) {
      if (op.retain) {
        oldPos += op.retain;
        newPos += op.retain;
      } else if (typeof op.insert === "string") {
        current.hunks.push({ kind: "add", line: lineAt(after, newPos), text: op.insert });
        newPos += op.insert.length;
      } else if (op.delete) {
        current.hunks.push({ kind: "del", line: lineAt(before, oldPos), text: before.slice(oldPos, oldPos + op.delete) });
        oldPos += op.delete;
      }
    }
  });

  let prev = "";
  for (const e of [...events].sort(replayOrder)) {
    const wanted =
      (filter.userId === undefined || e.userId === filter.userId) &&
      (filter.from === undefined || e.endedAt >= filter.from) &&
      (filter.to === undefined || e.endedAt <= filter.to);
    current = wanted ? { eventId: String(e.id), userId: e.userId, at: e.endedAt, hunks: [] } : null;
    Y.applyUpdate(doc, e.update, "replay");
    if (current && current.hunks.length > 0) out.push(current);
    current = null;
    prev = text.toString();
  }
  doc.destroy();
  return out;
}
