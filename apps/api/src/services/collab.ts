// The API's view of the collab server's signed /internal endpoints (see apps/collab/src/internal.ts).
// Behind an interface so API tests can swap in an in-memory implementation.
import type { Anchors } from "@collabcode/shared";
import { signInternal } from "@collabcode/shared/internal-auth";
import { HttpError } from "../errors";

export type ResolveResult =
  | { status: "ok"; from: number; to: number; text: string; /** every anchored character was deleted */ gone: boolean }
  | { status: "invalid" };

export type EditOp = { type: "replace-range"; anchors: Anchors; newText: string } | { type: "set-text"; text: string };

export interface EditRequest {
  fileId: string;
  /** Who the change is credited to in the history. */
  userId: string;
  origin: "suggestion-accept" | "restore";
  op: EditOp;
}

export type EditResult = { status: "applied"; from: number; to: number; replaced: string } | { status: "unchanged" } | { status: "stale" };

export interface CollabClient {
  resolve(fileId: string, anchors: Anchors): Promise<ResolveResult>;
  edit(req: EditRequest): Promise<EditResult>;
  /** Write buffered events and the snapshot of these documents to the database. */
  flush(fileIds: string[]): Promise<void>;
}

const unavailable = () => new HttpError(503, "The collaboration server is not reachable right now. Try again in a moment.");

export function createCollabClient(baseUrl: string, secret: string, timeoutMs = 20_000): CollabClient {
  async function post<T>(path: string, body: unknown): Promise<T> {
    const raw = JSON.stringify(body);
    const { timestamp, signature } = signInternal(secret, raw);
    let res: Response;
    try {
      res = await fetch(new URL(path, baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-timestamp": timestamp, "x-internal-signature": signature },
        body: raw,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw unavailable();
    }
    if (!res.ok) throw res.status >= 500 ? unavailable() : new HttpError(502, "The collaboration server rejected the request");
    return (await res.json()) as T;
  }
  return {
    resolve: (fileId, anchors) => post("/internal/resolve", { fileId, anchors }),
    edit: (req) => post("/internal/edit", req),
    async flush(fileIds) {
      if (fileIds.length > 0) await post("/internal/flush", { fileIds });
    },
  };
}

/** Used when no collab server is configured: review features that touch live documents say so. */
export const noCollab: CollabClient = {
  resolve: () => Promise.reject(unavailable()),
  edit: () => Promise.reject(unavailable()),
  flush: () => Promise.reject(unavailable()),
};
