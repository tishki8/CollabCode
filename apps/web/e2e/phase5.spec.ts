import { expect, test, type Browser, type Page } from "@playwright/test";
import { connected, createProject, createShareLink, editorText, signIn, typeInEditor } from "./helpers";

// Review tools: suggestions, inline comments, checkpoints and replay. Other people's suggestions and
// comments reach a page on its next poll (2.5 s) and history events are written 1.5-5 s after typing,
// so assertions about "someone else's" data wait for them with the SLOW timeout.

const SLOW = { timeout: 25_000 };

/** The little of Monaco's API these tests touch (it lives on window.monaco). */
interface MonacoLike {
  editor: {
    getEditors(): {
      getModel(): { findMatches(text: string, ...rest: unknown[]): { range: unknown }[] };
      setSelection(range: unknown): void;
      executeEdits(source: string, edits: { range: unknown; text: string }[]): void;
    }[];
  };
}

/** Alice owns a fresh project; Bob joins through a link with the given role. */
async function aliceAndBob(browser: Browser, name: string, link: "edit" | "comment") {
  const alice = await signIn(browser, "alice");
  await createProject(alice.page, name);
  await connected(alice.page);
  const joinUrl = await createShareLink(alice.page, link);
  const bob = await signIn(browser, "bob", new URL(joinUrl).pathname);
  await expect(bob.page.getByText(link === "comment" ? "you are commenter" : "you are editor")).toBeVisible({ timeout: 15_000 });
  await connected(bob.page);
  return { alice, bob };
}

/** Select the first occurrence of `needle` in the editor (what dragging the mouse over it would do). */
async function selectText(page: Page, needle: string) {
  await page.evaluate((text) => {
    const ed = (window as unknown as { monaco: MonacoLike }).monaco.editor.getEditors()[0]!;
    const [match] = ed.getModel().findMatches(text, false, false, true, null, false);
    if (!match) throw new Error(`"${text}" is not in the editor`);
    ed.setSelection(match.range);
  }, needle);
  await expect(page.getByTestId("selection-box")).toContainText(needle.slice(0, 20));
}

/**
 * Wait until the SERVER has recorded at least `chars` typed characters of the first file. A checkpoint
 * snapshots what the server has received, so a test that creates one right after typing must wait for
 * the keystrokes to arrive (on a slow CI machine they can still be in flight when the click happens).
 */
async function serverHasTyped(page: Page, chars: number) {
  const projectId = new URL(page.url()).pathname.split("/")[2];
  await expect
    .poll(async () => {
      const files = await (await page.request.get(`/api/v1/projects/${projectId}/files`)).json();
      const res = await (await page.request.get(`/api/v1/files/${files[0].id}/events?limit=200`)).json();
      return (res.events as { added: number }[]).reduce((n, e) => n + e.added, 0);
    }, { timeout: 25_000 })
    .toBeGreaterThanOrEqual(chars);
}

const sidebar = (page: Page) => page.getByTestId("review-sidebar");

test.describe("Phase 5: suggestions", () => {
  test("Bob (commenter) suggests a change and Alice accepts it; it is credited to Bob", async ({ browser }) => {
    const { alice, bob } = await aliceAndBob(browser, `Suggest ${Date.now()}`, "comment");
    await typeInEditor(alice.page, "print('hello world')");
    await expect.poll(() => editorText(bob.page), SLOW).toContain("hello world");

    // Bob can suggest but not edit, and is not offered Accept.
    await expect(bob.page.getByTestId("readonly-badge")).toContainText("commenter");
    await selectText(bob.page, "hello world");
    await sidebar(bob.page).getByTestId("btn-suggest").click();
    await expect(sidebar(bob.page).getByTestId("draft-text")).toHaveValue("hello world"); // starts from the selected text
    await sidebar(bob.page).getByTestId("draft-text").fill("goodbye moon");
    await sidebar(bob.page).getByTestId("draft-submit").click();
    const bobItem = sidebar(bob.page).getByTestId("suggestion-item");
    await expect(bobItem).toContainText("goodbye moon");
    await expect(bobItem.getByTestId("suggestion-accept")).toHaveCount(0);
    expect(await editorText(bob.page)).toContain("hello world"); // nothing changed yet

    // Alice sees it highlighted in the text and in the sidebar, with Bob named as the author.
    const item = sidebar(alice.page).getByTestId("suggestion-item");
    await expect(item).toBeVisible(SLOW);
    await expect(item).toContainText("Bob Demo");
    await expect(item.getByTestId("suggestion-old")).toHaveText("hello world");
    await expect(item.getByTestId("suggestion-new")).toHaveText("goodbye moon");
    await expect(alice.page.locator(".monaco-editor .cc-sugg").first()).toBeVisible();
    expect(await editorText(alice.page)).toContain("hello world"); // an overlay: the text is untouched

    await item.getByTestId("suggestion-accept").click();
    await expect.poll(() => editorText(alice.page)).toBe("print('goodbye moon')");
    await expect.poll(() => editorText(bob.page), SLOW).toBe("print('goodbye moon')");
    await expect(sidebar(alice.page).getByTestId("no-suggestions")).toBeVisible();
    await expect(sidebar(bob.page).getByTestId("no-suggestions")).toBeVisible(SLOW);

    // History credits the accepted text to Bob (who suggested it), not to Alice (who clicked).
    await alice.page.getByTestId("tab-history").click();
    const event = alice.page.getByTestId("history-event").filter({ has: alice.page.getByTestId("event-origin") }).first();
    await expect(async () => {
      await alice.page.getByTestId("tab-editor").click();
      await alice.page.getByTestId("tab-history").click();
      await expect(event).toBeVisible({ timeout: 2000 });
    }).toPass(SLOW);
    await expect(event).toContainText("Bob Demo");
    await expect(event).toContainText("accepted suggestion");
    await expect(event).toContainText("+12"); // "goodbye moon"
    await expect(event).toContainText("−11"); // "hello world"

    await alice.context.close();
    await bob.context.close();
  });

  test("rejecting leaves the text alone; the author can withdraw their own; a suggestion whose text was deleted cannot be applied", async ({ browser }) => {
    const { alice, bob } = await aliceAndBob(browser, `Reject ${Date.now()}`, "comment");
    await typeInEditor(alice.page, "alpha beta gamma");
    await expect.poll(() => editorText(bob.page), SLOW).toContain("gamma");

    for (const [needle, replacement] of [["alpha", "ALPHA"], ["beta", "BETA"], ["gamma", "GAMMA"]] as const) {
      await selectText(bob.page, needle);
      await sidebar(bob.page).getByTestId("btn-suggest").click();
      await sidebar(bob.page).getByTestId("draft-text").fill(replacement);
      await sidebar(bob.page).getByTestId("draft-submit").click();
      await expect(sidebar(bob.page).getByTestId("suggestion-item").filter({ hasText: replacement })).toBeVisible();
    }
    // Bob withdraws "alpha"
    await sidebar(bob.page).getByTestId("suggestion-item").filter({ hasText: "ALPHA" }).getByTestId("suggestion-reject").click();
    await expect(sidebar(bob.page).getByTestId("suggestion-item").filter({ hasText: "ALPHA" })).toHaveCount(0);

    // Alice rejects "beta"
    const beta = sidebar(alice.page).getByTestId("suggestion-item").filter({ hasText: "BETA" });
    await expect(beta).toBeVisible(SLOW);
    await beta.getByTestId("suggestion-reject").click();
    await expect(beta).toHaveCount(0);
    expect(await editorText(alice.page)).toBe("alpha beta gamma");

    // Alice deletes "gamma" herself; its suggestion can no longer be applied.
    await alice.page.evaluate(() => {
      const ed = (window as unknown as { monaco: MonacoLike }).monaco.editor.getEditors()[0]!;
      const [match] = ed.getModel().findMatches("gamma", false, false, true, null, false);
      ed.executeEdits("test", [{ range: match!.range, text: "" }]);
    });
    await expect.poll(() => editorText(alice.page)).toBe("alpha beta ");
    const gamma = sidebar(alice.page).getByTestId("suggestion-item").filter({ hasText: "GAMMA" });
    await gamma.getByTestId("suggestion-accept").click();
    await expect(alice.page.getByTestId("review-error")).toContainText("deleted");
    expect(await editorText(alice.page)).toBe("alpha beta ");

    await alice.context.close();
    await bob.context.close();
  });
});

test.describe("Phase 5: comments", () => {
  test("a comment thread: Bob (commenter) starts it, Alice replies and resolves it, Bob sees both", async ({ browser }) => {
    const { alice, bob } = await aliceAndBob(browser, `Comments ${Date.now()}`, "comment");
    await typeInEditor(alice.page, "total = price * qty");
    await expect.poll(() => editorText(bob.page), SLOW).toContain("price * qty");

    // Bob comments on a range
    await selectText(bob.page, "price * qty");
    await sidebar(bob.page).getByTestId("btn-comment").click();
    await sidebar(bob.page).getByTestId("draft-text").fill("Should this include tax?");
    await sidebar(bob.page).getByTestId("draft-submit").click();
    await expect(sidebar(bob.page).getByTestId("thread-item")).toContainText("Should this include tax?");
    await expect(bob.page.locator(".monaco-editor .cc-thread").first()).toBeVisible();

    // Alice sees the thread, quoting the text it is attached to, and replies
    await sidebar(alice.page).getByTestId("review-tab-comments").click();
    const aliceThread = sidebar(alice.page).getByTestId("thread-item");
    await expect(aliceThread).toBeVisible(SLOW);
    await expect(aliceThread).toContainText("price * qty");
    await expect(aliceThread).toContainText("Bob Demo");
    await aliceThread.getByTestId("thread-reply-input").fill("Yes, add 20% VAT.");
    await aliceThread.getByTestId("thread-reply-send").click();
    await expect(aliceThread.getByTestId("comment-body")).toHaveText(["Should this include tax?", "Yes, add 20% VAT."]);

    // Bob receives the reply
    await sidebar(bob.page).getByTestId("review-tab-comments").click();
    const bobThread = sidebar(bob.page).getByTestId("thread-item");
    await expect(bobThread.getByTestId("comment-body")).toHaveText(["Should this include tax?", "Yes, add 20% VAT."], SLOW);
    await expect(bobThread.getByTestId("comment")).toHaveCount(2);

    // The thread stays on its text when lines are added above it
    await alice.page.getByTestId("review-tab-comments").waitFor();
    await alice.page.locator(".monaco-editor .view-lines").first().click();
    await alice.page.keyboard.press("Control+Home");
    await alice.page.keyboard.type("# header\n# more\n");
    await expect.poll(() => editorText(alice.page)).toBe("# header\n# more\ntotal = price * qty");
    await alice.page.getByTestId("review-tab-comments").click();
    await expect(aliceThread).toContainText("price * qty");
    const highlighted = await alice.page.evaluate(() => [...document.querySelectorAll(".monaco-editor .cc-thread")].map((e) => e.textContent).join(""));
    expect(highlighted.replace(/\u00a0/g, " ")).toBe("price * qty"); // Monaco renders spaces as non-breaking spaces

    // Alice resolves it: it leaves the open list on both screens and moves under "Show resolved"
    await aliceThread.getByTestId("thread-resolve").click();
    await expect(sidebar(alice.page).getByTestId("no-threads")).toBeVisible();
    await expect(sidebar(alice.page).getByTestId("review-tab-comments")).toContainText("Comments (0)");
    await expect(sidebar(bob.page).getByTestId("review-tab-comments")).toContainText("Comments (0)", SLOW);
    await alice.page.getByTestId("show-resolved").check();
    const resolved = alice.page.getByTestId("resolved-threads").getByTestId("thread-item");
    await expect(resolved).toHaveAttribute("data-resolved", "true");
    await expect(resolved).toContainText("Resolved by Alice Demo");

    // ...and Bob, who started it, can reopen it
    await bob.page.getByTestId("show-resolved").check();
    await bob.page.getByTestId("resolved-threads").getByTestId("thread-reopen").click();
    await expect(sidebar(bob.page).getByTestId("review-tab-comments")).toContainText("Comments (1)");
    await expect(sidebar(alice.page).getByTestId("review-tab-comments")).toContainText("Comments (1)", SLOW);

    await alice.context.close();
    await bob.context.close();
  });

  test("a commenter is offered Comment and Suggest but still cannot type into the file", async ({ browser }) => {
    const { alice, bob } = await aliceAndBob(browser, `CommentOnly ${Date.now()}`, "comment");
    await typeInEditor(alice.page, "x = 1");
    await expect.poll(() => editorText(bob.page), SLOW).toContain("x = 1");
    await selectText(bob.page, "x = 1");
    await expect(sidebar(bob.page).getByTestId("btn-comment")).toBeEnabled();
    await expect(sidebar(bob.page).getByTestId("btn-suggest")).toBeEnabled();
    await bob.page.locator(".monaco-editor .view-lines").first().click();
    await bob.page.keyboard.type("HACK");
    expect(await editorText(bob.page)).toBe("x = 1");
    await alice.context.close();
    await bob.context.close();
  });
});

test.describe("Phase 5: checkpoints", () => {
  test("Alice creates a checkpoint, breaks the file, and restores it; the restore is her edit and a safety checkpoint is saved", async ({ browser }) => {
    const alice = await signIn(browser, "alice");
    await createProject(alice.page, `Checkpoint ${Date.now()}`);
    await connected(alice.page);
    await typeInEditor(alice.page, "version = 1");
    await expect.poll(() => editorText(alice.page)).toBe("version = 1");
    await serverHasTyped(alice.page, "version = 1".length);

    await alice.page.getByTestId("tab-checkpoints").click();
    await expect(alice.page.getByTestId("checkpoints-empty")).toBeVisible();
    await alice.page.getByLabel("Checkpoint name").fill("First version");
    await alice.page.getByTestId("checkpoint-create").click();
    await expect(alice.page.getByTestId("checkpoint-notice")).toContainText("First version");
    await expect(alice.page.getByTestId("checkpoint-item")).toHaveCount(1);

    // break the file
    await alice.page.getByTestId("tab-editor").click();
    await typeInEditor(alice.page, "\nBROKEN = True");
    await expect.poll(() => editorText(alice.page)).toBe("version = 1\nBROKEN = True");
    await serverHasTyped(alice.page, "version = 1\nBROKEN = True".length);

    // restore the whole project (with a confirmation step)
    await alice.page.getByTestId("tab-checkpoints").click();
    await alice.page.getByTestId("checkpoint-item").filter({ hasText: "First version" }).getByTestId("restore-project").click();
    await expect(alice.page.getByTestId("restore-confirm")).toContainText("whole project");
    await alice.page.getByTestId("restore-confirm-yes").click();
    await expect(alice.page.getByTestId("checkpoint-notice")).toContainText("Restored “First version”");
    await expect(alice.page.getByTestId("checkpoint-item")).toHaveCount(2); // + the automatic safety checkpoint
    await expect(alice.page.getByTestId("checkpoint-item").filter({ hasText: "Before restoring" })).toContainText("automatic");

    await alice.page.getByTestId("tab-editor").click();
    await expect.poll(() => editorText(alice.page)).toBe("version = 1");

    // the restore is in the history, credited to Alice
    await expect(async () => {
      await alice.page.getByTestId("tab-editor").click();
      await alice.page.getByTestId("tab-history").click();
      const ev = alice.page.getByTestId("history-event").filter({ hasText: "restore" }).first();
      await expect(ev).toBeVisible({ timeout: 2000 });
      await expect(ev).toContainText("Alice Demo");
    }).toPass(SLOW);

    // undo the restore from the safety checkpoint: the broken text comes back
    await alice.page.getByTestId("tab-checkpoints").click();
    await alice.page.getByTestId("checkpoint-item").filter({ hasText: "Before restoring" }).getByTestId("restore-file").click();
    await alice.page.getByTestId("restore-confirm-yes").click();
    await expect(alice.page.getByTestId("checkpoint-notice")).toContainText("Restored");
    await alice.page.getByTestId("tab-editor").click();
    await expect.poll(() => editorText(alice.page)).toBe("version = 1\nBROKEN = True");

    await alice.context.close();
  });

  test("restoring is owner-only: an editor can create checkpoints but is not offered Restore", async ({ browser }) => {
    const { alice, bob } = await aliceAndBob(browser, `CpRoles ${Date.now()}`, "edit");
    await typeInEditor(alice.page, "a = 1");
    await bob.page.getByTestId("tab-checkpoints").click();
    await bob.page.getByLabel("Checkpoint name").fill("Bob's");
    await bob.page.getByTestId("checkpoint-create").click();
    await expect(bob.page.getByTestId("checkpoint-item")).toHaveCount(1);
    await expect(bob.page.getByTestId("restore-project")).toHaveCount(0);
    await expect(bob.page.getByText("Only the project owner can restore")).toBeVisible();
    await alice.context.close();
    await bob.context.close();
  });
});

test.describe("Phase 5: replay", () => {
  test("play, pause, speed, scrub, filter by person, and start from a checkpoint", async ({ browser }) => {
    const { alice, bob } = await aliceAndBob(browser, `Replay ${Date.now()}`, "edit");
    await typeInEditor(alice.page, "alice one\n");
    await expect.poll(() => editorText(bob.page), SLOW).toContain("alice one");
    await typeInEditor(bob.page, "bob two\n");
    await expect.poll(() => editorText(alice.page), SLOW).toContain("bob two");

    // a checkpoint in the middle, then more work after it
    await alice.page.getByTestId("tab-checkpoints").click();
    await alice.page.getByLabel("Checkpoint name").fill("Midpoint");
    await alice.page.getByTestId("checkpoint-create").click();
    await expect(alice.page.getByTestId("checkpoint-item")).toHaveCount(1);
    await alice.page.getByTestId("tab-editor").click();
    await typeInEditor(alice.page, "alice three");
    await expect.poll(() => editorText(alice.page)).toContain("alice three");

    const replay = alice.page.getByTestId("replay-panel");
    const text = replay.getByTestId("replay-text");
    // open the replay once the typed text has been written to the log
    await expect(async () => {
      await alice.page.getByTestId("tab-editor").click();
      await alice.page.getByTestId("tab-replay").click();
      await expect(replay.getByTestId("replay-scrubber")).toBeVisible({ timeout: 4000 });
      await expect(replay.getByTestId("replay-position")).toHaveText(/\/ \d+/);
      const total = Number((await replay.getByTestId("replay-position").innerText()).split("/")[1]);
      expect(total).toBeGreaterThanOrEqual(2);
      await replay.getByTestId("replay-scrubber").focus();
      await alice.page.keyboard.press("End");
      await expect(text).toContainText("alice three", { timeout: 2000 });
    }).toPass(SLOW);

    // scrubbing back to the start shows an empty file; the slider is keyboard accessible
    await replay.getByTestId("replay-scrubber").focus();
    await alice.page.keyboard.press("Home");
    await expect(replay.getByTestId("replay-position")).toHaveText(/^0 \//);
    await expect(text).not.toContainText("alice");

    // play at top speed: reaches the end by itself, then the play button is ready again
    await replay.getByTestId("replay-speed").selectOption("16");
    await replay.getByTestId("replay-play").click();
    await expect(replay.getByTestId("replay-play")).toHaveAttribute("aria-label", "Play", SLOW); // stopped by itself
    await expect(text).toContainText("alice three");
    await expect(text).toContainText("bob two");
    const pos = (await replay.getByTestId("replay-position").innerText()).split("/").map((s) => s.trim());
    expect(pos[0]).toBe(pos[1]);

    // pause works mid-way
    await replay.getByTestId("replay-speed").selectOption("0.5");
    await replay.getByTestId("replay-scrubber").focus();
    await alice.page.keyboard.press("Home");
    await replay.getByTestId("replay-play").click();
    await expect(replay.getByTestId("replay-play")).toHaveAttribute("aria-label", "Pause");
    await replay.getByTestId("replay-play").click();
    await expect(replay.getByTestId("replay-play")).toHaveAttribute("aria-label", "Play");

    // filter: step through just Bob's changes. The text shown is still complete up to his change.
    await replay.getByTestId("replay-person").selectOption({ label: "Bob Demo" });
    await expect(replay.getByTestId("replay-position")).toHaveText(/^0 \//);
    await replay.getByTestId("replay-next").click();
    await expect(replay.getByTestId("replay-caption")).toContainText("Bob Demo");
    await expect(text).toContainText("bob two");
    await expect(text).toContainText("alice one"); // Alice's earlier change was applied silently
    await expect(text).not.toContainText("alice three");

    // start from the checkpoint: far fewer changes to play, same final text
    await replay.getByTestId("replay-person").selectOption({ label: "Everyone" });
    const midpoint = await replay.getByTestId("replay-start").locator("option", { hasText: "Midpoint" }).getAttribute("value");
    await replay.getByTestId("replay-start").selectOption(midpoint!);
    await expect(replay.getByTestId("replay-loading")).toHaveCount(0);
    await expect(text).toContainText("bob two"); // the checkpoint's own text is already there at the start
    await expect(text).not.toContainText("alice three");
    await replay.getByTestId("replay-scrubber").focus();
    await alice.page.keyboard.press("End");
    await expect(text).toContainText("alice three");

    await alice.context.close();
    await bob.context.close();
  });
});

test.describe("Phase 5: who is acting", () => {
  test("Bob comments, replies and suggests from his own browser: every item names Bob, on both screens", async ({ browser }) => {
    const { alice, bob } = await aliceAndBob(browser, `Authors ${Date.now()}`, "comment");
    await typeInEditor(alice.page, "rate = 0.2");
    await expect.poll(() => editorText(bob.page), SLOW).toContain("rate");

    await selectText(bob.page, "rate");
    await sidebar(bob.page).getByTestId("btn-comment").click();
    await sidebar(bob.page).getByTestId("draft-text").fill("Bob's first comment");
    await sidebar(bob.page).getByTestId("draft-submit").click();
    const bobThread = sidebar(bob.page).getByTestId("thread-item");
    await bobThread.getByTestId("thread-reply-input").fill("Bob's reply");
    await bobThread.getByTestId("thread-reply-send").click();
    await expect(bobThread.getByTestId("comment")).toHaveCount(2);

    await selectText(bob.page, "0.2");
    await sidebar(bob.page).getByTestId("btn-suggest").click();
    await sidebar(bob.page).getByTestId("draft-text").fill("0.25");
    await sidebar(bob.page).getByTestId("draft-submit").click();
    await expect(sidebar(bob.page).getByTestId("suggestion-item")).toHaveCount(1);

    for (const page of [bob.page, alice.page]) {
      const side = sidebar(page);
      await side.getByTestId("review-tab-comments").click();
      const comments = side.getByTestId("thread-item").getByTestId("comment");
      await expect(comments).toHaveCount(2, SLOW);
      for (const c of await comments.all()) {
        await expect(c.getByTestId("person-chip")).toContainText("Bob Demo");
        await expect(c.getByTestId("person-chip")).not.toContainText("Alice");
      }
      await side.getByTestId("review-tab-suggestions").click();
      const item = side.getByTestId("suggestion-item");
      await expect(item).toBeVisible(SLOW);
      await expect(item.getByTestId("person-chip").first()).toContainText("Bob Demo");
    }

    // The data itself agrees, as seen through Alice's own session.
    const projectId = new URL(alice.page.url()).pathname.split("/")[2];
    const files = await (await alice.page.request.get(`/api/v1/projects/${projectId}/files`)).json();
    const threads = await (await alice.page.request.get(`/api/v1/files/${files[0].id}/threads`)).json();
    expect(threads[0].createdBy.name).toBe("Bob Demo");
    expect(threads[0].comments.map((c: { author: { name: string } }) => c.author.name)).toEqual(["Bob Demo", "Bob Demo"]);
    const suggestions = await (await alice.page.request.get(`/api/v1/files/${files[0].id}/suggestions`)).json();
    expect(suggestions[0].author.name).toBe("Bob Demo");

    // Alice resolves it: that is shown as HER action, not Bob's
    await alice.page.getByTestId("review-tab-comments").click();
    await alice.page.getByTestId("thread-resolve").click();
    await alice.page.getByTestId("show-resolved").check();
    await expect(alice.page.getByTestId("resolved-threads")).toContainText("Resolved by Alice Demo");

    await alice.context.close();
    await bob.context.close();
  });

  test("signing in as someone else in another tab of the same browser shows a banner, and the stale tab cannot act as the new person", async ({ browser }) => {
    const { alice, bob } = await aliceAndBob(browser, `SameBrowser ${Date.now()}`, "comment");
    await typeInEditor(alice.page, "limit = 10");
    await expect.poll(() => editorText(bob.page), SLOW).toContain("limit");
    await expect(bob.page.getByTestId("identity-banner")).toHaveCount(0);

    // Alice signs in in a second tab of BOB's browser: the one session cookie is replaced.
    const second = await bob.context.newPage();
    await second.goto("/api/dev-login?user=alice&next=/dashboard");

    // Bob's tab notices when it regains focus
    await bob.page.bringToFront();
    await bob.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const banner = bob.page.getByTestId("identity-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("You are now signed in as Alice Demo");

    // Even before the banner, acting from that tab is refused rather than done as Alice
    await selectText(bob.page, "limit");
    await sidebar(bob.page).getByTestId("btn-comment").click();
    await sidebar(bob.page).getByTestId("draft-text").fill("this must not become Alice's comment");
    await sidebar(bob.page).getByTestId("draft-submit").click();
    await expect(bob.page.getByTestId("review-error")).toContainText("signed in as Alice Demo");
    const projectId = new URL(bob.page.url()).pathname.split("/")[2];
    const files = await (await second.request.get(`/api/v1/projects/${projectId}/files`)).json();
    const threads = await (await second.request.get(`/api/v1/files/${files[0].id}/threads`)).json();
    expect(threads).toHaveLength(0);

    // Reload continues as the person who is really signed in
    await banner.getByTestId("identity-reload").click();
    await expect(bob.page.getByText("you are owner")).toBeVisible({ timeout: 15_000 });
    await expect(bob.page.getByTestId("identity-banner")).toHaveCount(0);

    await alice.context.close();
    await bob.context.close();
  });
});

test.describe("Phase 5: approving suggestions", () => {
  test("you cannot accept your own suggestion; another editor can; the sidebar names whose code it changes and highlights yours", async ({ browser }) => {
    const { alice, bob } = await aliceAndBob(browser, `FourEyes ${Date.now()}`, "edit");
    await typeInEditor(bob.page, "bob_value = 1");
    await expect.poll(() => editorText(alice.page), SLOW).toContain("bob_value");

    // Alice (the owner) suggests a change to Bob's line
    await selectText(alice.page, "bob_value");
    await sidebar(alice.page).getByTestId("btn-suggest").click();
    await sidebar(alice.page).getByTestId("draft-text").fill("renamed_value");
    await sidebar(alice.page).getByTestId("draft-submit").click();
    const mine = sidebar(alice.page).getByTestId("suggestion-item");
    await expect(mine).toBeVisible();

    // She cannot accept it, only withdraw it
    await expect(mine.getByTestId("suggestion-accept")).toHaveCount(0);
    await expect(mine.getByTestId("suggestion-reject")).toHaveText("Withdraw");
    await expect(mine.getByTestId("self-accept-note")).toContainText("Someone else has to accept");

    // Whose code is it? Bob's text is recorded once his typing batch is saved (a few seconds)
    await expect(mine.getByTestId("suggestion-target")).toContainText("Alice Demo suggested a change to Bob Demo's code", SLOW);
    await expect(mine).toHaveAttribute("data-on-my-code", "false");

    // Bob sees it highlighted as being on HIS code, and may accept it (he is an editor and not the author)
    const theirs = sidebar(bob.page).getByTestId("suggestion-item");
    await expect(theirs).toBeVisible(SLOW);
    await expect(theirs).toHaveAttribute("data-on-my-code", "true", SLOW);
    await expect(theirs.getByTestId("suggestion-on-mine")).toHaveText("On your code");
    await expect(theirs.getByTestId("suggestion-target")).toContainText("Alice Demo suggested a change to your code");
    await theirs.getByTestId("suggestion-accept").click();
    await expect.poll(() => editorText(bob.page)).toBe("renamed_value = 1");
    await expect.poll(() => editorText(alice.page), SLOW).toBe("renamed_value = 1");

    await alice.context.close();
    await bob.context.close();
  });

  test("the server refuses a self-accept even if the page is tampered with to show the button", async ({ browser }) => {
    const { alice, bob } = await aliceAndBob(browser, `SelfAccept ${Date.now()}`, "edit");
    await typeInEditor(bob.page, "x = 1");
    await expect.poll(() => editorText(alice.page), SLOW).toContain("x = 1");
    await selectText(alice.page, "x");
    await sidebar(alice.page).getByTestId("btn-suggest").click();
    await sidebar(alice.page).getByTestId("draft-text").fill("y");
    await sidebar(alice.page).getByTestId("draft-submit").click();
    await expect(sidebar(alice.page).getByTestId("suggestion-item")).toBeVisible();

    const projectId = new URL(alice.page.url()).pathname.split("/")[2];
    const files = await (await alice.page.request.get(`/api/v1/projects/${projectId}/files`)).json();
    const [s] = await (await alice.page.request.get(`/api/v1/files/${files[0].id}/suggestions`)).json();
    const res = await alice.page.request.post(`/api/v1/suggestions/${s.id}/accept`, { headers: { origin: "http://localhost:3000" } });
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe("SELF_ACCEPT");
    expect(await editorText(alice.page)).toBe("x = 1");

    await alice.context.close();
    await bob.context.close();
  });
});
