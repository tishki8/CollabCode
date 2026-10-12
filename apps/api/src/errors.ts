export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: unknown,
    /** Machine-readable reason the web UI uses to choose a message (see API_ERROR_CODES). */
    public code?: string,
  ) {
    super(message);
  }
}
export const notFound = (what = "Not found", code?: string) => new HttpError(404, what, undefined, code);
export const forbidden = (msg = "You do not have permission to do that", code?: string) =>
  new HttpError(403, msg, undefined, code);
export const conflict = (msg: string) => new HttpError(409, msg);
export const unauthorized = () => new HttpError(401, "Sign in required");
/** 410: it existed, but is no longer available (e.g. an expired link). */
export const gone = (msg: string, code?: string) => new HttpError(410, msg, undefined, code);
