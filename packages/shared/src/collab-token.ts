// Short-lived token the API hands to a signed-in browser so it can open a WebSocket to the
// collab server. It proves identity only (the subject is a user id); the collab server
// looks up the user's role in the database itself. Kept out of the main index so browser
// bundles don't pull in jose.
import { SignJWT, jwtVerify } from "jose";

export const COLLAB_TOKEN_ISSUER = "collabcode-api";
export const COLLAB_TOKEN_AUDIENCE = "collab";
export const COLLAB_TOKEN_TTL_SECONDS = 10 * 60;

const key = (secret: string) => new TextEncoder().encode(secret);

export async function signCollabToken(userId: string, secret: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer(COLLAB_TOKEN_ISSUER)
    .setAudience(COLLAB_TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${COLLAB_TOKEN_TTL_SECONDS}s`)
    .sign(key(secret));
}

/** Returns the user id, or throws if the token is invalid, expired or not meant for us. */
export async function verifyCollabToken(token: string, secret: string): Promise<string> {
  const { payload } = await jwtVerify(token, key(secret), {
    algorithms: ["HS256"],
    issuer: COLLAB_TOKEN_ISSUER,
    audience: COLLAB_TOKEN_AUDIENCE,
  });
  if (typeof payload.sub !== "string" || !payload.sub) throw new Error("Token has no subject");
  return payload.sub;
}
