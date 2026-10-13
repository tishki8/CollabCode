// Anchors for suggestions and comments: a range of a file's text that stays attached to the same
// characters while other people edit around (and inside) it.
//
// A line/column pair goes wrong the moment anyone adds a line above it. A Yjs RelativePosition names
// the CHARACTER (its immutable item id) the position sits next to, so it survives concurrent edits:
//  - start is attached to the first character of the range (text typed right before it stays outside)
//  - end is attached to the last character of the range (text typed right after it stays outside)
//  - text typed inside the range stretches it; if every character of the range is deleted it collapses
//
// A range with nothing selected (an insertion point) uses ONE position for both ends.
//
// Yjs is passed in (`Y`) instead of imported, so browsers, the API and the collab server each use their
// own single copy of the library: two copies in one process break Yjs' `instanceof` checks.
import type * as YNS from "yjs";
import { base64ToBytes, bytesToBase64 } from "./base64";

export type YLib = typeof YNS;

/** Wire format: base64 of Y.encodeRelativePosition. */
export interface Anchors {
  start: string;
  end: string;
  /** An insertion point (no text selected): `start` and `end` are the same position. */
  collapsed: boolean;
}

export interface ResolvedRange {
  /** UTF-16 offsets into the current text, from <= to. */
  from: number;
  to: number;
}

export function createAnchors(Y: YLib, ytext: YNS.Text, from: number, to: number): Anchors {
  const len = ytext.length;
  let a = Math.max(0, Math.min(from, len));
  let b = Math.max(0, Math.min(to, len));
  if (a > b) [a, b] = [b, a];
  const startPos = Y.createRelativePositionFromTypeIndex(ytext, a, 0);
  const start = bytesToBase64(Y.encodeRelativePosition(startPos));
  if (a === b) return { start, end: start, collapsed: true };
  const endPos = Y.createRelativePositionFromTypeIndex(ytext, b, -1);
  return { start, end: bytesToBase64(Y.encodeRelativePosition(endPos)), collapsed: false };
}

const indexOf = (Y: YLib, doc: YNS.Doc, ytext: YNS.Text, b64: string): number | null => {
  try {
    const abs = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(base64ToBytes(b64)), doc);
    if (!abs || abs.type !== ytext) return null;
    return abs.index;
  } catch {
    return null; // not a valid encoded position
  }
};

/** Where the anchored range is NOW, or null if the anchors are not valid positions in this text. */
export function resolveAnchors(Y: YLib, doc: YNS.Doc, ytext: YNS.Text, anchors: Anchors): ResolvedRange | null {
  const from = indexOf(Y, doc, ytext, anchors.start);
  if (from === null) return null;
  if (anchors.collapsed) return { from, to: from };
  const to = indexOf(Y, doc, ytext, anchors.end);
  if (to === null) return null;
  return { from, to: Math.max(from, to) };
}

/**
 * Did everything that was anchored get deleted? (A collapsed anchor is an insertion point and can
 * never become stale.)
 */
export const isGone = (anchors: Anchors, range: ResolvedRange | null): boolean =>
  range === null || (!anchors.collapsed && range.to <= range.from);
