import { createHash, randomBytes } from "node:crypto";

/** 256 bits of randomness, url-safe. Used for share-link secrets and guest session cookies. */
export const newSecretToken = () => randomBytes(32).toString("base64url");

/** Only this hash is stored, so a database leak does not leak working links or sessions. */
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
