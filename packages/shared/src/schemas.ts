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
  details?: unknown;
}

// ---------- sharing & collaboration ----------

/** Roles a share link can grant in this phase (commenter arrives with the review tools). */
export const SHARE_LINK_ROLES = ["VIEWER", "EDITOR"] as const;

export const createShareLinkInput = z.object({ role: z.enum(SHARE_LINK_ROLES) });
export type CreateShareLinkInput = z.infer<typeof createShareLinkInput>;

/** The secret part of a share link URL: url-safe base64, no other characters. */
export const shareTokenSchema = z
  .string()
  .min(20)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "Invalid link");
export const joinShareLinkInput = z.object({ token: shareTokenSchema });

export interface ShareLinkDto {
  id: string;
  role: "VIEWER" | "EDITOR" | "COMMENTER";
  createdAt: string;
}

/** Returned once, when a link is created. The raw token is never stored, so it can't be shown again. */
export interface CreatedShareLinkDto extends ShareLinkDto {
  token: string;
}

export interface JoinResult {
  projectId: string;
  role: Role;
  /** False when the user was already a member (their existing role is kept). */
  joined: boolean;
}

export interface CollabTokenResponse {
  token: string;
  /** WebSocket URL of the collab server as the browser should reach it. */
  url: string;
  role: Role;
  user: { id: string; name: string; color: string; initials: string };
}
