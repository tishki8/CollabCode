// Shared by the integration tests: a WebSocket client that speaks the Hocuspocus protocol by hand,
// so tests can send exactly what a modified (hostile) client could, with no client library in between.
import WebSocket from "ws";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import { readAuthMessage, writeAuthentication } from "@hocuspocus/common";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const until = async (cond: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await sleep(20);
  }
};

// Hocuspocus message types (first varint after the document name)
const MSG_SYNC = 0;
const MSG_AUTH = 2;
const MSG_CLOSE = 7;
const MSG_SYNC_STATUS = 8;
// y-protocols sync sub-types (first varint of a Sync message)
const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;


/** A WebSocket client that speaks the Hocuspocus protocol by hand. */
export class RawClient {
  ws: WebSocket;
  scope: string | null = null;
  denied: string | null = null;
  /** Server replies to our update frames: true = applied, false = refused. */
  syncStatuses: boolean[] = [];
  /** The socket closed. */
  closed = false;
  closeCode: number | null = null;
  /**
   * The server closed THIS DOCUMENT's connection (Hocuspocus multiplexes documents over one socket, so
   * it signals a rejection with a CLOSE message carrying a reason, not by closing the socket).
   */
  closeReason: string | null = null;

  constructor(
    port: number,
    readonly doc: string,
  ) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws.on("close", (code) => {
      this.closed = true;
      this.closeCode = code;
    });
    this.ws.on("message", (data: Buffer) => this.onFrame(new Uint8Array(data)));
  }

  private onFrame(frame: Uint8Array) {
    const d = decoding.createDecoder(frame);
    decoding.readVarString(d); // document name
    const type = decoding.readVarUint(d);
    if (type === MSG_AUTH) {
      readAuthMessage(
        d,
        () => {},
        (reason) => (this.denied = reason),
        (scope) => (this.scope = scope),
      );
    } else if (type === MSG_CLOSE) {
      this.closeReason = decoding.readVarString(d);
    } else if (type === MSG_SYNC_STATUS) {
      this.syncStatuses.push(decoding.readVarUint(d) === 1);
    }
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
  }

  authFrame(token: string) {
    const e = encoding.createEncoder();
    encoding.writeVarString(e, this.doc);
    encoding.writeVarUint(e, MSG_AUTH);
    writeAuthentication(e, token);
    encoding.writeVarString(e, "4.7.0");
    return encoding.toUint8Array(e);
  }

  /** A Sync message carrying a raw Yjs update (what any client sends when its document changes). */
  updateFrame(update: Uint8Array) {
    const e = encoding.createEncoder();
    encoding.writeVarString(e, this.doc);
    encoding.writeVarUint(e, MSG_SYNC);
    encoding.writeVarUint(e, SYNC_UPDATE);
    encoding.writeVarUint8Array(e, update);
    return encoding.toUint8Array(e);
  }

  /** The other way to push state: a SyncStep2 message (the reply to the server's state request). */
  step2Frame(update: Uint8Array) {
    const e = encoding.createEncoder();
    encoding.writeVarString(e, this.doc);
    encoding.writeVarUint(e, MSG_SYNC);
    encoding.writeVarUint(e, SYNC_STEP2);
    encoding.writeVarUint8Array(e, update);
    return encoding.toUint8Array(e);
  }

  send(frame: Uint8Array) {
    this.ws.send(frame);
  }

  async authenticate(token: string) {
    this.send(this.authFrame(token));
    await until(() => this.scope !== null || this.denied !== null || this.closed);
  }

  /** An awareness (cursor/presence) frame that claims the given clientID. */
  awarenessFrame(clientId: number, state: Record<string, unknown> = { user: { name: "x" } }) {
    const doc = new Y.Doc();
    doc.clientID = clientId;
    const awareness = new Awareness(doc);
    awareness.setLocalState(state);
    const e = encoding.createEncoder();
    encoding.writeVarString(e, this.doc);
    encoding.writeVarUint(e, 1); // MessageType.Awareness
    encoding.writeVarUint8Array(e, encodeAwarenessUpdate(awareness, [clientId]));
    return encoding.toUint8Array(e);
  }

  close() {
    this.ws.close();
  }
}

/** A Yjs update that inserts `text` at the start of the shared text, as a hostile client would build it. */
export function evilInsert(text: string) {
  const d = new Y.Doc();
  d.getText("content").insert(0, text);
  return Y.encodeStateAsUpdate(d);
}

