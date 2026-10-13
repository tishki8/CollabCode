import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createAnchors, isGone, minimalReplacement, resolveAnchors, base64ToBytes, bytesToBase64, ReplayEngine, visibleSteps, playbackDelay, authorsOfRange, type Anchors, type ReplayStep } from "../index";

/** Two peers editing the same text that sync on demand. */
function peers(initial: string) {
  const a = new Y.Doc();
  a.clientID = 1;
  a.getText("content").insert(0, initial);
  const b = new Y.Doc();
  b.clientID = 2;
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const sync = () => {
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
  };
  return { a, b, ta: a.getText("content"), tb: b.getText("content"), sync };
}

const where = (doc: Y.Doc, anchors: Anchors) => {
  const text = doc.getText("content");
  const r = resolveAnchors(Y, doc, text, anchors);
  return r && { ...r, text: text.toString().slice(r.from, r.to) };
};

describe("anchors survive concurrent edits", () => {
  const code = "def f():\n    return 1\n\nprint(f())\n";
  const target = "return 1";
  const at = code.indexOf(target);

  it("resolves to the selected text right after creation", () => {
    const { a, ta } = peers(code);
    const anchors = createAnchors(Y, ta, at, at + target.length);
    expect(where(a, anchors)).toEqual({ from: at, to: at + target.length, text: target });
  });

  it("stays on the same text when another person adds lines ABOVE it, concurrently", () => {
    const { a, b, ta, tb, sync } = peers(code);
    const anchors = createAnchors(Y, ta, at, at + target.length);
    // both edit at the same time, before either sees the other's change
    tb.insert(0, "# new header\n# second line\n");
    ta.insert(ta.toString().indexOf("print"), "# below the anchor\n");
    sync();
    expect(ta.toString()).toBe(tb.toString());
    for (const doc of [a, b]) expect(where(doc, anchors)!.text).toBe(target);
    // a line/offset computed before the edit would now point at the wrong text
    expect(code.slice(at, at + target.length)).toBe(target);
    expect(ta.toString().slice(at, at + target.length)).not.toBe(target);
  });

  it("text typed just before or just after the range stays outside it", () => {
    const { a, ta, sync } = peers(code);
    const anchors = createAnchors(Y, ta, at, at + target.length);
    ta.insert(at, "XX");
    ta.insert(ta.toString().indexOf(target) + target.length, "YY");
    sync();
    expect(where(a, anchors)!.text).toBe(target);
  });

  it("text typed inside the range stretches it", () => {
    const { a, ta } = peers(code);
    const anchors = createAnchors(Y, ta, at, at + target.length);
    ta.insert(at + 7, "000"); // "return 1" -> "return 0001"
    expect(where(a, anchors)!.text).toBe("return 0001");
  });

  it("shrinks when part of the range is deleted, and is 'gone' when all of it is", () => {
    const { a, ta } = peers(code);
    const anchors = createAnchors(Y, ta, at, at + target.length);
    ta.delete(at, 7); // "return " removed
    expect(where(a, anchors)!.text).toBe("1");
    const r = resolveAnchors(Y, a, ta, anchors);
    expect(isGone(anchors, r)).toBe(false);
    ta.delete(ta.toString().indexOf("1"), 1);
    expect(isGone(anchors, resolveAnchors(Y, a, ta, anchors))).toBe(true);
  });

  it("an insertion point (collapsed anchors) follows the characters around it and never goes stale", () => {
    const { a, b, ta, tb, sync } = peers("ab");
    const anchors = createAnchors(Y, ta, 1, 1); // between a and b
    expect(anchors.collapsed).toBe(true);
    tb.insert(0, "zzz");
    sync();
    expect(resolveAnchors(Y, a, ta, anchors)).toEqual({ from: 4, to: 4 });
    ta.delete(0, ta.length);
    sync();
    expect(isGone(anchors, resolveAnchors(Y, b, tb, anchors))).toBe(false);
  });

  it("works for ranges at the very start and end of the text", () => {
    const { a, ta } = peers("hello");
    const whole = createAnchors(Y, ta, 0, 5);
    ta.insert(0, ">>");
    ta.insert(ta.length, "<<");
    expect(where(a, whole)!.text).toBe("hello");
  });

  it("clamps out-of-range and reversed selections", () => {
    const { a, ta } = peers("hello");
    expect(where(a, createAnchors(Y, ta, 99, 2))!.text).toBe("llo");
  });

  it("anchors made on one peer resolve to the same text on the other after sync (they are portable)", () => {
    const { b, ta, tb, sync } = peers(code);
    const anchors = createAnchors(Y, ta, at, at + target.length);
    tb.insert(3, "!!!");
    sync();
    expect(where(b, anchors)!.text).toBe(target);
  });

  it("garbage anchors resolve to null instead of throwing", () => {
    const { a } = peers("x");
    const bad = { start: "AAAA", end: "AAAA", collapsed: false };
    expect(resolveAnchors(Y, a, a.getText("content"), bad)).toBeNull();
    expect(isGone(bad, null)).toBe(true);
  });

  it("anchors made for a different text do not resolve in this one", () => {
    const { ta } = peers("hello");
    const other = new Y.Doc();
    other.getText("other").insert(0, "zzz");
    const anchors = createAnchors(Y, other.getText("other"), 0, 2);
    expect(resolveAnchors(Y, other, ta, anchors)).toBeNull();
  });
});

describe("minimalReplacement", () => {
  const apply = (before: string, r: ReturnType<typeof minimalReplacement>) =>
    r ? before.slice(0, r.from) + r.insert + before.slice(r.from + r.deleteCount) : before;

  it.each([
    ["hello world", "hello there"],
    ["abc", ""],
    ["", "abc"],
    ["same", "same"],
    ["aXa", "aYYa"],
    ["line1\nline2\nline3", "line1\nline2 changed\nline3"],
    ["a😀b", "a😁b"], // never splits an emoji
    ["😀", "😁"],
    ["x😀", "x😁😀"],
  ])("%j -> %j", (before, after) => {
    const r = minimalReplacement(before, after);
    expect(apply(before, r)).toBe(after);
    if (before === after) expect(r).toBeNull();
    else {
      // no lone surrogates at the edit boundaries
      const text = before.slice(r!.from, r!.from + r!.deleteCount) + r!.insert;
      expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text)).toBe(false);
    }
  });

  it("only touches the part that differs", () => {
    expect(minimalReplacement("hello world", "hello there")).toEqual({ from: 6, deleteCount: 5, insert: "there" });
  });
});

describe("base64", () => {
  it("round-trips arbitrary bytes, including large ones", () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 31) % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});

describe("ReplayEngine", () => {
  // A scripted history: three people, a deletion, and enough events to cross keyframes.
  function history(n: number) {
    const doc = new Y.Doc();
    doc.clientID = 7;
    const t = doc.getText("content");
    const updates: Uint8Array[] = [];
    doc.on("update", (u: Uint8Array) => updates.push(u));
    const texts: string[] = [];
    for (let i = 0; i < n; i++) {
      if (i % 7 === 6) t.delete(0, Math.min(2, t.length));
      else t.insert(t.length, `l${i}\n`);
      texts.push(t.toString());
    }
    const steps: ReplayStep[] = updates.map((update, i) => ({
      id: String(i + 1),
      userId: ["alice", "bob", "carol"][i % 3]!,
      startedAt: 1000 + i * 100,
      endedAt: 1050 + i * 100,
      origin: "edit",
      update,
    }));
    return { steps, texts, final: t.toString(), doc };
  }
  const empty = Y.encodeStateAsUpdate(new Y.Doc());

  it("shows the text after each event, going forward", () => {
    const { steps, texts } = history(30);
    const e = new ReplayEngine(Y, empty, steps, 5);
    expect(e.seek(-1).text).toBe("");
    for (let i = 0; i < steps.length; i++) expect(e.seek(i).text).toBe(texts[i]);
  });

  it("scrubbing backwards and jumping around gives the same text as playing straight through", () => {
    const { steps, texts } = history(60);
    const e = new ReplayEngine(Y, empty, steps, 8);
    for (const i of [59, 3, 40, 41, 12, 0, 55, 20, 20, -1, 33]) expect(e.seek(i).text).toBe(i === -1 ? "" : texts[i]);
  });

  it("reports what the event changed (inserted and removed text)", () => {
    const { steps } = history(10);
    const e = new ReplayEngine(Y, empty, steps);
    expect(e.seek(0).change).toEqual({ from: 0, inserted: "l0\n", removed: "" });
    const del = e.seek(6).change!; // the i=6 event deletes two characters at the start
    expect(del.inserted).toBe("");
    expect(del.removed.length).toBe(2);
  });

  it("starting from a checkpoint gives the same result as replaying from the beginning, with far fewer events", () => {
    const { steps, texts, final } = history(40);
    // a checkpoint taken after event 24
    const upTo = new Y.Doc();
    steps.slice(0, 25).forEach((s) => Y.applyUpdate(upTo, s.update));
    const checkpoint = Y.encodeStateAsUpdate(upTo);

    const fromCp = new ReplayEngine(Y, checkpoint, steps.slice(25));
    expect(fromCp.seek(-1).text).toBe(texts[24]);
    expect(fromCp.seek(fromCp.length - 1).text).toBe(final);
    expect(fromCp.length).toBe(15);
    expect(new ReplayEngine(Y, empty, steps).seek(steps.length - 1).text).toBe(final);
  });

  it("applying an event the checkpoint already contains changes nothing (a checkpoint may include a few newer events)", () => {
    const { steps, texts } = history(12);
    const upTo = new Y.Doc();
    steps.slice(0, 8).forEach((s) => Y.applyUpdate(upTo, s.update));
    const e = new ReplayEngine(Y, Y.encodeStateAsUpdate(upTo), steps.slice(5)); // overlaps by 3 events
    expect(e.seek(2).text).toBe(texts[7]); // still the same state after re-applying known events
    expect(e.seek(e.length - 1).text).toBe(texts[11]);
  });

  it("seek clamps to the valid range", () => {
    const { steps, final } = history(5);
    const e = new ReplayEngine(Y, empty, steps);
    expect(e.seek(999).text).toBe(final);
    expect(e.seek(-50).text).toBe("");
  });

  it("filters steps by person and computes playback delays", () => {
    const { steps } = history(9);
    expect(visibleSteps(steps, null)).toHaveLength(9);
    expect(visibleSteps(steps, "bob")).toEqual([1, 4, 7]);
    expect(playbackDelay(100_000, 1)).toBe(1500); // long pauses are squeezed
    expect(playbackDelay(0, 1)).toBe(150);
    expect(playbackDelay(1000, 4)).toBe(250);
    expect(playbackDelay(0, 1000)).toBe(30); // never a busy loop
  });
});

describe("authorsOfRange", () => {
  const pieces = [
    { offset: 0, length: 5, user: "alice", at: 1 }, // "hello"
    { offset: 5, length: 6, user: "bob", at: 2 }, // " world"
    { offset: 11, length: 3, user: null, at: null }, // unknown
  ];
  it("lists the authors of the characters in the range, biggest share first", () => {
    expect(authorsOfRange(pieces, 3, 9)).toEqual([
      { user: "bob", chars: 4 },
      { user: "alice", chars: 2 },
    ]);
    expect(authorsOfRange(pieces, 6, 10)).toEqual([{ user: "bob", chars: 4 }]);
  });
  it("includes unrecorded text as unknown", () => {
    expect(authorsOfRange(pieces, 10, 14)).toEqual([{ user: null, chars: 3 }, { user: "bob", chars: 1 }].sort((x, y) => y.chars - x.chars));
  });
  it("an insertion point looks at the characters either side", () => {
    expect(authorsOfRange(pieces, 5, 5).map((a) => a.user).sort()).toEqual(["alice", "bob"]);
    expect(authorsOfRange(pieces, 0, 0)).toEqual([{ user: "alice", chars: 1 }]);
  });
  it("nothing at all gives no authors", () => {
    expect(authorsOfRange([], 0, 5)).toEqual([]);
  });
});
