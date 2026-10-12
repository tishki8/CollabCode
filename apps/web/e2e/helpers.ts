import { expect, type Browser, type Page } from "@playwright/test";

// Shared by the e2e specs. Every person gets their own browser CONTEXT: separate cookies and
// storage, exactly like an incognito window.

export async function signIn(browser: Browser, who: "alice" | "bob", next = "/dashboard") {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/api/dev-login?user=${who}&next=${encodeURIComponent(next)}`);
  return { context, page };
}

export async function createProject(page: Page, name: string) {
  await page.goto("/dashboard");
  await page.getByLabel("Project name").fill(name);
  await page.getByLabel("Language").selectOption("PYTHON");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

export interface LinkOptions {
  role: "edit" | "comment" | "view only";
  expires?: "1 hour" | "1 day" | "7 days" | "never";
  approval?: boolean;
}

/** Open the share panel, create a link with the given settings and return its URL. */
export async function createShareLink(page: Page, opts: LinkOptions | LinkOptions["role"]) {
  const o: LinkOptions = typeof opts === "string" ? { role: opts } : opts;
  const panel = page.getByRole("region", { name: "Sharing" });
  if ((await panel.getByTestId("share-body").count()) === 0) await panel.getByRole("button", { name: "Share project" }).click();
  await panel.getByLabel("Anyone with the link can").selectOption({ label: o.role });
  if (o.expires) await panel.getByLabel("Link expires").selectOption({ label: o.expires });
  const approval = panel.getByLabel("Require my approval to join");
  if (o.approval) await approval.check();
  else await approval.uncheck();
  await panel.getByRole("button", { name: "Create link" }).click();
  const url = await panel.locator("#share-url").inputValue();
  expect(url).toMatch(/\/join\/[A-Za-z0-9_-]{43}$/);
  return url;
}

export const connected = (page: Page) =>
  expect(page.getByTestId("sync-status")).toHaveAttribute("data-status", "connected", { timeout: 15_000 });

/**
 * The text of the open file, read straight from the Monaco model. Returns "" while Monaco is
 * still loading, so it is safe inside expect.poll() right after a navigation.
 */
export const editorText = (page: Page) =>
  page.evaluate(() => {
    const m = (window as unknown as { monaco?: { editor: { getModels(): { getValue(): string }[] } } }).monaco;
    return m?.editor.getModels()[0]?.getValue() ?? "";
  });

export async function typeInEditor(page: Page, text: string) {
  await page.locator(".monaco-editor .view-lines").first().waitFor();
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(text);
}

/** Computed label of the first remote cursor, i.e. what a human sees next to it. */
export const remoteCursorLabel = (page: Page) =>
  page.locator(".yRemoteSelectionHead").first().evaluate((el) => getComputedStyle(el, "::after").content);
