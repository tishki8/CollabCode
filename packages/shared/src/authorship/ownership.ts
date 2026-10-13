// A Yjs clientID is owned by the first authenticated user whose connection used it. The binding is
// persisted, so it survives restarts and holds across server instances.
//
// Without it, a client could pre-send text under ANOTHER user's clientID: that either steals
// attribution for the text or, more cleverly, squats the ID so the real owner's later edits collide
// with the planted items and are silently dropped by Yjs.

export class OwnershipViolation extends Error {
  /** WebSocket close code Hocuspocus uses when a hook throws (4403 = Forbidden). */
  code = 4403;
  reason = "Forbidden";
  constructor(
    readonly clientId: number,
    readonly owner: string,
    readonly attemptedBy: string,
  ) {
    super(`clientID ${clientId} belongs to user ${owner}, not ${attemptedBy}`);
  }
}

export interface OwnershipCheck {
  /** ClientIDs nobody owns yet: the caller should persist them as owned by `userId`. */
  toBind: number[];
  /** Set when a clientID is owned by someone else. */
  violation: OwnershipViolation | null;
}

export function checkOwnership(clientIds: Iterable<number>, owners: ReadonlyMap<number, string>, userId: string): OwnershipCheck {
  const toBind: number[] = [];
  for (const id of new Set(clientIds)) {
    const owner = owners.get(id);
    if (owner === undefined) toBind.push(id);
    else if (owner !== userId) return { toBind: [], violation: new OwnershipViolation(id, owner, userId) };
  }
  return { toBind, violation: null };
}
