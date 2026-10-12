export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export const notFound = (what = "Not found") => new HttpError(404, what);
export const forbidden = (msg = "You do not have permission to do that") => new HttpError(403, msg);
export const conflict = (msg: string) => new HttpError(409, msg);
export const unauthorized = () => new HttpError(401, "Sign in required");
