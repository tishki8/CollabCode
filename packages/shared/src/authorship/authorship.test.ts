import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { addInterval, normalize, subtract } from "./intervals";
import { countNewlines, decodeDelivered, hasDeletions, newRangesOf, removedBy } from "./delivery";
import { OwnershipViolation, checkOwnership } from "./ownership";
import { AttributionIndex, attribute, blameLines, blameYText, textRuns } from "./blame";
import { activeTimeOf, formatDuration, sessionsOf, timeline, totalsByUser } from "./stats";
import { replayChanges } from "./replay";
import { SimClient, SimServer } from "./sim";

const mainOf = (s: SimServer, line: number) => blameYText(s.doc.getText("content"), s.index).lines[line - 1]!;

describe("intervals", () => {
  it("normalizes, merges touching ranges and drops empty ones", () => {
    expect(normalize([[5, 7], [0, 3], [3, 4], [9, 9]])).toEqual([[0, 4], [5, 7]]);
    expect(addInterval([[0, 4]], [4, 8])).toEqual([[0, 8]]);
  });
  it("subtracts covered parts", () => {
    expect(subtract([0, 10], [[2, 4], [6, 7]])).toEqual([[0, 2], [4, 6], [7, 10]]);
    expect(subtract([2, 4], [[0, 10]])).toEqual([]);
    expect(subtract([0, 3], [])).toEqual([[0, 3]]);
  });
});

describe("delivery analysis", () => {
  it("finds exactly the new item ranges, and counts characters and newlines", () => {
    const s = new SimServer();
    const alice = new SimClient("alice", 1001, s);
    alice.type(0, "ab\ncd\n");
    const first = alice.send()!;
    expect(first.ranges).toEqual([{ client: 1001, start: 0, end: 6, added: 6, linesAdded: 2 }]);
    alice.type(6, "more");
    expect(alice.send()!.ranges).toEqual([{ client: 1001, start: 6, end: 10, added: 4, linesAdded: 0 }]);
  });

  it("does not treat already-applied items as new when someone else re-sends them", () => {
    const s = new SimServer();
    const alice = new SimClient("alice", 1001, s);
    alice.type(0, "hello");
    alice.send();
    // Bob received alice's text from the server and later re-sends the whole state (a normal sync)
    const bobDoc = new Y.Doc();
    Y.applyUpdate(bobDoc, Y.encodeStateAsUpdate(s.doc));
    const resent = decodeDelivered(Y.encodeStateAsUpdate(bobDoc));
    expect(newRangesOf(resent, (c) => s.covered.get(c) ?? [], (c) => Y.getState(s.doc.store, c))).toEqual([]);
  });

  it("only counts the new tail of a partly known struct, with the right text slice", () => {
    const s = new SimServer();
    const alice = new SimClient("alice", 1001, s);
    alice.type(0, "abc");
    alice.send();
    alice.type(3, "d\nef");
    // a full-state resend contains the known "abc" plus the new "d\nef" as one merged struct
    const fullState = Y.encodeStateAsUpdate(alice.doc);
    const ranges = newRangesOf(decodeDelivered(fullState), (c) => s.covered.get(c) ?? [], (c) => Y.getState(s.doc.store, c));
    expect(ranges).toEqual([{ client: 1001, start: 3, end: 7, added: 4, linesAdded: 1 }]);
  });

  it("ignores Skip structs: a gap is not something the sender delivered", () => {
    const a = new Y.Doc();
    a.clientID = 7;
    const ups: Uint8Array[] = [];
    a.on("update", (u: Uint8Array) => ups.push(u));
    a.getText("t").insert(0, "AAA");
    a.getText("t").insert(3, "BBB");
    // deliver only the SECOND update to an empty server: its struct depends on clocks 0-2 it lacks
    const delivered = decodeDelivered(ups[1]!);
    expect(delivered.map((d) => [d.clock, d.length])).toEqual([[3, 3]]);
  });

  it("measures removed text BEFORE applying, ignoring already-deleted and unknown text", () => {
    const s = new SimServer();
    const alice = new SimClient("alice", 1001, s);
    alice.type(0, "one\ntwo\nthree");
    alice.send();
    const bob = new SimClient("bob", 2002, s);
    bob.text.delete(0, 8); // "one\ntwo\n": 8 chars, 2 newlines
    const del = bob.send()!;
    expect(del.removed).toEqual({ chars: 8, lines: 2 });
    expect(del.ranges).toEqual([]); // a pure deletion inserts nothing
    expect(s.doc.getText("content").toString()).toBe("three");

    // deleting again is a no-op: those items are already deleted
    expect(removedBy(Y.encodeStateAsUpdate(bob.doc), new Y.Doc()).chars).toBe(0);
    expect(removedBy(Y.encodeStateAsUpdate(bob.doc), s.doc)).toEqual({ chars: 0, lines: 0 });
  });

  it("hasDeletions and countNewlines", () => {
    const d = new Y.Doc();
    const ups: Uint8Array[] = [];
    d.on("update", (u: Uint8Array) => ups.push(u));
    d.getText("t").insert(0, "x");
    d.getText("t").delete(0, 1);
    expect(hasDeletions(ups[0]!)).toBe(false);
    expect(hasDeletions(ups[1]!)).toBe(true);
    expect(countNewlines("a\nb\n\n")).toBe(3);
  });
});

describe("clientID ownership (anti-forgery)", () => {
  it("binds unowned ids to the first user, accepts that user again, and rejects anyone else", () => {
    const owners = new Map<number, string>();
    const first = checkOwnership([11, 12], owners, "alice");
    expect(first).toEqual({ toBind: [11, 12], violation: null });
    first.toBind.forEach((c) => owners.set(c, "alice"));

    expect(checkOwnership([11], owners, "alice")).toEqual({ toBind: [], violation: null });
    const stolen = checkOwnership([12, 99], owners, "bob");
    expect(stolen.violation).toBeInstanceOf(OwnershipViolation);
    expect(stolen.violation).toMatchObject({ clientId: 12, owner: "alice", attemptedBy: "bob", code: 4403 });
    expect(stolen.toBind).toEqual([]); // nothing is bound by a rejected attempt
  });

  it("accepts Bob re-sending text under Alice's clientID and credits it to Alice, flagged as recovered (nobody is rejected)", () => {
    const s = new SimServer();
    const alice = new SimClient("alice", 1001, s);
    alice.typeKeys(0, "real");
    alice.send(); // alice now owns client 1001

    // Bob holds items under Alice's clientID that the server has no record of (e.g. her unflushed
    // events were lost in a crash). Built as a fresh document that uses her id.
    const resent = new Y.Doc();
    resent.clientID = 1001;
    resent.getText("content").insert(0, "REAL-LOST"); // clocks 0..8: clocks 4..8 are new to the server
    const resentUpdate = Y.encodeStateAsUpdate(resent);

    const out = s.deliver("bob", resentUpdate);
    expect(out.ranges).toEqual([expect.objectContaining({ client: 1001, start: 4, end: 9 })]);
    expect(s.index.lookup(1001, 4)).toMatchObject({ user: "alice", recovered: true }); // Alice's, not Bob's
    expect(s.index.lookup(1001, 0)!.recovered).toBeUndefined(); // her original record is untouched
    expect(s.owners.get(1001)).toBe("alice");
    expect(s.index.lookup(2002, 0)).toBeNull(); // Bob got no credit

    // Alice is not blocked either. (Yjs moves her client to a fresh clientID on seeing items under her
    // own id that she did not write; her new text is attributed to her under the new id.)
    alice.sync();
    alice.type(alice.text.length, "!");
    const next = alice.send()!;
    expect(s.index.lookup(next.ranges[0]!.client, next.ranges[0]!.start)).toMatchObject({ user: "alice" });
    expect(s.index.lookup(next.ranges[0]!.client, next.ranges[0]!.start)!.recovered).toBeUndefined();
  });

  it("allows relaying already-recorded items (a normal reconnect sync), even by another user", () => {
    const s = new SimServer();
    const alice = new SimClient("alice", 1001, s);
    alice.type(0, "shared");
    alice.send();
    const bob = new SimClient("bob", 2002, s); // starts with alice's items
    bob.type(6, "+bob");
    // bob's message contains alice's known items plus his own new ones
    const bobFullState = Y.encodeStateAsUpdate(bob.doc);
    expect(() => s.deliver("bob", bobFullState)).not.toThrow();
    expect(s.index.lookup(1001, 0)!.user).toBe("alice"); // alice's text is still hers
    expect(s.index.lookup(2002, 0)!.user).toBe("bob");
  });
});

describe("attribution at delivery, not by diffing the transaction", () => {
  it("credits held-back (out-of-order) text to the user who delivered it, not to whoever completed the chain", () => {
    const s = new SimServer();
    const alice = new Y.Doc();
    alice.clientID = 1001;
    const ups: Uint8Array[] = [];
    alice.on("update", (u: Uint8Array) => ups.push(u));
    alice.getText("content").insert(0, "AAA"); // update 1
    alice.getText("content").insert(3, "BBB"); // update 2 depends on update 1

    s.deliver("alice", ups[1]!); // alice's connection delivers update 2 first: held back by Yjs
    expect(s.doc.getText("content").toString()).toBe(""); // pending, not applied yet

    // Carol's connection now delivers update 1 (e.g. relayed to her earlier): this transaction
    // is what finally makes "BBB" appear. A transaction diff would credit BBB to carol.
    s.deliver("alice", ups[0]!);
    expect(s.doc.getText("content").toString()).toBe("AAABBB");
    const lines = blameYText(s.doc.getText("content"), s.index).lines;
    expect(lines[0]!.authors).toEqual([{ user: "alice", chars: 6, lastAt: expect.any(Number) }]);
  });

  it("the diff approach would have mis-credited it (documenting why we do not use it)", () => {
    const doc = new Y.Doc();
    const a = new Y.Doc();
    a.clientID = 1001;
    const ups: Uint8Array[] = [];
    a.on("update", (u: Uint8Array) => ups.push(u));
    a.getText("content").insert(0, "AAA");
    a.getText("content").insert(3, "BBB");
    Y.applyUpdate(doc, ups[1]!);
    let credited = 0;
    doc.on("afterTransaction", (tr) => {
      credited = (tr.afterState.get(1001) ?? 0) - (tr.beforeState.get(1001) ?? 0);
    });
    Y.applyUpdate(doc, ups[0]!); // "carol" delivers update 1
    expect(credited).toBe(6); // the transaction delivered by carol "contains" all 6 clocks
  });
});

describe("blame scenarios", () => {
  it("different people on different lines", () => {
    const s = new SimServer();
    const alice = new SimClient("alice", 1001, s);
    alice.type(0, "alice line\n");
    alice.send();
    const bob = new SimClient("bob", 2002, s);
    bob.type(bob.text.length, "bob line");
    bob.send();
    expect(mainOf(s, 1).main!.user).toBe("alice");
    expect(mainOf(s, 2).main!.user).toBe("bob");
    expect(mainOf(s, 1).others).toBe(0);
  });

  it("two users typing on the SAME line at the same time: both are credited, the bigger contribution is main", () => {
    const s = new SimServer();
    const base = new SimClient("alice", 1001, s);
    base.type(0, "x = ");
    base.send();
    const alice = new SimClient("alice", 1002, s);
    const bob = new SimClient("bob", 2002, s);
    // both type at the end of the same line concurrently, without seeing each other yet
    alice.typeKeys(4, "compute_total(items)");
    bob.typeKeys(4, "7");
    alice.send();
    bob.send();
    const line = mainOf(s, 1);
    expect(line.authors.map((a) => a.user).sort()).toEqual(["alice", "bob"]);
    expect(line.main!.user).toBe("alice"); // 4 + 20 chars vs 1
    expect(line.others).toBe(1);
    // and both clients converge to the same text
    alice.sync();
    bob.sync();
    expect(alice.text.toString()).toBe(bob.text.toString());
  });

  it("text deleted and retyped by someone else credits the new author", () => {
    const s = new SimServer();
    const alice = new SimClient("alice", 1001, s);
    alice.type(0, "print('hi')");
    alice.send();
    expect(mainOf(s, 1).main!.user).toBe("alice");

    const bob = new SimClient("bob", 2002, s);
    bob.text.delete(0, bob.text.length);
    bob.type(0, "print('hi')"); // identical text, retyped
    const delivered = bob.send()!;
    expect(delivered.removed.chars).toBe(11);
    expect(mainOf(s, 1).main!.user).toBe("bob");
    expect(mainOf(s, 1).others).toBe(0); // alice's deleted text no longer appears on the line
  });

  it("a large paste is a single run and a single attribution range", () => {
    const s = new SimServer();
    const alice = new SimClient("alice", 1001, s);
    alice.type(0, "row\n".repeat(25_000)); // ~100 KB, 25k lines
    const { ranges } = alice.send()!;
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({ added: 100_000, linesAdded: 25_000 });
    expect(textRuns(s.doc.getText("content"))).toHaveLength(1);
    const blame = blameYText(s.doc.getText("content"), s.index).lines;
    expect(blame).toHaveLength(25_001);
    expect(blame[12_345]!.main!.user).toBe("alice");
  });

  it("undo credits the person who pressed it, and undone text has no author", () => {
    const s = new SimServer();
    const alice = new SimClient("alice", 1001, s);
    const undo = new Y.UndoManager(alice.text, { captureTimeout: 0 });
    alice.type(0, "draft");
    alice.send();
    expect(mainOf(s, 1).main!.user).toBe("alice");

    undo.undo();
    alice.send();
    expect(s.doc.getText("content").toString()).toBe("");
    expect(mainOf(s, 1).main).toBeNull();

    undo.redo(); // redo re-inserts as NEW items, authored by alice
    alice.send();
    expect(s.doc.getText("content").toString()).toBe("draft");
    expect(mainOf(s, 1).main!.user).toBe("alice");
  });

  it("restoring someone else's deleted text by undo credits the restorer (documented limitation)", () => {
    const s = new SimServer();
    const alice = new SimClient("alice", 1001, s);
    alice.type(0, "alice wrote this");
    alice.send();

    const bob = new SimClient("bob", 2002, s);
    const bobUndo = new Y.UndoManager(bob.text, { captureTimeout: 0 });
    bob.text.delete(0, bob.text.length); // bob deletes alice's text
    bob.send();
    bobUndo.undo(); // and restores it
    bob.send();
    expect(s.doc.getText("content").toString()).toBe("alice wrote this");
    expect(mainOf(s, 1).main!.user).toBe("bob");
  });

  it("offline edits keep the right author when they merge on reconnect", () => {
    const s = new SimServer();
    const alice = new SimClient("alice", 1001, s);
    alice.type(0, "online\n");
    alice.send();
    const bob = new SimClient("bob", 2002, s);

    // bob goes offline and edits; meanwhile alice keeps working
    bob.type(bob.text.length, "offline by bob\n");
    alice.type(alice.text.length, "alice again\n");
    alice.send();

    // bob reconnects: his queued edits (made against an older state) are delivered now
    bob.send();
    alice.sync();
    bob.sync();
    expect(alice.text.toString()).toBe(bob.text.toString());
    const lines = blameYText(s.doc.getText("content"), s.index).lines;
    const byText = Object.fromEntries(s.doc.getText("content").toString().split("\n").map((t, i) => [t, lines[i]!.main?.user]));
    expect(byText["online"]).toBe("alice");
    expect(byText["offline by bob"]).toBe("bob");
    expect(byText["alice again"]).toBe("alice");
  });

  it("text with no attribution on record is reported as unknown, not blamed on anyone", () => {
    const doc = new Y.Doc();
    doc.getText("t").insert(0, "legacy text\n");
    const lines = blameYText(doc.getText("t"), new AttributionIndex()).lines;
    expect(lines[0]!.main).toMatchObject({ user: null });
  });

  it("your own fresh typing can be attributed locally before the server reports it", () => {
    const doc = new Y.Doc();
    doc.clientID = 42;
    doc.getText("t").insert(0, "mine");
    const { lines } = blameYText(doc.getText("t"), new AttributionIndex(), (c) => (c === 42 ? { user: "me", at: 5 } : null));
    expect(lines[0]!.main).toMatchObject({ user: "me", lastAt: 5 });
  });

  it("weights by non-whitespace characters, and blank lines still show who pressed Enter", () => {
    const s = new SimServer();
    const alice = new SimClient("alice", 1001, s);
    alice.type(0, "ab");
    alice.send();
    const bob = new SimClient("bob", 2002, s);
    bob.type(2, "          "); // 10 spaces on alice's line
    bob.send();
    expect(mainOf(s, 1).main!.user).toBe("alice"); // spaces don't outweigh letters
    bob.type(12, "\n\n");
    bob.send();
    expect(mainOf(s, 2).main!.user).toBe("bob"); // the empty line whose Enter bob pressed
    expect(mainOf(s, 3).main).toBeNull(); // the final, still-empty line has no characters at all
  });

  it("splits one Yjs run across attribution ranges (typed in two batches, different times)", () => {
    const s = new SimServer();
    const alice = new SimClient("alice", 1001, s);
    alice.type(0, "first ");
    alice.send();
    alice.type(6, "second");
    alice.send();
    const runs = textRuns(s.doc.getText("content"));
    expect(runs).toHaveLength(1); // one Yjs item...
    const pieces = attribute(runs, s.index);
    expect(pieces.map((p) => [p.length, p.user])).toEqual([[6, "alice"], [6, "alice"]]); // ...two ranges
    expect(pieces[0]!.at).toBeLessThan(pieces[1]!.at!);
  });

  it("blameLines copes with empty text", () => {
    expect(blameLines("", [])).toEqual([{ line: 1, authors: [], main: null, others: 0 }]);
  });
});

describe("contribution statistics", () => {
  const e = (userId: string, startedAt: number, endedAt: number, added = 0, removed = 0, linesAdded = 0, linesRemoved = 0) => ({
    userId, startedAt, endedAt, added, removed, linesAdded, linesRemoved,
  });
  const MIN = 60_000;

  it("bridges edits less than 5 minutes apart into one session and sums their spans", () => {
    const s = sessionsOf([e("a", 0, 10 * 1000), e("a", 2 * MIN, 2 * MIN + 5000), e("a", 20 * MIN, 21 * MIN)]);
    expect(s).toEqual([{ start: 0, end: 2 * MIN + 5000 }, { start: 20 * MIN, end: 21 * MIN }]);
    expect(activeTimeOf([e("a", 0, 10_000), e("a", 2 * MIN, 2 * MIN + 5000), e("a", 20 * MIN, 21 * MIN)])).toBe(2 * MIN + 5000 + MIN);
  });

  it("totals per person are ordered by first activity, not by amount (no leaderboard)", () => {
    const totals = totalsByUser([
      e("late-big", 10 * MIN, 11 * MIN, 5000, 100, 200, 10),
      e("early-small", 1 * MIN, 1 * MIN + 1000, 3, 0, 0, 0),
    ]);
    expect(totals.map((t) => t.userId)).toEqual(["early-small", "late-big"]);
    expect(totals[1]).toMatchObject({ added: 5000, removed: 100, linesAdded: 200, linesRemoved: 10, sessions: 1, activeMs: MIN });
  });

  it("builds one lane per person with per-bucket changes and active time", () => {
    const tl = timeline(
      [e("a", 0, 30 * MIN, 10, 2), e("b", 70 * MIN, 80 * MIN, 5, 0), e("a", 65 * MIN, 66 * MIN, 1, 1)],
      0, 120 * MIN, 60 * MIN,
    );
    expect(tl.buckets).toBe(2);
    expect(tl.lanes.map((l) => l.userId)).toEqual(["a", "b"]);
    expect(tl.lanes[0]!.cells[0]).toMatchObject({ added: 10, removed: 2, activeMs: 30 * MIN });
    expect(tl.lanes[0]!.cells[1]).toMatchObject({ added: 1, removed: 1, activeMs: MIN });
    expect(tl.lanes[1]!.cells[0]).toMatchObject({ added: 0, activeMs: 0 });
    expect(tl.lanes[1]!.cells[1]).toMatchObject({ added: 5, activeMs: 10 * MIN });
  });

  it("formats durations", () => {
    expect(formatDuration(10_000)).toBe("< 1 min");
    expect(formatDuration(12 * MIN)).toBe("12 min");
    expect(formatDuration(65 * MIN)).toBe("1 h 5 min");
    expect(formatDuration(120 * MIN)).toBe("2 h");
  });
});

describe("history replay (per-person diff)", () => {
  function eventOf(id: number, userId: string, startedAt: number, build: (d: Y.Doc) => void, base?: Y.Doc) {
    const d = new Y.Doc({ gc: false });
    d.clientID = 1000 + id;
    if (base) Y.applyUpdate(d, Y.encodeStateAsUpdate(base));
    let update!: Uint8Array;
    d.on("update", (u: Uint8Array) => (update = u));
    build(d);
    return { event: { id, userId, startedAt, endedAt: startedAt + 500, update }, doc: d };
  }

  it("lists exactly what one person added and removed, with line numbers, ignoring the others", () => {
    const e1 = eventOf(1, "alice", 1000, (d) => d.getText("content").insert(0, "one\ntwo\nthree\n"));
    const e2 = eventOf(2, "bob", 2000, (d) => d.getText("content").insert(4, "BOB\n"), e1.doc);
    const e3 = eventOf(3, "alice", 3000, (d) => d.getText("content").delete(0, 4), e2.doc); // remove "one\n"
    const all = [e1.event, e2.event, e3.event];

    const alice = replayChanges(all, { userId: "alice" });
    expect(alice.map((c) => c.eventId)).toEqual(["1", "3"]);
    expect(alice[0]!.hunks).toEqual([{ kind: "add", line: 1, text: "one\ntwo\nthree\n" }]);
    expect(alice[1]!.hunks).toEqual([{ kind: "del", line: 1, text: "one\n" }]);

    const bob = replayChanges(all, { userId: "bob" });
    expect(bob).toHaveLength(1);
    expect(bob[0]!.hunks).toEqual([{ kind: "add", line: 2, text: "BOB\n" }]);
  });

  it("filters by time range but still replays everything before it", () => {
    const e1 = eventOf(1, "alice", 1000, (d) => d.getText("content").insert(0, "a\n"));
    const e2 = eventOf(2, "alice", 5000, (d) => d.getText("content").insert(2, "b\n"), e1.doc);
    const inRange = replayChanges([e1.event, e2.event], { userId: "alice", from: 4000, to: 6000 });
    expect(inRange.map((c) => c.eventId)).toEqual(["2"]);
    expect(inRange[0]!.hunks).toEqual([{ kind: "add", line: 2, text: "b\n" }]); // line 2 needs event 1 replayed
  });

  it("shows text that was later deleted by someone else (the diff is what they changed)", () => {
    const e1 = eventOf(1, "alice", 1000, (d) => d.getText("content").insert(0, "temp"));
    const e2 = eventOf(2, "bob", 2000, (d) => d.getText("content").delete(0, 4), e1.doc);
    const alice = replayChanges([e1.event, e2.event], { userId: "alice" });
    expect(alice[0]!.hunks[0]).toMatchObject({ kind: "add", text: "temp" });
  });
});
