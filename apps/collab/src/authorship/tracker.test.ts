import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { OwnershipViolation } from "@collabcode/shared";
import { AuthorshipTracker, type AuthorshipStore, type NewEvent } from "./tracker";

/** In-memory store with the same first-writer-wins binding the database gives. */
class FakeStore implements AuthorshipStore {
  owners = new Map<string, Map<number, string>>();
  events: NewEvent[] = [];
  writes = 0;
  failWrites = 0;
  bindDelayMs = 0;
  async loadOwners(fileId: string) {
    return new Map(this.owners.get(fileId) ?? []);
  }
  async loadCoverage(fileId: string) {
    return this.events.filter((e) => e.fileId === fileId && e.clockEnd > e.clockStart).map((e) => ({ client: e.clientId, start: e.clockStart, end: e.clockEnd }));
  }
  async bindClient(fileId: string, clientId: number, userId: string) {
    if (this.bindDelayMs) await new Promise((r) => setTimeout(r, this.bindDelayMs));
    const m = this.owners.get(fileId) ?? new Map<number, string>();
    this.owners.set(fileId, m);
    if (!m.has(clientId)) m.set(clientId, userId);
    return m.get(clientId)!;
  }
  async writeEvents(rows: NewEvent[]) {
    this.writes++;
    if (this.failWrites > 0) {
      this.failWrites--;
      throw new Error("db down");
    }
    this.events.push(...rows);
  }
}

const FILE = "file-1";
const silent = { warn: vi.fn(), error: vi.fn() };

/** A server document plus a connection per user, delivering updates the way the Hocuspocus hook does. */
function setup(store = new FakeStore(), opts: { idleMs?: number; maxMs?: number } = {}) {
  silent.warn.mockClear();
  silent.error.mockClear();
  const tracker = new AuthorshipTracker({ store, log: silent, ...opts });
  const server = new Y.Doc();
  const connect = (userId: string, clientID: number) => {
    const doc = new Y.Doc();
    doc.clientID = clientID;
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(server));
    let outbox: Uint8Array[] = [];
    doc.on("update", (u: Uint8Array, origin: unknown) => origin !== "remote" && outbox.push(u));
    const send = async () => {
      const update = Y.mergeUpdates(outbox);
      outbox = [];
      await tracker.onDelivery(FILE, server, userId, update); // before applying, like beforeHandleMessage
      Y.applyUpdate(server, update, "remote");
    };
    // each keystroke is its own message, as in the real editor
    const keys = async (offset: number, s: string) => {
      for (const [i, ch] of [...s].entries()) {
        doc.getText("content").insert(offset + i, ch);
        await send();
      }
    };
    return { doc, text: doc.getText("content"), send, keys, userId };
  };
  return { tracker, server, store, connect, text: () => server.getText("content").toString() };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("batching", () => {
  it("turns 50 keystrokes into ONE event, written only after 1.5 s of quiet", async () => {
    const { tracker, store, connect } = setup();
    await tracker.loadDocument(FILE);
    const alice = connect("alice", 1001);
    await alice.keys(0, "x".repeat(50));
    expect(store.writes).toBe(0); // nothing hits the database while typing
    await vi.advanceTimersByTimeAsync(1400);
    expect(store.writes).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(store.writes).toBe(1);
    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({ userId: "alice", clientId: 1001, clockStart: 0, clockEnd: 50, added: 50, removed: 0 });
    // the merged update replays to the same text
    const replay = new Y.Doc();
    Y.applyUpdate(replay, store.events[0]!.update);
    expect(replay.getText("content").toString()).toBe("x".repeat(50));
  });

  it("never holds a batch longer than 5 s, even when typing never pauses", async () => {
    const { tracker, store, connect } = setup();
    await tracker.loadDocument(FILE);
    const alice = connect("alice", 1001);
    for (let i = 0; i < 14; i++) {
      await alice.keys(i, "k");
      await vi.advanceTimersByTimeAsync(1000); // a keystroke every second: never idle for 1.5 s
    }
    expect(store.events.length).toBeGreaterThanOrEqual(2);
    for (const e of store.events) expect(e.createdAt.getTime() - e.startedAt.getTime()).toBeLessThanOrEqual(5_000);
    // contiguous, gap-free, in order
    const ranges = store.events.map((e) => [e.clockStart, e.clockEnd]);
    ranges.slice(1).forEach(([s], i) => expect(s).toBe(ranges[i]![1]));
  });

  it("flushDocument writes immediately (used just before a snapshot is stored)", async () => {
    const { tracker, store, connect } = setup();
    await tracker.loadDocument(FILE);
    await connect("alice", 1001).keys(0, "hello");
    expect(store.events).toHaveLength(0);
    await tracker.flushDocument(FILE);
    expect(store.events).toHaveLength(1);
    expect(tracker.pending(FILE)).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.writes).toBe(1); // timers were cancelled: no duplicate write
  });

  it("a large paste is one event with the right counts", async () => {
    const { tracker, store, connect } = setup();
    await tracker.loadDocument(FILE);
    const alice = connect("alice", 1001);
    alice.text.insert(0, "row\n".repeat(25_000));
    await alice.send();
    await tracker.flushDocument(FILE);
    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({ added: 100_000, linesAdded: 25_000, clockStart: 0, clockEnd: 100_000 });
  });

  it("a jump in clock ranges starts a new event (each event covers one contiguous range)", async () => {
    const { tracker, store, connect, server } = setup();
    await tracker.loadDocument(FILE);
    const alice = connect("alice", 1001);
    alice.text.insert(0, "aaa"); // clocks 0..2
    await alice.send();
    // A later message arrives with a gap: it starts at clock 5, so clocks 3-4 are missing (held back).
    const later = new Y.Doc();
    later.clientID = 1001;
    later.getText("content").insert(0, "0123456789");
    const upTo5 = new Y.Doc();
    upTo5.clientID = 1001;
    upTo5.getText("content").insert(0, "01234");
    const svAt5 = Y.encodeStateVector(upTo5); // "I already have clocks 0..4"
    const tail = Y.encodeStateAsUpdate(later, svAt5); // structs for clocks 5..9 only
    await tracker.onDelivery(FILE, server, "alice", tail);
    await tracker.flushDocument(FILE);
    expect(store.events.map((e) => [e.clockStart, e.clockEnd])).toEqual([[0, 3], [5, 10]]);
  });

  it("a range that continues exactly where the batch ended extends the same event", async () => {
    const { tracker, store, connect } = setup();
    await tracker.loadDocument(FILE);
    const alice = connect("alice", 1001);
    await alice.keys(0, "abc");
    await alice.keys(3, "def");
    await tracker.flushDocument(FILE);
    expect(store.events.map((e) => [e.clockStart, e.clockEnd])).toEqual([[0, 6]]);
  });
});

describe("who gets credit", () => {
  it("two users typing on the same line get separate events under their own ids", async () => {
    const { tracker, store, connect, text } = setup();
    await tracker.loadDocument(FILE);
    const alice = connect("alice", 1001);
    const bob = connect("bob", 2002);
    await alice.keys(0, "AAAA");
    await bob.keys(0, "BB"); // both insert at offset 0 of the same (empty from their view) line
    await tracker.flushDocument(FILE);
    expect(store.events.map((e) => [e.userId, e.clientId, e.added])).toEqual(
      expect.arrayContaining([["alice", 1001, 4], ["bob", 2002, 2]]),
    );
    expect(text().length).toBe(6);
  });

  it("deleting text is its own event with exact removed counts, credited to the deleter", async () => {
    const { tracker, store, connect } = setup();
    await tracker.loadDocument(FILE);
    const alice = connect("alice", 1001);
    alice.text.insert(0, "one\ntwo\nthree");
    await alice.send();
    const bob = connect("bob", 2002);
    await bob.keys(bob.text.length, "!"); // bob delivers once, so the delete batch knows his clientID
    bob.text.delete(0, 8); // "one\ntwo\n"
    await bob.send();
    await tracker.flushDocument(FILE);
    const bobEvents = store.events.filter((e) => e.userId === "bob");
    expect(bobEvents.reduce((t, e) => t + e.removed, 0)).toBe(8);
    expect(bobEvents.reduce((t, e) => t + e.linesRemoved, 0)).toBe(2);
    expect(store.events.filter((e) => e.userId === "alice").reduce((t, e) => t + e.removed, 0)).toBe(0);
  });

  it("delete-only batches have an empty clock range", async () => {
    const { tracker, store, connect } = setup();
    await tracker.loadDocument(FILE);
    const alice = connect("alice", 1001);
    alice.text.insert(0, "abc");
    await alice.send();
    await tracker.flushDocument(FILE);
    alice.text.delete(0, 3);
    await alice.send();
    await tracker.flushDocument(FILE);
    const del = store.events[store.events.length - 1]!;
    expect(del).toMatchObject({ userId: "alice", clockStart: 0, clockEnd: 0, removed: 3, added: 0 });
  });

  it("re-syncing already-known items records nothing", async () => {
    const { tracker, store, connect, server } = setup();
    await tracker.loadDocument(FILE);
    const alice = connect("alice", 1001);
    await alice.keys(0, "known");
    await tracker.flushDocument(FILE);
    const before = store.events.length;
    const bob = connect("bob", 2002); // starts with alice's items
    await tracker.onDelivery(FILE, server, "bob", Y.encodeStateAsUpdate(bob.doc)); // a full-state sync
    await tracker.flushDocument(FILE);
    expect(store.events.length).toBe(before);
    expect(silent.warn).not.toHaveBeenCalled();
  });
});

describe("clientID ownership (anti-forgery)", () => {
  async function aliceOwns() {
    const s = setup();
    await s.tracker.loadDocument(FILE);
    const alice = s.connect("alice", 1001);
    await alice.keys(0, "alice text");
    await s.tracker.flushDocument(FILE);
    return { ...s, alice };
  }
  const forgery = () => {
    const forged = new Y.Doc();
    forged.clientID = 1001; // Bob claims ALICE's clientID
    forged.getText("content").insert(0, "x".repeat(15)); // reaches clocks 10..14, new to the server
    return Y.encodeStateAsUpdate(forged);
  };

  it("accepts an update with new items under another user's clientID: credited to the OWNER, flagged as recovered, logged, nobody rejected", async () => {
    const { tracker, store, server, text } = await aliceOwns();
    const before = store.events.length;
    await expect(tracker.onDelivery(FILE, server, "bob", forgery())).resolves.toBeUndefined();
    Y.applyUpdate(server, forgery(), "remote"); // the caller applies an accepted update
    await tracker.flushDocument(FILE);
    expect(text().length).toBe(15);
    const added = store.events.slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ userId: "alice", clientId: 1001, clockStart: 10, clockEnd: 15, added: 5, recovered: true });
    expect(store.events.filter((e) => e.userId === "bob")).toHaveLength(0); // Bob is not credited with Alice's id
    expect(silent.warn).toHaveBeenCalledTimes(1);
    expect(silent.warn.mock.calls[0]![0]).toMatch(/after recovery/);
    expect(silent.warn.mock.calls[0]![1]).toMatchObject({ fileId: FILE, clientId: 1001, owner: "alice", deliveredBy: "bob" });
  });

  it("crash recovery: unflushed events are lost, Bob re-sends Alice's text, it is credited to Alice (from the persisted claim) and Bob stays connected", async () => {
    const store = new FakeStore();
    const first = setup(store);
    await first.tracker.loadDocument(FILE);
    const alice = first.connect("alice", 1001);
    await alice.keys(0, "saved ");
    await first.tracker.flushDocument(FILE); // "saved " is on record
    const bob = first.connect("bob", 2002); // Bob has a live copy of everything
    await alice.keys(alice.text.length, "lost in the crash"); // delivered, but the batch is still only in memory
    await vi.advanceTimersByTimeAsync(10); // (bob's copy is updated below, as the real relay would)
    Y.applyUpdate(bob.doc, Y.encodeStateAsUpdate(first.server), "remote");
    // --- crash: the unflushed batch is gone; the clientID claim was already persisted ---
    expect(store.events.every((e) => e.userId === "alice" && e.clockEnd <= 6)).toBe(true);

    // The server restarts with its last snapshot (saved text only) and a fresh tracker.
    const snapshot = new Y.Doc();
    snapshot.clientID = 1001;
    snapshot.getText("content").insert(0, "saved ");
    const server2 = new Y.Doc();
    Y.applyUpdate(server2, Y.encodeStateAsUpdate(snapshot));
    const tracker2 = new AuthorshipTracker({ store, log: silent });
    await tracker2.loadDocument(FILE);

    // Bob's client reconnects and syncs its whole document: it contains Alice's lost text.
    const resync = Y.encodeStateAsUpdate(bob.doc);
    await expect(tracker2.onDelivery(FILE, server2, "bob", resync)).resolves.toBeUndefined(); // not rejected
    Y.applyUpdate(server2, resync, "remote");
    await tracker2.flushDocument(FILE);

    expect(server2.getText("content").toString()).toBe("saved lost in the crash");
    const recovered = store.events.filter((e) => e.recovered);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ userId: "alice", clientId: 1001, clockStart: 6, added: "lost in the crash".length });
    expect(store.events.some((e) => e.userId === "bob" && e.recovered)).toBe(false);
  });

  it("the binding is persisted: a restarted server credits re-sent text to the same owner", async () => {
    const { store, server } = await aliceOwns();
    const restarted = new AuthorshipTracker({ store, log: silent });
    await restarted.loadDocument(FILE);
    await restarted.onDelivery(FILE, server, "bob", forgery());
    await restarted.flushDocument(FILE);
    expect(store.events.at(-1)).toMatchObject({ userId: "alice", recovered: true });
  });

  it("deletions in a recovered update are still the deliverer's work", async () => {
    const { tracker, store, server } = await aliceOwns();
    const bob = new Y.Doc();
    bob.clientID = 2002;
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(server));
    const lost = new Y.Doc();
    Y.applyUpdate(lost, Y.encodeStateAsUpdate(server));
    lost.clientID = 1001; // set after syncing: Yjs would otherwise swap the id on seeing its own items
    lost.getText("content").insert(10, "++"); // alice's lost keystrokes: clocks 10..11
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(lost));
    bob.getText("content").delete(0, 3); // and bob deletes three characters
    await tracker.onDelivery(FILE, server, "bob", Y.encodeStateAsUpdate(bob));
    await tracker.flushDocument(FILE);
    const mine = store.events.filter((e) => e.userId === "bob");
    expect(mine.reduce((n, e) => n + e.removed, 0)).toBe(3);
    expect(store.events.find((e) => e.recovered)).toMatchObject({ userId: "alice", removed: 0, added: 2 });
  });

  it("the first user to use a clientID owns it, and the claim is written to the store", async () => {
    const s = setup();
    await s.tracker.loadDocument(FILE);
    await s.connect("carol", 3003).keys(0, "c");
    expect(s.store.owners.get(FILE)!.get(3003)).toBe("carol");
  });

  it("an awareness update claims clientIDs too, so a clientID cannot be squatted before it is used", async () => {
    const { tracker, store } = setup();
    await tracker.loadDocument(FILE);
    await tracker.onAwareness(FILE, "alice", [1001]); // alice connects: cursor update, no text yet
    expect(store.owners.get(FILE)!.get(1001)).toBe("alice");
    await expect(tracker.onAwareness(FILE, "bob", [1001])).rejects.toBeInstanceOf(OwnershipViolation);
    await expect(tracker.onAwareness(FILE, "alice", [1001])).resolves.toBeUndefined(); // same user again is fine
    expect(silent.warn.mock.calls.at(-1)![0]).toMatch(/awareness update/);
  });

  it("a user can have several clientIDs (several tabs), each bound to them", async () => {
    const { tracker, store } = setup();
    await tracker.loadDocument(FILE);
    await tracker.onAwareness(FILE, "alice", [1001]);
    await tracker.onAwareness(FILE, "alice", [1002]);
    expect([...store.owners.get(FILE)!.entries()]).toEqual([[1001, "alice"], [1002, "alice"]]);
  });

  it("two connections racing to claim the same fresh clientID: exactly one wins", async () => {
    const store = new FakeStore();
    store.bindDelayMs = 10;
    const { tracker } = setup(store);
    await tracker.loadDocument(FILE);
    const racing = Promise.allSettled([tracker.onAwareness(FILE, "alice", [777]), tracker.onAwareness(FILE, "bob", [777])]);
    await vi.advanceTimersByTimeAsync(50); // let the delayed database writes finish
    const results = await racing;
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(store.owners.get(FILE)!.get(777)).toBe("alice"); // first to claim
  });

  it("another server instance winning the claim is detected from the store", async () => {
    const store = new FakeStore();
    store.owners.set(FILE, new Map()); // this instance has not seen the binding yet...
    const { tracker } = setup(store);
    await tracker.loadDocument(FILE);
    store.owners.get(FILE)!.set(555, "alice"); // ...but another instance writes it
    await expect(tracker.onAwareness(FILE, "bob", [555])).rejects.toBeInstanceOf(OwnershipViolation);
  });

  it("relayed items already on record are not treated as new, so a normal reconnect sync is not rejected", async () => {
    const { tracker, store, server } = await aliceOwns();
    const bob = new Y.Doc();
    bob.clientID = 2002;
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(server)); // bob holds alice's items
    bob.getText("content").insert(0, "bob");
    await expect(tracker.onDelivery(FILE, server, "bob", Y.encodeStateAsUpdate(bob))).resolves.toBeUndefined();
    await tracker.flushDocument(FILE);
    expect(store.events.at(-1)).toMatchObject({ userId: "bob", clientId: 2002 });
    expect(store.events.filter((e) => e.userId === "bob" && e.clientId === 1001)).toHaveLength(0);
  });
});

describe("durability", () => {
  it("coverage survives a restart: re-delivering recorded items is a no-op, not a new attribution", async () => {
    const { tracker, store, connect } = setup();
    await tracker.loadDocument(FILE);
    const alice = connect("alice", 1001);
    await alice.keys(0, "persisted");
    await tracker.flushDocument(FILE);

    const restarted = new AuthorshipTracker({ store, log: silent });
    await restarted.loadDocument(FILE);
    const freshServerDoc = new Y.Doc(); // the restarted server lost the (unsaved) document content
    const resend = Y.encodeStateAsUpdate(alice.doc);
    const before = store.events.length;
    await restarted.onDelivery(FILE, freshServerDoc, "someone-else", resend); // another user's client heals the server
    await restarted.flushDocument(FILE);
    expect(store.events.length).toBe(before); // still credited to alice only
  });

  it("a failed write is kept and retried, never dropped", async () => {
    const { tracker, store, connect } = setup();
    await tracker.loadDocument(FILE);
    store.failWrites = 1;
    await connect("alice", 1001).keys(0, "important");
    await vi.advanceTimersByTimeAsync(2000); // idle flush fails
    expect(store.events).toHaveLength(0);
    expect(silent.error).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6000); // retry succeeds
    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({ added: 9 });
  });

  it("clientID bindings are persisted before the events that depend on them", async () => {
    const store = new FakeStore();
    store.bindDelayMs = 50;
    const order: string[] = [];
    const bind = store.bindClient.bind(store);
    store.bindClient = async (...a) => (await bind(...a), order.push("bind"), store.owners.get(FILE)!.get(a[1])!);
    const write = store.writeEvents.bind(store);
    store.writeEvents = async (rows) => (order.push("write"), write(rows));
    const { tracker, connect } = setup(store);
    await tracker.loadDocument(FILE);
    const p = connect("alice", 1001).keys(0, "a");
    await vi.advanceTimersByTimeAsync(100);
    await p;
    await tracker.flushDocument(FILE);
    expect(order).toEqual(["bind", "write"]);
  });

  it("unloading a document flushes it and forgets it", async () => {
    const { tracker, store, connect } = setup();
    await tracker.loadDocument(FILE);
    await connect("alice", 1001).keys(0, "bye");
    await tracker.unloadDocument(FILE);
    expect(store.events).toHaveLength(1);
    await expect(tracker.onDelivery(FILE, new Y.Doc(), "alice", Y.encodeStateAsUpdate(new Y.Doc()))).rejects.toThrow(/not loaded/);
  });

  it("many users and files do not interfere", async () => {
    const { tracker, store } = setup();
    const f2 = "file-2";
    await tracker.loadDocument(FILE);
    await tracker.loadDocument(f2);
    const a = new Y.Doc();
    a.clientID = 1;
    a.getText("content").insert(0, "A");
    await tracker.onDelivery(FILE, new Y.Doc(), "alice", Y.encodeStateAsUpdate(a));
    await tracker.onDelivery(f2, new Y.Doc(), "bob", Y.encodeStateAsUpdate(a)); // same clientID, different file: separate ownership
    await tracker.flushAll();
    expect(store.events.map((e) => [e.fileId, e.userId]).sort()).toEqual([[FILE, "alice"], [f2, "bob"]]);
  });
});
