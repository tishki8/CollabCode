import { describe, expect, it } from "vitest";
import { cursorCss, cursorLabel, readableTextColor, safeColor } from "./cursor-css";
import { safeRedirectPath } from "./safe-redirect";

describe("cursor css", () => {
  it("only accepts #rrggbb colours", () => {
    expect(safeColor("#E69F00")).toBe("#E69F00");
    for (const bad of ["red", "#fff", "#12345g", "url(javascript:alert(1))", "#E69F00; background:url(x)", 5, null, undefined]) {
      expect(safeColor(bad)).toBe("#666666");
    }
  });

  it("labels with initials and name, so colour is never the only signal", () => {
    expect(cursorLabel({ initials: "AD", name: "Alice Demo" })).toBe("AD Alice Demo");
    expect(cursorLabel({})).toBe("Unknown");
    expect(cursorLabel({ name: "x".repeat(100) }).length).toBeLessThanOrEqual(32);
  });

  it("cannot be broken out of by a hostile name", () => {
    const css = cursorCss(7, { name: 'x"; } body { display:none } /*', color: "#E69F00", initials: "A\nB" });
    // the quote is escaped, so the injected text stays inside the content string
    expect(css).toContain('\\"');
    expect(css).not.toMatch(/\n\s*body\s*\{/);
    const labelLine = css.split("\n").find((l) => l.includes("::after"))!;
    expect(labelLine.match(/content: ("(?:[^"\\]|\\.)*");/)).not.toBeNull();
    expect(css.split("\n")).toHaveLength(3); // newline in initials didn't add lines
  });

  it("ignores invalid client ids", () => {
    expect(cursorCss(-1, {})).toBe("");
    expect(cursorCss(1.5, {})).toBe("");
    expect(cursorCss(NaN, {})).toBe("");
  });

  it("picks readable text colours for every palette entry", () => {
    expect(readableTextColor("#F0E442")).toBe("#000000"); // yellow needs dark text
    expect(readableTextColor("#332288")).toBe("#ffffff"); // indigo needs light text
  });
});

describe("safeRedirectPath", () => {
  it("allows same-site paths", () => {
    expect(safeRedirectPath("/join/abc_DEF-123")).toBe("/join/abc_DEF-123");
    expect(safeRedirectPath("/p/1?file=2")).toBe("/p/1?file=2");
  });
  it.each([
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "javascript:alert(1)",
    "evil.example/x",
    "/ok\nSet-Cookie: x=1",
    "",
    undefined,
    42,
    "/" + "a".repeat(3000),
  ])("falls back for %j", (input) => {
    expect(safeRedirectPath(input)).toBe("/dashboard");
  });
});
