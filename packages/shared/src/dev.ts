// Fixed session tokens for the seeded demo users. Used by the seed script and by the
// web app's dev-login route (only enabled when DEV_LOGIN=true). Not secret, not for production.
export const DEV_SESSION_TOKENS: Record<string, string> = {
  alice: "dev-session-token-alice",
  bob: "dev-session-token-bob",
};
