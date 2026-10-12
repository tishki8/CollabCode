// Hocuspocus frames every WebSocket message as: document name, message type, payload. For document
// sync messages the payload is a y-protocols sync message: sub-type, then the Yjs update bytes.
import * as decoding from "lib0/decoding";

const MSG_SYNC = 0;
const MSG_SYNC_REPLY = 4;
const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;

/** The Yjs update carried by a client message, or null if it carries none (state requests, awareness, auth...). */
export function extractSyncUpdate(frame: Uint8Array): Uint8Array | null {
  try {
    const d = decoding.createDecoder(frame);
    decoding.readVarString(d); // document name
    const type = decoding.readVarUint(d);
    if (type !== MSG_SYNC && type !== MSG_SYNC_REPLY) return null;
    const sub = decoding.readVarUint(d);
    if (sub !== SYNC_STEP2 && sub !== SYNC_UPDATE) return null;
    return decoding.readVarUint8Array(d);
  } catch {
    return null; // malformed: Hocuspocus will reject it itself
  }
}
