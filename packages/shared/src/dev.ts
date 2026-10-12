// The seeded demo users, selectable through the development-only login (/api/dev-login,
// enabled only when DEV_LOGIN=true and never in production). Each dev login creates a fresh
// random session for the chosen user, so signing out in one window never affects another.
export const DEV_USER_EMAILS: Record<string, string> = {
  alice: "alice@example.com",
  bob: "bob@example.com",
};
