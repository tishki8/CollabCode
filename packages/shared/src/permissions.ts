// Single source of truth for "who may do what". Used by the API now and by the
// collab server (Phase 2+). Never trust a role sent by the client: always load
// the role from the database and pass it in here.

export const ROLES = ["OWNER", "EDITOR", "COMMENTER", "VIEWER"] as const;
export type Role = (typeof ROLES)[number];

export const LINK_ROLES = ["EDITOR", "COMMENTER", "VIEWER"] as const;
export type LinkRole = (typeof LINK_ROLES)[number];

export const ACTIONS = [
  "project:read",
  "project:update",
  "project:delete",
  "file:read",
  "file:manage", // create / rename / delete files and folders
  "file:edit", // type into a document
  "suggestion:create",
  "suggestion:resolve", // accept / reject
  "comment:create",
  "comment:resolve",
  "checkpoint:create",
  "checkpoint:restore",
  "run:execute",
  "share:manage",
  "member:manage",
  "export:zip",
  "export:github",
] as const;
export type Action = (typeof ACTIONS)[number];

const VIEWER_ACTIONS: readonly Action[] = ["project:read", "file:read", "export:zip"];
const COMMENTER_ACTIONS: readonly Action[] = [...VIEWER_ACTIONS, "comment:create", "suggestion:create"];
const EDITOR_ACTIONS: readonly Action[] = [
  ...COMMENTER_ACTIONS,
  "file:manage",
  "file:edit",
  "suggestion:resolve",
  "comment:resolve",
  "checkpoint:create",
  "run:execute",
];
const OWNER_ACTIONS: readonly Action[] = [
  ...EDITOR_ACTIONS,
  "project:update",
  "project:delete",
  "checkpoint:restore",
  "share:manage",
  "member:manage",
  "export:github",
];

const MATRIX: Record<Role, ReadonlySet<Action>> = {
  VIEWER: new Set(VIEWER_ACTIONS),
  COMMENTER: new Set(COMMENTER_ACTIONS),
  EDITOR: new Set(EDITOR_ACTIONS),
  OWNER: new Set(OWNER_ACTIONS),
};

/** Deny by default: unknown/missing roles can do nothing. */
export function can(role: Role | null | undefined, action: Action): boolean {
  if (!role) return false;
  return MATRIX[role]?.has(action) ?? false;
}
