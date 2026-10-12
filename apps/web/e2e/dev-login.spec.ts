import { expect, test } from "@playwright/test";

// The development login must keep working after sign-outs (it once relied on a fixed session
// row that "Sign out" deleted, leaving "Run the seed script first").

test("a demo user can sign out and sign in again", async ({ browser }) => {
  const first = await (await browser.newContext()).newPage();
  await first.goto("/api/dev-login?user=bob");
  await expect(first.getByRole("heading", { name: "My projects" })).toBeVisible();
  await first.getByRole("button", { name: "Sign out" }).click();
  await expect(first).toHaveURL("/");

  // A fresh browser (e.g. an incognito window) can sign in as Bob right away.
  const second = await (await browser.newContext()).newPage();
  const res = await second.goto("/api/dev-login?user=bob");
  expect(res?.status()).toBe(200);
  await expect(second.getByRole("heading", { name: "My projects" })).toBeVisible();
});

test("signing out in one window does not sign out the same user in another", async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await a.goto("/api/dev-login?user=alice");
  await b.goto("/api/dev-login?user=alice");
  await expect(b.getByRole("heading", { name: "My projects" })).toBeVisible();

  await a.getByRole("button", { name: "Sign out" }).click();
  await expect(a).toHaveURL("/");

  await b.reload();
  await expect(b.getByRole("heading", { name: "My projects" })).toBeVisible(); // still signed in
});

test("unknown demo users are refused", async ({ request }) => {
  const res = await request.get("/api/dev-login?user=mallory", { maxRedirects: 0 });
  expect(res.status()).toBe(400);
});
