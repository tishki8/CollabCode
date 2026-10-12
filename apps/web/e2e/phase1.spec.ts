import { expect, test } from "@playwright/test";

// Requires a seeded database (pnpm db:seed) and DEV_LOGIN=true.
test("sign in, see seeded projects, create a project and manage its file tree", async ({ page }) => {
  await page.goto("/api/dev-login?user=alice");
  await expect(page.getByRole("heading", { name: "My projects" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Demo: Hello CollabCode/ })).toBeVisible();

  // Create a project (Java -> default entry file Main.java)
  const projectName = `E2E ${Date.now()}`;
  await page.getByLabel("Project name").fill(projectName);
  await page.getByLabel("Language").selectOption("JAVA");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();
  const tree = page.getByRole("navigation", { name: "File tree" });
  await expect(tree.getByRole("button", { name: /Main\.java/ })).toBeVisible();

  // New folder, then a file inside it (new items go into the selected folder)
  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByLabel("New folder name").fill("src");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(tree.getByRole("button", { name: /src/ })).toBeVisible();
  await page.getByRole("button", { name: "New file" }).click();
  await page.getByLabel("New file name").fill("Util.java");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(tree.getByRole("button", { name: /Util\.java/ })).toBeVisible();

  // Duplicate names are rejected with a visible error
  await page.getByRole("button", { name: "New file" }).click();
  await page.getByLabel("New file name").fill("Util.java");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("p[role=alert]")).toContainText("already exists");
  await page.getByRole("button", { name: "Cancel" }).click();

  // Rename and delete
  await page.getByRole("button", { name: "Rename" }).click();
  await page.getByLabel("New name").fill("Helpers.java");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(tree.getByRole("button", { name: /Helpers\.java/ })).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(tree.getByRole("button", { name: /Helpers\.java/ })).toHaveCount(0);
});

test("a project shared with me shows up under 'Shared with me' with my role", async ({ page }) => {
  await page.goto("/api/dev-login?user=bob");
  const shared = page.getByRole("region", { name: "Shared with me" });
  await expect(shared.getByRole("link", { name: /Demo: Hello CollabCode/ })).toContainText("editor");
});

test("unauthenticated visitors are sent to the landing page", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: "CollabCode" })).toBeVisible();
});
