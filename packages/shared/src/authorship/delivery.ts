// What does an incoming Yjs update DELIVER? These functions answer, from the raw update bytes and
// the server's document, which item ranges are new, how much text they add, and how much existing
// text the update deletes. Attribution is decided here, at delivery, and not by diffing the
// document afterwards: a transaction that happens to apply an earlier, held-back update would
// otherwise credit that text to whoever delivered the missing piece (see README, "Authorship design").
import * as Y from "yjs";
import { subtract, type Interval } from "./intervals";

/** One struct of a decoded update. `text` is its string content (null for deleted/non-text items). */
export interface DeliveredStruct {
  client: number;
  clock: number;
  length: number;
  text: string | null;
}

/** A range of item IDs that is new to the server, with what it adds. */
export interface NewRange {
  client: number;
  start: number;
  end: number;
  /** Characters inserted (UTF-16 code units, the same unit Monaco offsets use). */
  added: number;
  /** Newline characters among them. */
  linesAdded: number;
}

export const countNewlines = (s: string) => {
  let n = 0;
  for (let i = s.indexOf("\n"); i !== -1; i = s.indexOf("\n", i + 1)) n++;
  return n;
};

export function decodeDelivered(update: Uint8Array): DeliveredStruct[] {
  const out: DeliveredStruct[] = [];
  for (const s of Y.decodeUpdate(update).structs) {
    // A "Skip" marks a gap the sender does not have: nothing is delivered for it.
    if (s.constructor.name === "Skip") continue;
    const content = (s as unknown as { content?: { constructor: { name: string }; str?: string } }).content;
    out.push({
      client: s.id.client,
      clock: s.id.clock,
      length: s.length,
      text: content?.constructor.name === "ContentString" ? (content.str ?? null) : null,
    });
  }
  return out;
}

/**
 * The parts of the delivered structs that were not seen before.
 * "Seen before" = already applied to the document (clock < its current clock for that client)
 * or already attributed earlier (`covered`, which also catches held-back pending items).
 */
export function newRangesOf(
  structs: readonly DeliveredStruct[],
  coveredOf: (client: number) => readonly Interval[],
  docClockOf: (client: number) => number,
): NewRange[] {
  const byClient = new Map<number, NewRange[]>();
  for (const st of structs) {
    const known: Interval[] = [[0, docClockOf(st.client)], ...coveredOf(st.client)];
    const normalized = known.sort((a, b) => a[0] - b[0]);
    // subtract() needs a normalized list
    const merged: [number, number][] = [];
    for (const [s, e] of normalized) {
      const last = merged[merged.length - 1];
      if (last && s <= last[1]) last[1] = Math.max(last[1], e);
      else if (e > s) merged.push([s, e]);
    }
    for (const [start, end] of subtract([st.clock, st.clock + st.length], merged)) {
      const slice = st.text === null ? "" : st.text.slice(start - st.clock, end - st.clock);
      const list = byClient.get(st.client) ?? [];
      const prev = list[list.length - 1];
      if (prev && prev.end === start) {
        prev.end = end;
        prev.added += slice.length;
        prev.linesAdded += countNewlines(slice);
      } else {
        list.push({ client: st.client, start, end, added: slice.length, linesAdded: countNewlines(slice) });
      }
      byClient.set(st.client, list);
    }
  }
  return [...byClient.values()].flat();
}

/**
 * Existing text this update deletes, measured BEFORE it is applied (afterwards Yjs may already have
 * discarded the content). Only items that are present and not yet deleted count.
 */
export function removedBy(update: Uint8Array, doc: Y.Doc): { chars: number; lines: number } {
  let chars = 0;
  let lines = 0;
  const { ds } = Y.decodeUpdate(update);
  for (const [client, ranges] of ds.clients) {
    const structs = doc.store.clients.get(client);
    if (!structs?.length) continue;
    for (const { clock, len } of ranges) {
      const end = clock + len;
      // Skip ranges the document does not have yet (held-back items).
      if (clock >= structs[structs.length - 1]!.id.clock + structs[structs.length - 1]!.length) continue;
      for (let i = Y.findIndexSS(structs, clock); i < structs.length; i++) {
        const item = structs[i]!;
        if (item.id.clock >= end) break;
        if (!(item instanceof Y.Item) || item.deleted) continue;
        const content = item.content as unknown as { constructor: { name: string }; str?: string };
        if (content.constructor.name !== "ContentString" || content.str === undefined) continue;
        const from = Math.max(clock, item.id.clock) - item.id.clock;
        const to = Math.min(end, item.id.clock + item.length) - item.id.clock;
        const slice = content.str.slice(from, to);
        chars += slice.length;
        lines += countNewlines(slice);
      }
    }
  }
  return { chars, lines };
}

/** Does the update contain any deletions at all? */
export const hasDeletions = (update: Uint8Array): boolean => {
  for (const ranges of Y.decodeUpdate(update).ds.clients.values()) if (ranges.length > 0) return true;
  return false;
};
