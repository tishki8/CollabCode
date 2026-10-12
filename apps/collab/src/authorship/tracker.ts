// Authorship tracker: the server-side half of authorship tracking.
//
// For every update a connection delivers it (1) checks clientID ownership, (2) works out which item
// ranges are NEW and credits them to the connection's authenticated user, (3) measures what the
// update deletes, and (4) adds all that to an in-memory batch. Batches are written to the event log
// after 1.5 s of quiet or 5 s at the most, when someone disconnects, before every document snapshot,
// and on shutdown, so the database is not hit on every keystroke.
//
// The user always comes from the verified connection context (never from the update itself).
import * as Y from "yjs";
import { OwnershipViolation, addInterval, checkOwnership, type Interval } from "@collabcode/shared";
import { decodeDelivered, hasDeletions, newRangesOf, removedBy, type NewRange } from "@collabcode/shared/yjs";

/** One row of the event log, as the tracker produces it. */
export interface NewEvent {
  fileId: string;
  userId: string;
  clientId: number;
  clockStart: number;
  clockEnd: number;
  update: Uint8Array;
  added: number;
  removed: number;
  linesAdded: number;
  linesRemoved: number;
  startedAt: Date;
  createdAt: Date;
}

export interface AuthorshipStore {
  loadOwners(fileId: string): Promise<Map<number, string>>;
  /** Item ranges that already have an event (so re-sent copies are not "new"). */
  loadCoverage(fileId: string): Promise<{ client: number; start: number; end: number }[]>;
  /** Persist "clientId belongs to userId" unless someone already owns it. Returns the actual owner. */
  bindClient(fileId: string, clientId: number, userId: string): Promise<string>;
  writeEvents(rows: NewEvent[]): Promise<void>;
}

export interface TrackerLog {
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}

export interface TrackerOptions {
  store: AuthorshipStore;
  /** Write a batch this long after its last change. */
  idleMs?: number;
  /** ...and never keep a batch longer than this. */
  maxMs?: number;
  /** Flush early if a batch's buffered updates exceed this many bytes. */
  maxBytes?: number;
  now?: () => number;
  log?: TrackerLog;
}

interface Batch {
  userId: string;
  clientId: number;
  /** Item ids inserted so far, [start, end); null for a batch that only deleted text. */
  range: [number, number] | null;
  updates: Uint8Array[];
  bytes: number;
  added: number;
  removed: number;
  linesAdded: number;
  linesRemoved: number;
  startedAt: number;
  lastAt: number;
  idle: ReturnType<typeof setTimeout>;
  max: ReturnType<typeof setTimeout>;
}

interface DocState {
  owners: Map<number, string>;
  covered: Map<number, Interval[]>;
  /** The most recent clientID each user used here (names the batch of a delete-only update). */
  lastClientOf: Map<string, number>;
  batches: Map<string, Batch>;
  /** Events waiting to be written; kept (and retried) if a write fails. */
  outbox: NewEvent[];
  /** Persisting new clientID bindings; flushes wait for these. */
  binding: Set<Promise<unknown>>;
  flushing: Promise<void>;
}

const keyOf = (userId: string, clientId: number) => `${userId}:${clientId}`;

export class AuthorshipTracker {
  private docs = new Map<string, DocState>();
  private idleMs: number;
  private maxMs: number;
  private maxBytes: number;
  private now: () => number;
  private log: TrackerLog;
  private store: AuthorshipStore;

  constructor(opts: TrackerOptions) {
    this.store = opts.store;
    this.idleMs = opts.idleMs ?? 1500;
    this.maxMs = opts.maxMs ?? 5000;
    this.maxBytes = opts.maxBytes ?? 1_000_000;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? console;
  }

  /** Load clientID owners and already-attributed ranges when a document is opened. */
  async loadDocument(fileId: string): Promise<void> {
    if (this.docs.has(fileId)) return;
    const [owners, coverage] = await Promise.all([this.store.loadOwners(fileId), this.store.loadCoverage(fileId)]);
    const covered = new Map<number, Interval[]>();
    for (const r of coverage) covered.set(r.client, addInterval(covered.get(r.client) ?? [], [r.start, r.end]));
    this.docs.set(fileId, {
      owners,
      covered,
      lastClientOf: new Map(),
      batches: new Map(),
      outbox: [],
      binding: new Set(),
      flushing: Promise.resolve(),
    });
  }

  private state(fileId: string): DocState {
    const s = this.docs.get(fileId);
    if (!s) throw new Error(`authorship: document ${fileId} is not loaded`);
    return s;
  }

  /** Claim ownership of clientIDs for `userId`, or throw if somebody else owns one. */
  private async claim(fileId: string, st: DocState, userId: string, clientIds: Iterable<number>, context: string) {
    const verdict = checkOwnership(clientIds, st.owners, userId);
    if (verdict.violation) {
      this.log.warn(`[authorship] rejected ${context}: ${verdict.violation.message}`, {
        fileId,
        clientId: verdict.violation.clientId,
        owner: verdict.violation.owner,
        attemptedBy: userId,
      });
      throw verdict.violation;
    }
    // Claim in memory right away so a concurrent message cannot claim the same id; persist after.
    for (const c of verdict.toBind) st.owners.set(c, userId);
    for (const c of verdict.toBind) {
      const persisting = this.store.bindClient(fileId, c, userId).then((actualOwner) => {
        if (actualOwner !== userId) {
          // Another server instance bound it first.
          st.owners.set(c, actualOwner);
          throw new OwnershipViolation(c, actualOwner, userId);
        }
      });
      st.binding.add(persisting);
      persisting.catch(() => undefined).finally(() => st.binding.delete(persisting));
      await persisting;
    }
    for (const c of clientIds) st.lastClientOf.set(userId, c);
  }

  /** An awareness update (cursor/presence) from a connection mentions these clientIDs: they are its own. */
  async onAwareness(fileId: string, userId: string, clientIds: number[]): Promise<void> {
    if (clientIds.length === 0) return;
    await this.claim(fileId, this.state(fileId), userId, clientIds, "awareness update");
  }

  /**
   * A connection (authenticated as `userId`) delivers a Yjs update. Must be called BEFORE the update is
   * applied to `doc`, so new ranges and deleted text can be measured against the previous state.
   * Throws OwnershipViolation to reject the update.
   */
  async onDelivery(fileId: string, doc: Y.Doc, userId: string, update: Uint8Array): Promise<void> {
    const st = this.state(fileId);

    // Everything up to the first await runs synchronously, so two connections cannot both see the
    // same range as "new".
    const ranges = newRangesOf(
      decodeDelivered(update),
      (c) => st.covered.get(c) ?? [],
      (c) => Y.getState(doc.store, c),
    );
    const deletes = hasDeletions(update);
    if (ranges.length === 0 && !deletes) return; // nothing new: a plain re-sync of known items

    const verdict = checkOwnership(ranges.map((r) => r.client), st.owners, userId);
    if (verdict.violation) {
      this.log.warn(`[authorship] rejected update: ${verdict.violation.message}`, {
        fileId,
        clientId: verdict.violation.clientId,
        owner: verdict.violation.owner,
        attemptedBy: userId,
        newRanges: ranges.length,
      });
      throw verdict.violation;
    }

    const removed = deletes ? removedBy(update, doc) : { chars: 0, lines: 0 };
    for (const r of ranges) st.covered.set(r.client, addInterval(st.covered.get(r.client) ?? [], [r.start, r.end]));
    this.addToBatches(fileId, st, userId, update, ranges, removed);

    // Persist new clientID claims; the update is only applied once this resolves.
    await this.claim(fileId, st, userId, ranges.map((r) => r.client), "update");
  }

  private addToBatches(
    fileId: string,
    st: DocState,
    userId: string,
    update: Uint8Array,
    ranges: NewRange[],
    removed: { chars: number; lines: number },
  ) {
    const targets: { clientId: number; range: NewRange | null }[] =
      ranges.length > 0
        ? ranges.map((range) => ({ clientId: range.client, range }))
        : [{ clientId: st.lastClientOf.get(userId) ?? 0, range: null }];

    targets.forEach(({ clientId, range }, i) => {
      let batch = st.batches.get(keyOf(userId, clientId));
      // A batch must cover ONE contiguous range of ids; a jump starts a new batch.
      if (batch && range && batch.range && range.start !== batch.range[1]) {
        this.flushBatch(fileId, st, batch);
        batch = undefined;
      }
      if (!batch) batch = this.newBatch(fileId, st, userId, clientId);
      if (range) {
        batch.range = batch.range ? [batch.range[0], range.end] : [range.start, range.end];
        batch.added += range.added;
        batch.linesAdded += range.linesAdded;
      }
      if (i === 0) {
        batch.removed += removed.chars; // deletions are counted once, on the first batch
        batch.linesRemoved += removed.lines;
      }
      batch.updates.push(update);
      batch.bytes += update.byteLength;
      if (batch.updates.length > 64) {
        batch.updates = [Y.mergeUpdates(batch.updates)]; // keep memory small during long typing
        batch.bytes = batch.updates[0]!.byteLength;
      }
      batch.lastAt = this.now();
      clearTimeout(batch.idle);
      const b = batch;
      batch.idle = setTimeout(() => this.flushBatch(fileId, st, b), this.idleMs);
      batch.idle.unref?.();
      if (batch.bytes > this.maxBytes) this.flushBatch(fileId, st, batch);
    });
  }

  private newBatch(fileId: string, st: DocState, userId: string, clientId: number): Batch {
    const now = this.now();
    const batch: Batch = {
      userId,
      clientId,
      range: null,
      updates: [],
      bytes: 0,
      added: 0,
      removed: 0,
      linesAdded: 0,
      linesRemoved: 0,
      startedAt: now,
      lastAt: now,
      idle: setTimeout(() => undefined, 0),
      max: setTimeout(() => this.flushBatch(fileId, st, batch), this.maxMs),
    };
    batch.max.unref?.();
    clearTimeout(batch.idle);
    st.batches.set(keyOf(userId, clientId), batch);
    return batch;
  }

  /** Take a batch out of memory and write it. */
  private flushBatch(fileId: string, st: DocState, batch: Batch): Promise<void> {
    clearTimeout(batch.idle);
    clearTimeout(batch.max);
    const key = keyOf(batch.userId, batch.clientId);
    if (st.batches.get(key) === batch) st.batches.delete(key);
    st.outbox.push({
      fileId,
      userId: batch.userId,
      clientId: batch.clientId,
      clockStart: batch.range?.[0] ?? 0,
      clockEnd: batch.range?.[1] ?? 0,
      update: Y.mergeUpdates(batch.updates),
      added: batch.added,
      removed: batch.removed,
      linesAdded: batch.linesAdded,
      linesRemoved: batch.linesRemoved,
      startedAt: new Date(batch.startedAt),
      createdAt: new Date(batch.lastAt),
    });
    return this.writePending(fileId, st);
  }

  /** Write queued events; on failure keep them and retry on the next flush. */
  private writePending(fileId: string, st: DocState): Promise<void> {
    st.flushing = st.flushing.then(async () => {
      await Promise.allSettled([...st.binding]); // owners are persisted before the events that use them
      if (st.outbox.length === 0) return;
      const rows = st.outbox;
      st.outbox = [];
      try {
        await this.store.writeEvents(rows);
      } catch (err) {
        st.outbox = [...rows, ...st.outbox];
        this.log.error(`[authorship] could not write ${rows.length} event(s) for ${fileId}; will retry`, err);
        const retry = setTimeout(() => void this.writePending(fileId, st), this.maxMs);
        retry.unref?.();
      }
    });
    return st.flushing;
  }

  /** Write everything buffered for a document. Called before its snapshot is stored. */
  async flushDocument(fileId: string): Promise<void> {
    const st = this.docs.get(fileId);
    if (!st) return;
    for (const batch of [...st.batches.values()]) this.flushBatch(fileId, st, batch);
    await this.writePending(fileId, st);
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.docs.keys()].map((id) => this.flushDocument(id)));
  }

  /** The document was closed on this server: write what is buffered, then forget it. */
  async unloadDocument(fileId: string): Promise<void> {
    await this.flushDocument(fileId);
    this.docs.delete(fileId);
  }

  /** For tests and diagnostics. */
  pending(fileId: string): number {
    const st = this.docs.get(fileId);
    return st ? st.batches.size + st.outbox.length : 0;
  }
}
