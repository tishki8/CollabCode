import { expect, test, type Page } from "@playwright/test";
import { connected, createProject, createShareLink, editorText, signIn, typeInEditor } from "./helpers";

// Authorship: who wrote which line. Needs the same setup as the other specs. Batches are written
// 1.5-5 s after typing and other people's text reaches the blame view on the next 3 s poll, so
// assertions about "someone else's" text allow for that.

const SLOW = { timeout: 25_000 };

/** Hover the text of the line that contains `text` and return what the hover card says. */
async function hoverCard(page: Page, text: string) {
  await page.mouse.move(2, 2); // leave any previous hover
  await page.locator(".monaco-editor .view-line", { hasText: text }).first().hover({ position: { x: 24, y: 8 }, timeout: 4000 }); // short: a missing line must fail fast inside toPass
  return page.locator(".monaco-hover:visible .monaco-hover-content").first();
}

/** Move the pointer off the editor, like a person heading for a tab (the hover card is sticky and covers the tab bar). */
const leaveEditor = (page: Page) => page.mouse.move(120, 450);

/** What the gutter shows next to each line (the initials come from a CSS ::before). */
const gutterLabels = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".monaco-editor .cc-g")].map((el) => getComputedStyle(el, "::before").content).sort(),
  );

async function aliceAndBob(browser: Parameters<typeof signIn>[0], name: string) {
  const alice = await signIn(browser, "alice");
  await createProject(alice.page, name);
  await connected(alice.page);
  const joinUrl = await createShareLink(alice.page, "edit");
  const bob = await signIn(browser, "bob", new URL(joinUrl).pathname);
  await expect(bob.page.getByText("you are editor")).toBeVisible({ timeout: 15_000 });
  await connected(bob.page);
  return { alice, bob };
}

test.describe("Phase 4: authorship", () => {
  test("Alice and Bob type on different lines and the blame view names the right author for each", async ({ browser }) => {
    const { alice, bob } = await aliceAndBob(browser, `Blame ${Date.now()}`);

    await typeInEditor(alice.page, "# written by alice\n");
    await expect.poll(() => editorText(bob.page)).toContain("# written by alice");
    await typeInEditor(bob.page, "# written by bob");
    await expect.poll(() => editorText(alice.page)).toContain("# written by bob");

    // On Alice's screen: her own line is hers straight away; Bob's is credited to Bob once his batch is saved.
    await expect(await hoverCard(alice.page, "written by alice")).toContainText("Alice Demo");
    await expect(await hoverCard(alice.page, "written by alice")).toContainText("wrote this line");
    await expect(async () => {
      await expect(await hoverCard(alice.page, "written by bob")).toContainText("Bob Demo");
    }).toPass(SLOW);
    // ...and never the other way round
    await expect(await hoverCard(alice.page, "written by bob")).not.toContainText("Alice Demo");

    // Same on Bob's screen, from his point of view.
    await expect(async () => {
      await expect(await hoverCard(bob.page, "written by alice")).toContainText("Alice Demo");
    }).toPass(SLOW);
    await expect(await hoverCard(bob.page, "written by bob")).toContainText("Bob Demo");

    // Contribution colours: legend with initials and names, gutter initials per line, tinted text.
    await alice.page.getByTestId("toggle-colours").click();
    const legend = alice.page.getByTestId("author-legend");
    await expect(legend.getByTestId("legend-item")).toHaveCount(2);
    await expect(legend.getByTestId("legend-item").nth(0)).toContainText("AD");
    await expect(legend.getByTestId("legend-item").nth(0)).toContainText("Alice Demo");
    await expect(legend.getByTestId("legend-item").nth(1)).toContainText("BD");
    await expect(legend.getByTestId("legend-item").nth(1)).toContainText("Bob Demo");
    await expect.poll(() => gutterLabels(alice.page)).toEqual(['"AD"', '"BD"']);
    expect(await alice.page.locator(".monaco-editor .cc-a-0").count()).toBeGreaterThan(0);
    expect(await alice.page.locator(".monaco-editor .cc-a-1").count()).toBeGreaterThan(0);
    await alice.page.getByTestId("toggle-colours").click(); // and it can be switched off again
    await expect(legend).toHaveCount(0);
    await expect.poll(() => gutterLabels(alice.page)).toEqual([]);

    // History: filter to Bob and see exactly what he changed.
    await leaveEditor(alice.page);
    await alice.page.getByTestId("tab-history").click();
    const history = alice.page.getByTestId("history-panel");
    await expect(history.getByTestId("history-event")).toHaveCount(2, SLOW);
    await history.getByTestId("history-person").selectOption({ label: "Bob Demo" });
    await expect(history.getByTestId("history-event")).toHaveCount(1);
    await expect(history.getByTestId("history-event").first().getByTestId("person-chip")).toContainText("Bob Demo");
    await history.getByTestId("history-show-diff").click();
    const diff = history.getByTestId("history-diff");
    await expect(diff.getByTestId("hunk-add")).toHaveCount(1);
    await expect(diff.getByTestId("hunk-add")).toContainText("# written by bob");
    await expect(diff).not.toContainText("written by alice");
    await expect(diff.getByTestId("hunk-add")).toContainText("L2"); // Bob's line is line 2
    await expect(diff.getByTestId("hunk-add").locator(".sr-only")).toContainText("Added at line 2");

    // Contributions: one card and one lane per person, in the order they started (no ranking).
    await alice.page.waitForTimeout(4000); // let the saved snapshot catch up for "lines still theirs"
    await alice.page.getByTestId("tab-contributions").click();
    const contrib = alice.page.getByTestId("contributions-panel");
    const cards = contrib.getByTestId("contrib-card");
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toContainText("Alice Demo");
    await expect(cards.nth(1)).toContainText("Bob Demo");
    await expect(cards.nth(0).getByTestId("c-lines")).toHaveText("+1 / −0"); // alice pressed Enter once
    await expect(cards.nth(0).getByTestId("c-surviving")).toHaveText("1");
    await expect(cards.nth(1).getByTestId("c-surviving")).toHaveText("1");
    await expect(contrib.getByTestId("contrib-lane")).toHaveCount(2);

    await alice.context.close();
    await bob.context.close();
  });

  test("a guest's text is credited to the guest by name, marked as a guest", async ({ browser }) => {
    const alice = await signIn(browser, "alice");
    await createProject(alice.page, `Guest blame ${Date.now()}`);
    await connected(alice.page);
    const joinUrl = await createShareLink(alice.page, "edit");

    const guestContext = await browser.newContext();
    const gina = await guestContext.newPage();
    await gina.goto(joinUrl);
    await gina.getByLabel("Your display name").fill("Gina Guest");
    await gina.getByRole("button", { name: "Continue as guest" }).click();
    await connected(gina);

    await typeInEditor(gina, "# typed by a guest");
    await expect.poll(() => editorText(alice.page)).toContain("typed by a guest");
    await expect(async () => {
      const card = await hoverCard(alice.page, "typed by a guest");
      await expect(card).toContainText("Gina Guest");
      await expect(card).toContainText("(guest)");
    }).toPass(SLOW);

    await alice.context.close();
    await guestContext.close();
  });

  test("undo and redo in the browser: undone text has no author, restored text is credited to the person who restored it", async ({ browser }) => {
    const { alice, bob } = await aliceAndBob(browser, `Undo ${Date.now()}`);
    await typeInEditor(alice.page, "# undo me");
    await expect.poll(() => editorText(bob.page)).toContain("# undo me");

    await alice.page.keyboard.press("Control+z");
    await expect.poll(() => editorText(bob.page), SLOW).not.toContain("undo me"); // removed for everyone
    await alice.page.keyboard.press("Control+Shift+z");
    await expect.poll(() => editorText(bob.page), SLOW).toContain("# undo me"); // and back

    // The restored text is new text typed (re-inserted) by Alice, so Alice is credited.
    await expect(async () => {
      await expect(await hoverCard(bob.page, "undo me")).toContainText("Alice Demo");
    }).toPass(SLOW);

    await alice.context.close();
    await bob.context.close();
  });

  test("a viewer can see who wrote what but cannot change anything", async ({ browser }) => {
    const alice = await signIn(browser, "alice");
    await createProject(alice.page, `Viewer blame ${Date.now()}`);
    await connected(alice.page);
    await typeInEditor(alice.page, "# alice only");
    const joinUrl = await createShareLink(alice.page, "view only");

    const bob = await signIn(browser, "bob", new URL(joinUrl).pathname);
    await expect(bob.page.getByText("you are viewer")).toBeVisible({ timeout: 15_000 });
    await connected(bob.page);
    await expect.poll(() => editorText(bob.page)).toContain("# alice only");
    await expect(async () => {
      await expect(await hoverCard(bob.page, "alice only")).toContainText("Alice Demo");
    }).toPass(SLOW);
    await leaveEditor(bob.page);
    await bob.page.getByTestId("tab-history").click();
    await expect(bob.page.getByTestId("history-event")).toHaveCount(1, SLOW);

    await alice.context.close();
    await bob.context.close();
  });
});
