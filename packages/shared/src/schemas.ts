import { z } from "zod";
import { LANGUAGES, type Language } from "./languages";
import type { Role } from "./permissions";

// ---------- field validators ----------

export const MAX_FILES_PER_PROJECT = 500;
export const MAX_TREE_DEPTH = 10;

/** A single path segment (file or folder name). No slashes, no control chars, no "." / "..". */
export const nodeNameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(100, "Name is too long")
  .refine((s) => !/[/\\]/.test(s), "Name cannot contain slashes")
  // eslint-disable-next-line no-control-regex
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "Name cannot contain control characters")
  .refine((s) => s !== "." && s !== "..", "Invalid name");

const idSchema = z.string().min(1).max(64);

// ---------- requests ----------

export const createProjectInput = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  language: z.enum(LANGUAGES),
});
export type CreateProjectInput = z.infer<typeof createProjectInput>;

export const updateProjectInput = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    // null resets to the language default
    entryFile: z.string().trim().min(1).max(300).nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.entryFile !== undefined, "Nothing to update");
export type UpdateProjectInput = z.infer<typeof updateProjectInput>;

export const createNodeInput = z.object({
  parentId: idSchema.nullable(),
  name: nodeNameSchema,
  type: z.enum(["FILE", "FOLDER"]),
});
export type CreateNodeInput = z.infer<typeof createNodeInput>;

export const renameNodeInput = z.object({ name: nodeNameSchema });
export type RenameNodeInput = z.infer<typeof renameNodeInput>;

// ---------- responses ----------

export interface ProjectSummary {
  id: string;
  name: string;
  language: Language;
  role: Role;
  ownerName: string;
  updatedAt: string;
}

export interface ProjectList {
  mine: ProjectSummary[];
  shared: ProjectSummary[];
}

export interface ProjectDetail extends ProjectSummary {
  entryFile: string | null;
}

export interface FileNodeDto {
  id: string;
  parentId: string | null;
  name: string;
  type: "FILE" | "FOLDER";
}

export interface ApiError {
  error: string;
  /** Present for errors the UI treats specially (see API_ERROR_CODES). */
  code?: string;
  details?: unknown;
}

// ---------- sharing & collaboration ----------

/** Roles a share link can grant. Commenters can view now and will be able to comment once comments exist. */
export const SHARE_LINK_ROLES = ["VIEWER", "COMMENTER", "EDITOR"] as const;
export type ShareLinkRole = (typeof SHARE_LINK_ROLES)[number];

/** How long a new link stays valid. The server turns this into a timestamp (it never trusts a client clock). */
export const LINK_EXPIRY_CHOICES = ["1h", "1d", "7d", "never"] as const;
export type LinkExpiryChoice = (typeof LINK_EXPIRY_CHOICES)[number];

export const createShareLinkInput = z.object({
  role: z.enum(SHARE_LINK_ROLES),
  expiresIn: z.enum(LINK_EXPIRY_CHOICES).default("7d"),
  /** Invite-only: joining creates a request that the owner must approve. */
  requiresApproval: z.boolean().default(false),
});
export type CreateShareLinkInput = z.input<typeof createShareLinkInput>;

/** The secret part of a share link URL: url-safe base64, no other characters. */
export const shareTokenSchema = z
  .string()
  .min(20)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "Invalid link");
export const joinShareLinkInput = z.object({ token: shareTokenSchema });
export const previewShareLinkInput = joinShareLinkInput;

/**
 * What a guest is called. Shown to everyone in presence and on cursors, so keep it short and
 * plain: no control characters, runs of spaces collapsed.
 */
export const GUEST_NAME_MAX = 40;
export const displayNameSchema = z
  .string()
  .transform((s) => s.replace(/\s+/g, " ").trim())
  .pipe(
    z
      .string()
      .min(1, "Please enter a name")
      .max(GUEST_NAME_MAX, `Name must be at most ${GUEST_NAME_MAX} characters`)
      // eslint-disable-next-line no-control-regex
      .refine((s) => !/[\u0000-\u001f\u007f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(s), "Name contains invalid characters"),
  );
export const joinAsGuestInput = z.object({ token: shareTokenSchema, displayName: displayNameSchema });
export type JoinAsGuestInput = z.input<typeof joinAsGuestInput>;

/** A project's guests are capped so a leaked link cannot be used to mint unlimited accounts. */
export const MAX_GUESTS_PER_PROJECT = 50;

export interface ShareLinkDto {
  id: string;
  role: ShareLinkRole;
  createdAt: string;
  /** ISO timestamp, or null for a link that never expires. */
  expiresAt: string | null;
  requiresApproval: boolean;
}

/** Returned once, when a link is created. The raw token is never stored, so it can't be shown again. */
export interface CreatedShareLinkDto extends ShareLinkDto {
  token: string;
}

/** What someone holding a link may see before joining (so they get a clear message, not a surprise). */
export interface LinkPreview {
  projectName: string;
  ownerName: string;
  role: ShareLinkRole;
  requiresApproval: boolean;
  expiresAt: string | null;
}

export type JoinResult =
  | {
      status: "joined";
      projectId: string;
      role: Role;
      /** False when the user was already a member (their existing role is kept). */
      joined: boolean;
    }
  | {
      /** Invite-only link: waiting for the owner. Ask again later (the call is idempotent). */
      status: "pending";
    };

export interface JoinRequestDto {
  id: string;
  /** The role they will get if approved (the link's role). */
  role: ShareLinkRole;
  requester: { id: string; name: string; isGuest: boolean };
  createdAt: string;
}

/** Machine-readable error codes the UI uses to pick a clear message. */
export const API_ERROR_CODES = ["LINK_EXPIRED", "LINK_INVALID", "JOIN_DENIED", "GUEST_LIMIT"] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface MeDto {
  id: string;
  name: string;
  isGuest: boolean;
}

export interface CollabTokenResponse {
  token: string;
  /** WebSocket URL of the collab server as the browser should reach it. */
  url: string;
  role: Role;
  user: { id: string; name: string; color: string; initials: string; isGuest: boolean };
}

// ---------- authorship ----------

/** A person as shown next to their work (blame, history, summary). */
export interface PersonDto {
  id: string;
  name: string;
  isGuest: boolean;
  /** Their project colour and initials, so identity is never colour alone. */
  color: string;
  initials: string;
}

export interface MemberDto extends PersonDto {
  role: Role;
}

/**
 * Which user first delivered which Yjs item ranges of a file. Compact on purpose: this is fetched
 * incrementally (`after` = last event id seen) and joined with the live text in the browser.
 */
export interface AttributionResponse {
  users: PersonDto[];
  /** [clientId, clockStart, clockEnd, userIndex (into `users`), atMs, eventId] */
  ranges: [number, number, number, number, number, string][];
  /** Pass as `after` next time. Null if there are no events yet. */
  lastEventId: string | null;
  hasMore: boolean;
}

export interface EventDto {
  id: string;
  userId: string;
  startedAt: string;
  endedAt: string;
  added: number;
  removed: number;
  linesAdded: number;
  linesRemoved: number;
}

export interface EventsResponse {
  users: PersonDto[];
  events: EventDto[];
  /** Pass as `before` for the next (older) page; null when there are no more. */
  nextBefore: string | null;
}

export interface HunkDto {
  kind: "add" | "del";
  line: number;
  text: string;
  /** The text was cut for size. */
  truncated?: boolean;
}

export interface HistoryDiffResponse {
  users: PersonDto[];
  changes: { eventId: string; userId: string; at: string; hunks: HunkDto[] }[];
  /** Replay covered this many events from the beginning of the log. */
  replayedEvents: number;
}

export interface ContributorSummary extends PersonDto {
  added: number;
  removed: number;
  linesAdded: number;
  linesRemoved: number;
  activeMs: number;
  sessions: number;
  firstAt: string;
  lastAt: string;
  /** Lines whose main author is this person in the saved version of every file. */
  survivingLines: number;
}

export interface ContributionsResponse {
  from: string;
  to: string;
  bucketMs: number;
  /** In order of first activity (deliberately not ranked by amount). */
  people: ContributorSummary[];
  lanes: { userId: string; cells: { added: number; removed: number; activeMs: number }[] }[];
  /** True when there was more activity than could be summarised. */
  truncated: boolean;
}

/** Replaying history stops being practical beyond this many events (see README). */
export const MAX_REPLAY_EVENTS = 20_000;
