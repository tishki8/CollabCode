// Connection authorization for the collab server.
//
// Trust model: the browser sends a short-lived token (signed by the API) that proves WHO
// it is. It says nothing about what the user may do: the role is looked up in the
// database on every connection, so revoking access takes effect on the next (re)connect
// and a client can never claim a role.
import { verifyCollabToken } from "@collabcode/shared/collab-token";
import type { PrismaClient } from "@collabcode/db";
import { can, type Role } from "@collabcode/shared";

/** What we remember about an authenticated connection (the Hocuspocus `context`). */
export interface ConnContext {
  userId: string;
  projectId: string;
  role: Role;
  /** Identity shown on cursors and in the presence panel. Comes from the DB, never the client. */
  user: { id: string; name: string; color: string; initials: string; isGuest: boolean };
}

export interface AuthResult {
  context: ConnContext;
  /** True when the connection may read but not change the document. */
  readOnly: boolean;
}

export type ParsedDocumentName =
  | { kind: "file"; fileId: string }
  | { kind: "presence"; projectId: string };

const ID = "[A-Za-z0-9_-]{1,64}";

/**
 * Document names:
 *   file:<fileId>        the text of one file
 *   presence:<projectId> an awareness-only room: who is online and which file they view
 */
export function parseDocumentName(name: string): ParsedDocumentName | null {
  const file = new RegExp(`^file:(${ID})$`).exec(name);
  if (file) return { kind: "file", fileId: file[1]! };
  const presence = new RegExp(`^presence:(${ID})$`).exec(name);
  if (presence) return { kind: "presence", projectId: presence[1]! };
  return null;
}

/** Throws unless the token is valid and the user may open the document. */
export async function authorize(args: {
  prisma: PrismaClient;
  secret: string;
  token: string | undefined;
  documentName: string;
}): Promise<AuthResult> {
  const { prisma, secret, token, documentName } = args;
  const doc = parseDocumentName(documentName);
  if (!doc || !token) throw new Error("permission-denied");

  let userId: string;
  try {
    userId = await verifyCollabToken(token, secret);
  } catch {
    throw new Error("permission-denied");
  }

  // Resolve the project the document belongs to. A file that is missing, deleted or a
  // folder is reported exactly like "no access" so ids can't be probed.
  let projectId: string;
  if (doc.kind === "file") {
    const node = await prisma.fileNode.findFirst({
      where: { id: doc.fileId, type: "FILE", deletedAt: null },
      select: { projectId: true },
    });
    if (!node) throw new Error("permission-denied");
    projectId = node.projectId;
  } else {
    projectId = doc.projectId;
  }

  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { role: true, color: true, initials: true, user: { select: { id: true, name: true, isGuest: true } } },
  });
  if (!member || !can(member.role, "file:read")) throw new Error("permission-denied");

  return {
    context: {
      userId,
      projectId,
      role: member.role,
      user: {
        id: member.user.id,
        name: member.user.name,
        color: member.color,
        initials: member.initials,
        isGuest: member.user.isGuest,
      },
    },
    // Presence rooms carry no file content, so nobody may write to them.
    readOnly: doc.kind === "presence" || !can(member.role, "file:edit"),
  };
}

const AWARENESS_KEYS = new Set(["user", "selection", "fileId"]);
/** A cursor selection is two small relative positions; anything bigger is junk or abuse. */
const MAX_SELECTION_JSON = 2000;
const FILE_ID_RE = new RegExp(`^${ID}$`);

/**
 * Awareness (cursors, presence) is client-supplied, so rewrite it before it is broadcast:
 * the visible identity always comes from the database, unknown keys are dropped, and
 * `fileId` must look like an id. This stops one user from showing up as someone else.
 * Mutates the state in place; `null` (a client leaving) is left alone.
 */
export function sanitizeAwarenessState(state: Record<string, unknown> | null, context: ConnContext): void {
  if (!state || typeof state !== "object") return;
  for (const key of Object.keys(state)) if (!AWARENESS_KEYS.has(key)) delete state[key];
  state.user = context.user;
  if (state.selection !== undefined) {
    const ok = typeof state.selection === "object" && state.selection !== null && JSON.stringify(state.selection).length <= MAX_SELECTION_JSON;
    if (!ok) delete state.selection;
  }
  if (state.fileId !== undefined && !(typeof state.fileId === "string" && FILE_ID_RE.test(state.fileId))) {
    delete state.fileId;
  }
}
