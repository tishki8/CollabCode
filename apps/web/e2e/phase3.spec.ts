import { expect, test, type Browser, type Page } from "@playwright/test";
import * as Y from "yjs";
import { prisma } from "@collabcode/db";
import { connected, createProject, createShareLink, editorText, remoteCursorLabel, signIn, typeInEditor } from "./helpers";

// Requires the same setup as the other specs (seeded DB, DEV_LOGIN=true, servers running).
// Guests, invite-only approval, link expiry and the commenter role, all through real browsers.

const projectIdOf = (page: Page) => new URL(page.url()).pathname.split("/")[2]!;

/** A guest opens a link in a brand-new browser context (no cookies, like an incognito window). */
async function openAsGuest(browser: Browser, joinUrl: string, name: string, button = "Continue as guest") {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(joinUrl);
  await page.getByLabel("Your display name").fill(name);
  await page.getByRole("button", { name: button }).click();
  return { context, page };
}

/** The server's copy of the document, straight from the database. */
async function storedText(projectId: string): Promise<string> {
  const file = await prisma.fileNode.findFirstOrThrow({ where: { projectId, type: "FILE", deletedAt: null } });
  const row = await prisma.docSnapshot.findUnique({ where: { fileId: file.id } });
  if (!row) return "";
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(row.state));
  return doc.getText("content").toString();
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test.describe("Phase 3: guests", () => {
  test("a guest joins from an incognito window with just a name and edits live with the owner", async ({ browser }) => {
    const alice = await signIn(browser, "alice");
    const projectName = `Guests ${Date.now()}`;
    await createProject(alice.page, projectName);
    await connected(alice.page);
    const joinUrl = await createShareLink(alice.page, "edit");

    // Opening the link with no account asks for a display name and nothing else.
    const context = await browser.newContext();
    const gina = await context.newPage();
    await gina.goto(joinUrl);
    await expect(gina.getByTestId("join-project-name")).toHaveText(projectName);
    await expect(gina.getByTestId("join-role")).toContainText("an editor");
    await expect(gina.getByLabel("Your display name")).toBeVisible();
    await expect(gina.getByLabel(/password|email/i)).toHaveCount(0);
    await gina.getByLabel("Your display name").fill("Gina   Guest"); // extra spaces are tidied
    await gina.getByRole("button", { name: "Continue as guest" }).click();

    // She lands in the project, clearly marked as a guest.
    await expect(gina.getByRole("heading", { name: projectName })).toBeVisible();
    await expect(gina.getByText("you are editor")).toBeVisible();
    await expect(gina.getByTestId("header-user")).toContainText("Gina Guest");
    await expect(gina.getByTestId("header-user")).toContainText("guest");
    await connected(gina);
    await expect(gina.getByTestId("readonly-badge")).toHaveCount(0);

    // In presence on the owner's screen, with her name and a guest tag.
    const presence = alice.page.getByTestId("presence-person").filter({ hasText: "Gina Guest" });
    await expect(presence).toHaveCount(1);
    await expect(presence.getByTestId("guest-tag")).toBeVisible();
    await expect(presence).toContainText("main.py");

    // Live editing both ways, with named cursors that say "guest".
    await typeInEditor(alice.page, "# alice");
    await expect.poll(() => editorText(gina)).toContain("# alice");
    await typeInEditor(gina, "\n# gina");
    await expect.poll(() => editorText(alice.page), { timeout: 10_000 }).toContain("# gina");
    await expect.poll(() => remoteCursorLabel(alice.page)).toBe('"GG Gina Guest (guest)"');
    await expect.poll(() => remoteCursorLabel(gina)).toBe('"AD Alice Demo"');

    // A guest can see the project but cannot create projects of her own.
    await gina.goto("/dashboard");
    await expect(gina.getByText("You are a guest")).toBeVisible();
    await expect(gina.getByLabel("Project name")).toHaveCount(0);
    await expect(gina.getByRole("link", { name: new RegExp(projectName) })).toBeVisible();

    // Her identity survives a reload (it lives in a cookie)...
    await gina.goto(`/p/${projectIdOf(alice.page)}`);
    await expect(gina.getByRole("heading", { name: projectName })).toBeVisible();

    // ...until she leaves, after which the project is closed to her again.
    await gina.getByRole("button", { name: "Leave" }).click();
    await expect(gina).toHaveURL("/");
    await gina.goto(`/p/${projectIdOf(alice.page)}`);
    await expect(gina).toHaveURL("/");

    await alice.context.close();
    await context.close();
  });

  for (const [linkRole, label] of [
    ["view only", "viewer"],
    ["comment", "commenter"],
  ] as const) {
    test(`a ${label} guest is read-only, even after tampering with the page to unlock the editor`, async ({ browser }) => {
      const alice = await signIn(browser, "alice");
      await createProject(alice.page, `Tamper ${label} ${Date.now()}`);
      await connected(alice.page);
      await typeInEditor(alice.page, "# protected");
      const projectId = projectIdOf(alice.page);
      const joinUrl = await createShareLink(alice.page, linkRole);

      const guest = await openAsGuest(browser, joinUrl, `Mallory ${label}`);
      await expect(guest.page.getByText(`you are ${label}`)).toBeVisible();
      await connected(guest.page);
      await expect(guest.page.getByTestId("readonly-badge")).toContainText(`Read-only (${label})`);
      await expect.poll(() => editorText(guest.page)).toContain("# protected"); // can read live

      // The honest UI refuses typing...
      await guest.page.locator(".monaco-editor .view-lines").first().click();
      await guest.page.keyboard.type("HONEST");
      expect(await editorText(guest.page)).not.toContain("HONEST");

      // ...so the "attacker" unlocks Monaco from the browser console and types anyway.
      await guest.page.evaluate(() => {
        const m = (window as unknown as { monaco: { editor: { getEditors(): { updateOptions(o: object): void }[] } } }).monaco;
        m.editor.getEditors()[0]!.updateOptions({ readOnly: false, domReadOnly: false });
      });
      await guest.page.locator(".monaco-editor .view-lines").first().click();
      await guest.page.keyboard.press("Control+End");
      await guest.page.keyboard.type("TAMPERED");
      // Control: the tampering worked on the attacker's own screen (so the server is what stops it).
      await expect.poll(() => editorText(guest.page)).toContain("TAMPERED");

      // Nobody else ever sees it, and it is never stored.
      await guest.page.waitForTimeout(1500);
      expect(await editorText(alice.page)).not.toContain("TAMPERED");
      await expect.poll(() => storedText(projectId), { timeout: 10_000 }).toContain("# protected");
      expect(await storedText(projectId)).not.toContain("TAMPERED");

      // A fresh load shows the server's real copy: the tampering is gone.
      await guest.page.reload();
      await connected(guest.page);
      await expect.poll(() => editorText(guest.page)).toContain("# protected");
      expect(await editorText(guest.page)).not.toContain("TAMPERED");

      await alice.context.close();
      await guest.context.close();
    });
  }
});

test.describe("Phase 3: invite-only links", () => {
  test("the owner approves one person and rejects another", async ({ browser }) => {
    const alice = await signIn(browser, "alice");
    const projectName = `Approval ${Date.now()}`;
    await createProject(alice.page, projectName);
    await connected(alice.page);
    const joinUrl = await createShareLink(alice.page, { role: "edit", expires: "1 day", approval: true });
    await expect(alice.page.getByTestId("created-link")).toContainText("needs your approval");

    // Bob (signed in) opens it and has to wait.
    const bobContext = await browser.newContext();
    const bobPage = await bobContext.newPage();
    await bobPage.goto(joinUrl);
    await expect(bobPage.getByTestId("join-approval-note")).toBeVisible();
    await bobPage.getByRole("link", { name: "Sign in instead" }).click();
    await bobPage.getByRole("link", { name: "Sign in as bob" }).click();
    await expect(bobPage.getByTestId("join-pending")).toContainText("Waiting for Alice Demo");

    // So does a guest, who is asking without an account.
    const pat = await openAsGuest(browser, joinUrl, "Pat Pending", "Ask to join as guest");
    await expect(pat.page.getByTestId("join-pending")).toBeVisible();

    // Neither of them can see the project yet.
    const projectId = projectIdOf(alice.page);
    expect((await pat.page.request.get(`/api/v1/projects/${projectId}`)).status()).toBe(404);

    // The owner is told, and sees who is asking and which role they would get.
    await expect(alice.page.getByTestId("pending-badge")).toHaveText("2 waiting", { timeout: 20_000 });
    const requests = alice.page.getByTestId("join-requests");
    await expect(requests.getByTestId("join-request")).toHaveCount(2);
    await expect(requests.getByTestId("join-request").filter({ hasText: "Bob Demo" })).toContainText("join as editor");
    await expect(requests.getByTestId("join-request").filter({ hasText: "Pat Pending" })).toContainText("guest");

    await alice.page.getByRole("button", { name: "Approve Bob Demo" }).click();
    await alice.page.getByRole("button", { name: "Reject Pat Pending" }).click();
    await expect(alice.page.getByTestId("pending-badge")).toHaveCount(0);

    // Bob is let in automatically, as an editor, and shows up in presence.
    await expect(bobPage.getByRole("heading", { name: projectName })).toBeVisible({ timeout: 15_000 });
    await expect(bobPage.getByText("you are editor")).toBeVisible();
    await connected(bobPage);
    await expect(alice.page.getByTestId("presence-person").filter({ hasText: "Bob Demo" })).toHaveCount(1);

    // Pat is told no, and stays out, including on a revisit.
    await expect(pat.page.getByTestId("join-error")).toContainText("declined", { timeout: 15_000 });
    expect((await pat.page.request.get(`/api/v1/projects/${projectId}`)).status()).toBe(404);
    await pat.page.goto(joinUrl);
    await expect(pat.page.getByTestId("join-error")).toContainText("declined");

    await alice.context.close();
    await bobContext.close();
    await pat.context.close();
  });

  test("a guest who is approved joins with the link's role under the same identity", async ({ browser }) => {
    const alice = await signIn(browser, "alice");
    await createProject(alice.page, `Approve guest ${Date.now()}`);
    await connected(alice.page);
    const joinUrl = await createShareLink(alice.page, { role: "comment", approval: true });

    const guest = await openAsGuest(browser, joinUrl, "Quinn Waiting", "Ask to join as guest");
    await expect(guest.page.getByTestId("join-pending")).toBeVisible();
    await expect(alice.page.getByTestId("pending-badge")).toBeVisible({ timeout: 20_000 });
    await alice.page.getByRole("button", { name: "Approve Quinn Waiting" }).click();

    await expect(guest.page.getByText("you are commenter")).toBeVisible({ timeout: 15_000 });
    await expect(guest.page.getByTestId("header-user")).toContainText("Quinn Waiting");
    await connected(guest.page);
    await expect(guest.page.getByTestId("readonly-badge")).toContainText("Read-only (commenter)");

    await alice.context.close();
    await guest.context.close();
  });
});

test.describe("Phase 3: link expiry", () => {
  test("an expired link shows a clear message to everyone, and the owner can see it expired", async ({ browser }) => {
    const alice = await signIn(browser, "alice");
    await createProject(alice.page, `Expiry ${Date.now()}`);
    await connected(alice.page);
    const projectId = projectIdOf(alice.page);

    // The owner picks the lifetime; the choices include "never".
    const panel = alice.page.getByRole("region", { name: "Sharing" });
    await panel.getByRole("button", { name: "Share project" }).click();
    await expect(panel.getByLabel("Link expires").locator("option")).toHaveText(["1 hour", "1 day", "7 days", "never"]);
    const url = await createShareLink(alice.page, { role: "view only", expires: "1 hour" });
    await expect(alice.page.getByTestId("created-link")).toContainText("expires in 1 h");
    await expect(alice.page.getByTestId("link-row").first()).toContainText("expires in 1 h");

    // While valid, it works: a visitor sees what they would join.
    const early = await browser.newContext();
    const earlyPage = await early.newPage();
    await earlyPage.goto(url);
    await expect(earlyPage.getByLabel("Your display name")).toBeVisible();
    await early.close();

    // Time passes (we move the deadline into the past in the database).
    const link = await prisma.shareLink.findFirstOrThrow({ where: { projectId }, orderBy: { createdAt: "desc" } });
    await prisma.shareLink.update({ where: { id: link.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });

    // A visitor without an account gets a clear message, not a name form.
    const visitor = await browser.newContext();
    const visitorPage = await visitor.newPage();
    await visitorPage.goto(url);
    await expect(visitorPage.getByTestId("join-title")).toHaveText("This link has expired");
    await expect(visitorPage.getByTestId("join-message")).toContainText("Ask the project owner");
    await expect(visitorPage.getByLabel("Your display name")).toHaveCount(0);
    await visitor.close();

    // So does a signed-in user.
    const bob = await signIn(browser, "bob");
    await bob.page.goto(url);
    await expect(bob.page.getByTestId("join-title")).toHaveText("This link has expired");
    await bob.page.goto("/dashboard");
    await expect(bob.page.getByRole("link", { name: /Expiry/ })).toHaveCount(0); // nothing was joined
    await bob.context.close();

    // The owner still sees it, flagged, so it can be cleaned up.
    await alice.page.reload();
    await alice.page.getByRole("button", { name: "Share project" }).click();
    await expect(alice.page.getByTestId("link-row").first()).toContainText("expired");
    await alice.context.close();
  });
});

test.describe("Phase 3: commenter role", () => {
  test("a signed-in user joining through a commenter link can view but not edit", async ({ browser }) => {
    const alice = await signIn(browser, "alice");
    await createProject(alice.page, `Commenter ${Date.now()}`);
    await connected(alice.page);
    await typeInEditor(alice.page, "# visible to commenters");
    const joinUrl = await createShareLink(alice.page, "comment");

    const bob = await signIn(browser, "bob", new URL(joinUrl).pathname);
    await expect(bob.page.getByText("you are commenter")).toBeVisible({ timeout: 15_000 });
    await connected(bob.page);
    await expect(bob.page.getByTestId("readonly-badge")).toContainText("Read-only (commenter)");
    await expect.poll(() => editorText(bob.page)).toContain("# visible to commenters");
    await expect(bob.page.getByRole("region", { name: "Sharing" })).toHaveCount(0);
    await expect(bob.page.getByRole("button", { name: "New file" })).toHaveCount(0);

    await alice.context.close();
    await bob.context.close();
  });
});
