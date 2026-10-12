import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

// Requires: seeded DB (alice + bob), DEV_LOGIN=true, and the api, collab and web servers
// running (playwright.config.ts starts them if they are not already up).
//
// Each user gets their own browser CONTEXT: separate cookies and storage, exactly like
// an incognito window.

async function signIn(browser: Browser, who: "alice" | "bob", next = "/dashboard") {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/api/dev-login?user=${who}&next=${encodeURIComponent(next)}`);
  return { context, page };
}

async function createProject(page: Page, name: string) {
  await page.goto("/dashboard");
  await page.getByLabel("Project name").fill(name);
  await page.getByLabel("Language").selectOption("PYTHON");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

/** Open the share panel, create a link with the given role and return its URL. */
async function createShareLink(page: Page, role: "edit" | "view only") {
  const panel = page.getByRole("region", { name: "Sharing" });
  if ((await panel.getByTestId("share-body").count()) === 0) await panel.getByRole("button", { name: "Share" }).click();
  await panel.getByLabel("Anyone with the link can").selectOption({ label: role });
  await panel.getByRole("button", { name: "Create link" }).click();
  const url = await panel.locator("#share-url").inputValue();
  expect(url).toMatch(/\/join\/[A-Za-z0-9_-]{43}$/);
  return url;
}

const connected = (page: Page) => expect(page.getByTestId("sync-status")).toHaveAttribute("data-status", "connected", { timeout: 15_000 });

/**
 * The text of the open file, read straight from the Monaco model. Returns "" while Monaco is
 * still loading, so it is safe inside expect.poll() right after a navigation.
 */
const editorText = (page: Page) =>
  page.evaluate(() => {
    const m = (window as unknown as { monaco?: { editor: { getModels(): { getValue(): string }[] } } }).monaco;
    return m?.editor.getModels()[0]?.getValue() ?? "";
  });

async function typeInEditor(page: Page, text: string) {
  await page.locator(".monaco-editor .view-lines").first().waitFor();
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(text);
}

/** Computed label of the remote cursor, i.e. what a human sees next to it. */
const remoteCursorLabel = (page: Page) =>
  page.locator(".yRemoteSelectionHead").first().evaluate((el) => getComputedStyle(el, "::after").content);

const closeAll = async (...contexts: BrowserContext[]) => {
  for (const c of contexts) await c.close();
};

test.describe("Phase 2: real-time collaboration through a share link", () => {
  test("Alice shares an editor link; Bob joins from a separate browser and both edit live with named cursors", async ({ browser }) => {
    const alice = await signIn(browser, "alice");
    const projectName = `Live ${Date.now()}`;
    await createProject(alice.page, projectName);
    await connected(alice.page);
    await expect(alice.page.getByTestId("readonly-badge")).toHaveCount(0);

    // Alice generates an editor link.
    const joinUrl = await createShareLink(alice.page, "edit");

    // Bob (a fresh browser context = incognito) opens the link while signed out. He is sent
    // to sign in, and straight back to the link afterwards.
    const bobContext = await browser.newContext();
    const bobPage = await bobContext.newPage();
    await bobPage.goto(joinUrl);
    await expect(bobPage).toHaveURL(/callbackUrl=/);
    await bobPage.getByRole("link", { name: "Sign in as bob" }).click();

    // He lands in the project as an editor, on the same file.
    await expect(bobPage.getByRole("heading", { name: projectName })).toBeVisible();
    await expect(bobPage.getByText("you are editor")).toBeVisible();
    await connected(bobPage);
    await expect(bobPage.getByTestId("readonly-badge")).toHaveCount(0);

    // Presence: both people, with the file they are viewing, on both screens.
    for (const page of [alice.page, bobPage]) {
      const people = page.getByTestId("presence-person");
      await expect(people).toHaveCount(2);
      await expect(people.filter({ hasText: "Alice Demo" })).toContainText("main.py");
      await expect(people.filter({ hasText: "Bob Demo" })).toContainText("main.py");
    }
    await expect(alice.page.getByTestId("presence-person").filter({ hasText: "Alice Demo" })).toContainText("(you)");

    // Alice types; Bob sees it appear without reloading.
    await typeInEditor(alice.page, "# alice was here");
    await expect.poll(() => editorText(bobPage), { timeout: 10_000 }).toContain("# alice was here");

    // Bob types on a new line; Alice sees it.
    await typeInEditor(bobPage, "\n# bob was here");
    await expect.poll(() => editorText(alice.page), { timeout: 10_000 }).toContain("# bob was here");
    expect(await editorText(alice.page)).toBe(await editorText(bobPage)); // identical documents

    // Named cursors: each side sees the other's cursor labelled with initials + name.
    await expect(bobPage.locator(".yRemoteSelectionHead").first()).toBeAttached();
    await expect(alice.page.locator(".yRemoteSelectionHead").first()).toBeAttached();
    await expect.poll(() => remoteCursorLabel(bobPage)).toBe('"AD Alice Demo"');
    await expect.poll(() => remoteCursorLabel(alice.page)).toBe('"BD Bob Demo"');
    await expect(alice.page.getByTestId("remote-count")).toHaveText("1 other here");

    // Reload: the content is still there (it lives on the server, not in one browser).
    await alice.page.reload();
    await connected(alice.page);
    await expect.poll(() => editorText(alice.page)).toContain("# bob was here");

    await closeAll(alice.context, bobContext);
  });

  test("a viewer link lets Bob read live but not edit; the owner can revoke links", async ({ browser }) => {
    const alice = await signIn(browser, "alice");
    const projectName = `ReadOnly ${Date.now()}`;
    await createProject(alice.page, projectName);
    await connected(alice.page);
    await typeInEditor(alice.page, "# only the owner can change this");

    // A link that is revoked before anyone uses it stops working.
    const revokedUrl = await createShareLink(alice.page, "view only");
    const revokeButtons = alice.page.getByTestId("link-list").getByRole("button", { name: /Revoke viewer link/ });
    await revokeButtons.first().click();
    await expect(alice.page.getByText("No active links.")).toBeVisible();

    const bob = await signIn(browser, "bob");
    await bob.page.goto(revokedUrl);
    await expect(bob.page.locator("p[role=alert]")).toContainText("invalid or has been revoked");
    await bob.page.goto("/dashboard");
    await expect(bob.page.getByRole("link", { name: new RegExp(projectName) })).toHaveCount(0); // joined nothing

    // A fresh viewer link works.
    const viewerUrl = await createShareLink(alice.page, "view only");
    await bob.page.goto(viewerUrl);
    await expect(bob.page.getByRole("heading", { name: projectName })).toBeVisible();
    await expect(bob.page.getByText("you are viewer")).toBeVisible();
    await connected(bob.page);

    // Bob sees Alice's text live, is told he is read-only, and has no sharing or file controls.
    await expect.poll(() => editorText(bob.page)).toContain("# only the owner can change this");
    await expect(bob.page.getByTestId("readonly-badge")).toContainText("Read-only (viewer)");
    await expect(bob.page.getByRole("region", { name: "Sharing" })).toHaveCount(0);
    await expect(bob.page.getByRole("button", { name: "New file" })).toHaveCount(0);

    // Bob tries to type anyway: nothing changes, for him or for Alice.
    await bob.page.locator(".monaco-editor .view-lines").first().click();
    await bob.page.keyboard.press("Control+End");
    await bob.page.keyboard.type("VIEWER_WAS_HERE");
    await bob.page.waitForTimeout(1000);
    expect(await editorText(bob.page)).not.toContain("VIEWER_WAS_HERE");
    expect(await editorText(alice.page)).not.toContain("VIEWER_WAS_HERE");

    // Alice keeps typing; Bob still receives live updates as a viewer.
    await typeInEditor(alice.page, "\n# update 2");
    await expect.poll(() => editorText(bob.page), { timeout: 10_000 }).toContain("# update 2");

    // The API refuses a viewer who tries to bypass the UI: the project's share links are owner-only.
    const projectId = new URL(bob.page.url()).pathname.split("/")[2];
    const res = await bob.page.request.post(`/api/v1/projects/${projectId}/share-links`, {
      data: { role: "EDITOR" },
      headers: { origin: new URL(bob.page.url()).origin },
    });
    expect(res.status()).toBe(403);

    await closeAll(alice.context, bob.context);
  });
});
