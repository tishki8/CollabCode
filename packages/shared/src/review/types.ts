// Request/response shapes for the review tools (suggestions, comments, checkpoints, replay).
import { z } from "zod";
import type { PersonDto } from "../schemas";

export const MAX_SUGGESTION_TEXT = 20_000;
export const MAX_COMMENT_LENGTH = 4_000;
export const MAX_CHECKPOINT_NAME = 80;
export const MAX_CHECKPOINTS_PER_PROJECT = 200;

// A base64-encoded Yjs relative position is ~10-30 bytes; this is generous and bounds abuse.
const anchor = z.string().min(1).max(200).regex(/^[A-Za-z0-9+/=]+$/);
export const anchorsInput = z.object({ start: anchor, end: anchor, collapsed: z.boolean() });

export const createSuggestionInput = z.object({
  anchors: anchorsInput,
  newText: z.string().max(MAX_SUGGESTION_TEXT),
});
export type CreateSuggestionInput = z.infer<typeof createSuggestionInput>;

export const createThreadInput = z.object({
  anchors: anchorsInput,
  body: z.string().trim().min(1, "Write a comment first").max(MAX_COMMENT_LENGTH),
});
export type CreateThreadInput = z.infer<typeof createThreadInput>;

export const createCommentInput = z.object({ body: z.string().trim().min(1, "Write a comment first").max(MAX_COMMENT_LENGTH) });
export type CreateCommentInput = z.infer<typeof createCommentInput>;

export const createCheckpointInput = z.object({ name: z.string().trim().min(1, "Give the checkpoint a name").max(MAX_CHECKPOINT_NAME) });
export type CreateCheckpointInput = z.infer<typeof createCheckpointInput>;

export const restoreCheckpointInput = z.object({
  /** Omit to restore the whole project; give a file id to restore just that file. */
  fileId: z.string().min(1).max(64).optional(),
});
export type RestoreCheckpointInput = z.infer<typeof restoreCheckpointInput>;

export const SUGGESTION_STATUSES = ["OPEN", "ACCEPTED", "REJECTED", "STALE"] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

export interface SuggestionDto {
  id: string;
  fileId: string;
  author: PersonDto;
  anchors: { start: string; end: string; collapsed: boolean };
  /** The text the suggestion replaces, as it was when suggested ("" = pure insertion). */
  originalText: string;
  newText: string;
  status: SuggestionStatus;
  createdAt: string;
  resolvedBy: PersonDto | null;
  resolvedAt: string | null;
}

export interface CommentDto {
  id: string;
  author: PersonDto;
  body: string;
  createdAt: string;
}

export interface ThreadDto {
  id: string;
  fileId: string;
  anchors: { start: string; end: string; collapsed: boolean };
  /** The text the thread was attached to when it was started. */
  quote: string;
  createdBy: PersonDto;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: PersonDto | null;
  comments: CommentDto[];
}

export interface CheckpointDto {
  id: string;
  name: string;
  automatic: boolean;
  createdBy: PersonDto;
  createdAt: string;
  fileCount: number;
}

export interface CheckpointDetailDto extends CheckpointDto {
  files: { fileId: string; path: string; deleted: boolean }[];
}

export interface RestoreResultDto {
  /** The safety checkpoint made right before restoring, so the restore can be undone. */
  safetyCheckpointId: string;
  restored: number;
  recreated: number;
  removed: number;
  unchanged: number;
}

export interface ReplayPointDto {
  /** null = from the very beginning of the file's history. */
  checkpointId: string | null;
  name: string;
  at: string | null;
  /** How many recorded changes have to be replayed from this point. */
  events: number;
}

export interface ReplayEventDto {
  id: string;
  userId: string;
  startedAt: string;
  endedAt: string;
  origin: string;
  /** Base64 of the batch's merged Yjs update. */
  update: string;
}

export interface ReplayResponse {
  users: PersonDto[];
  /** Present on the first page only: the document state to start from (base64 Yjs update). */
  base: { checkpointId: string | null; state: string } | null;
  events: ReplayEventDto[];
  nextAfter: string | null;
  totalEvents: number;
}
