// Test helpers: a tiny simulated server and clients built on REAL Yjs documents, so the tests exercise
// actual Yjs behaviour (merging, concurrent inserts, pending updates, undo) and not assumptions.
import * as Y from "yjs";
import { AttributionIndex } from "./blame";
import { decodeDelivered, newRangesOf, removedBy, type NewRange } from "./delivery";
import { addInterval, type Interval } from "./intervals";
import { checkOwnership } from "./ownership";

export class SimServer {
  doc = new Y.Doc();
  index = new AttributionIndex();
  covered = new Map<number, Interval[]>();
  owners = new Map<number, string>();
  /** Everything accepted, for inspecting stats. */
  log: { user: string; ranges: NewRange[]; removed: { chars: number; lines: number } }[] = [];
  now = 1_000;

  /** Deliver an update the way the collab server does: attribute at delivery, then apply. */
  deliver(user: string, update: Uint8Array) {
    const ranges = newRangesOf(
      decodeDelivered(update),
      (c) => this.covered.get(c) ?? [],
      (c) => Y.getState(this.doc.store, c),
    );
    // Unowned clientIDs are claimed by the deliverer. Items under SOMEONE ELSE's clientID are not
    // rejected (after a crash, other people legitimately re-send the owner's lost text): they are
    // credited to the owner and flagged as recovered.
    const verdict = checkOwnership(ranges.filter((r) => (this.owners.get(r.client) ?? user) === user).map((r) => r.client), this.owners, user);
    verdict.toBind.forEach((c) => this.owners.set(c, user));
    const removed = removedBy(update, this.doc); // measured BEFORE applying
    this.now += 1_000;
    for (const r of ranges) {
      this.covered.set(r.client, addInterval(this.covered.get(r.client) ?? [], [r.start, r.end]));
      const owner = this.owners.get(r.client)!;
      this.index.add([{ client: r.client, start: r.start, end: r.end, user: owner, at: this.now, ...(owner !== user ? { recovered: true } : {}) }]);
    }
    Y.applyUpdate(this.doc, update, "remote");
    this.log.push({ user, ranges, removed });
    return { ranges, removed };
  }
}

export class SimClient {
  doc = new Y.Doc();
  text = this.doc.getText("content");
  outbox: Uint8Array[] = [];

  constructor(
    readonly user: string,
    clientID: number,
    private server: SimServer,
  ) {
    this.doc.clientID = clientID;
    this.doc.on("update", (u: Uint8Array, origin: unknown) => {
      if (origin !== "remote") this.outbox.push(u);
    });
    // start from the server's current state
    Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(server.doc), "remote");
  }

  /** Send what has been typed since the last send (one merged message, like a batch). */
  send() {
    if (!this.outbox.length) return null;
    const merged = Y.mergeUpdates(this.outbox);
    this.outbox = [];
    return this.server.deliver(this.user, merged);
  }

  /** Receive everything the server has that we lack. */
  sync() {
    Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(this.server.doc, Y.encodeStateVector(this.doc)), "remote");
  }

  type(offset: number, s: string) {
    this.text.insert(offset, s);
    return this;
  }
  /** Type character by character, like real keystrokes. */
  typeKeys(offset: number, s: string) {
    [...s].forEach((ch, i) => this.text.insert(offset + i, ch));
    return this;
  }
}
