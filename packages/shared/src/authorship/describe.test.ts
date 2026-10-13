import { describe, expect, it } from "vitest";
import { describeLine, escapeMarkdown, formatAgo, lineHoverMarkdown } from "./describe";
import type { LineAuthor, LineBlame } from "./blame";

const people: Record<string, { name: string; isGuest: boolean }> = {
  a: { name: "Alice Demo", isGuest: false },
  b: { name: "Bob Demo", isGuest: false },
  g: { name: "Gina Guest", isGuest: true },
};
const personOf = (id: string) => people[id];
const abs = (ms: number) => `@${ms}`;
const NOW = 1_000_000_000_000;
const author = (user: string | null, chars: number, lastAt: number | null = NOW - 5 * 60_000) => ({ user, chars, lastAt });
const line = (authors: ReturnType<typeof author>[]): LineBlame => ({ line: 1, authors, main: authors[0] ?? null, others: Math.max(0, authors.length - 1) });

describe("formatAgo", () => {
  it.each([
    [10_000, "just now"],
    [5 * 60_000, "5 min ago"],
    [3 * 3_600_000, "3 h ago"],
    [5 * 86_400_000, "5 days ago"],
  ])("%i ms ago -> %s", (ago, text) => expect(formatAgo(NOW - ago, NOW)).toBe(text));
  it("never goes negative for clocks slightly ahead", () => expect(formatAgo(NOW + 5_000, NOW)).toBe("just now"));
});

describe("lineHoverMarkdown", () => {
  it("names the author and when", () => {
    expect(lineHoverMarkdown(line([author("a", 10)]), personOf, NOW, abs)).toBe(`**Alice Demo** wrote this line\n\n5 min ago (@${NOW - 300_000})`);
  });

  it("shows the main author plus 'and N others'", () => {
    const md = lineHoverMarkdown(line([author("a", 10), author("b", 3)]), personOf, NOW, abs)!;
    expect(md).toContain("**Alice Demo**");
    expect(md).toContain("and 1 other: Bob Demo");
    const two = lineHoverMarkdown(line([author("a", 10), author("b", 3), author("g", 1)]), personOf, NOW, abs)!;
    expect(two).toContain("and 2 others: Bob Demo, Gina Guest");
  });

  it("collapses a long list of other authors", () => {
    const many = line([author("a", 9), ...["b", "g", "b", "g", "b"].map((u, i) => author(u + i, 1))]);
    const md = lineHoverMarkdown(many, (id) => (id.length > 1 ? { name: `User ${id}`, isGuest: false } : people[id]), NOW, abs)!;
    expect(md).toMatch(/and 5 others: .*, .*, .* and 2 more/);
  });

  it("marks guests", () => {
    expect(lineHoverMarkdown(line([author("g", 4)]), personOf, NOW, abs)).toContain("**Gina Guest** (guest)");
  });

  it("is honest about unknown authors instead of guessing", () => {
    const md = lineHoverMarkdown(line([author(null, 8, null)]), personOf, NOW, abs)!;
    expect(md).toBe("Author unknown: written before authorship tracking");
  });

  it("tolerates a user that is no longer known", () => {
    expect(lineHoverMarkdown(line([author("zzz", 4)]), personOf, NOW, abs)).toContain("Unknown user");
  });

  it("returns nothing for lines without characters", () => {
    expect(lineHoverMarkdown(line([]), personOf, NOW, abs)).toBeNull();
  });

  it("cannot be hijacked by a hostile display name (markdown/HTML are shown literally)", () => {
    const evil = { name: "**x** [click](javascript:alert(1)) <img src=x onerror=alert(1)> `code`", isGuest: true };
    const md = lineHoverMarkdown(line([author("e", 4)]), () => evil, NOW, abs)!;
    expect(md).not.toMatch(/(?<!\\)\[click\]/); // the link bracket is escaped
    expect(md).not.toMatch(/(?<!\\)</); // no raw HTML
    expect(md).toContain("\\[click\\]\\(javascript:alert\\(1\\)\\)");
    expect(escapeMarkdown("a_b*c")).toBe("a\\_b\\*c");
  });
});

describe("recovered attribution", () => {
  it("the hover says the text was attributed after recovery", () => {
    const l = line([{ ...author("a", 10), recovered: true } as LineAuthor]);
    expect(lineHoverMarkdown(l, personOf, NOW, abs)).toContain("attributed after recovery");
    expect(lineHoverMarkdown(line([author("a", 10)]), personOf, NOW, abs)).not.toContain("recovered");
  });
});

describe("describeLine", () => {
  it("summarises a line", () => {
    expect(describeLine(line([author("a", 10), author("b", 3)]), personOf)).toEqual({
      mainName: "Alice Demo",
      mainIsGuest: false,
      at: NOW - 300_000,
      others: 1,
      recovered: false,
      otherNames: ["Bob Demo"],
    });
  });
});
