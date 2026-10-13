// Session replay: rebuild a file's text at any point of its history from a starting state plus the
// recorded change events after it.
//
// The starting state is either empty (replay from the beginning) or a checkpoint's snapshot, so a long
// history can be played from a recent checkpoint and only the events after it are needed. Seeking
// forward applies events; seeking backward restarts from the nearest saved keyframe, so scrubbing
// stays cheap on long histories. Yjs is injected (see anchors.ts for why).
import type * as YNS from "yjs";
import { minimalReplacement } from "./diff";
import type { YLib } from "./anchors";

export interface ReplayStep {
  id: string;
  userId: string;
  startedAt: number;
  endedAt: number;
  origin: string;
  update: Uint8Array;
}

/** What one event did to the text. Offsets are into the text AFTER the event. */
export interface ReplayChange {
  from: number;
  inserted: string;
  removed: string;
}

export interface ReplayFrame {
  /** Index of the last applied event; -1 = the starting state (nothing applied yet). */
  index: number;
  text: string;
  /** What the last applied event changed (null at the starting state, or for an event that changed nothing visible). */
  change: ReplayChange | null;
}

export class ReplayEngine {
  private doc: YNS.Doc;
  private index = -1;
  private keyframes = new Map<number, Uint8Array>();
  private last: ReplayFrame;

  constructor(
    private Y: YLib,
    private base: Uint8Array,
    readonly steps: readonly ReplayStep[],
    private keyframeEvery = 100,
  ) {
    this.doc = this.fresh(base);
    this.last = { index: -1, text: this.text(), change: null };
  }

  private fresh(state: Uint8Array): YNS.Doc {
    const d = new this.Y.Doc();
    this.Y.applyUpdate(d, state);
    return d;
  }

  private text() {
    return this.doc.getText("content").toString();
  }

  private applyStep(i: number) {
    this.Y.applyUpdate(this.doc, this.steps[i]!.update, "replay");
    this.index = i;
    if ((i + 1) % this.keyframeEvery === 0 && !this.keyframes.has(i)) this.keyframes.set(i, this.Y.encodeStateAsUpdate(this.doc));
  }

  get length() {
    return this.steps.length;
  }

  /** The text after event `target` (-1 = starting state). */
  seek(target: number): ReplayFrame {
    const t = Math.max(-1, Math.min(target, this.steps.length - 1));
    if (t === this.index) return this.last;

    if (t < this.index) {
      // back up to the nearest keyframe at or before the target (or the starting state)
      let from = -1;
      for (const k of this.keyframes.keys()) if (k <= t - 1 && k > from) from = k;
      this.doc.destroy();
      this.doc = this.fresh(from === -1 ? this.base : this.keyframes.get(from)!);
      this.index = from;
    }
    if (t === -1) {
      this.last = { index: -1, text: this.text(), change: null };
      return this.last;
    }
    while (this.index < t - 1) this.applyStep(this.index + 1);
    const before = this.text();
    this.applyStep(t);
    const after = this.text();
    const r = minimalReplacement(before, after);
    this.last = {
      index: t,
      text: after,
      change: r ? { from: r.from, inserted: r.insert, removed: before.slice(r.from, r.from + r.deleteCount) } : null,
    };
    return this.last;
  }

  destroy() {
    this.doc.destroy();
  }
}

/** Indices of the events a viewer is stepping through: everyone's, or just one person's. */
export function visibleSteps(steps: readonly Pick<ReplayStep, "userId">[], userId: string | null): number[] {
  const out: number[] = [];
  steps.forEach((s, i) => {
    if (userId === null || s.userId === userId) out.push(i);
  });
  return out;
}

/**
 * How long to wait before showing the next event while playing: the real gap between the two events,
 * squeezed into a watchable range, divided by the speed.
 */
export function playbackDelay(gapMs: number, speed: number): number {
  const squeezed = Math.min(Math.max(gapMs, 150), 1500);
  return Math.max(30, squeezed / Math.max(speed, 0.1));
}
