import { describe, expect, it } from "vitest";
import { createShareLinkInput, displayNameSchema, joinAsGuestInput, SHARE_LINK_ROLES } from "./schemas";
import { describeExpiry, expiryDate, isExpired } from "./expiry";
import { cursorLabel } from "./cursor-css";

const NOW = new Date("2026-01-01T12:00:00Z");

describe("link expiry", () => {
  it("computes expiry from the choice", () => {
    expect(expiryDate("1h", NOW)?.toISOString()).toBe("2026-01-01T13:00:00.000Z");
    expect(expiryDate("1d", NOW)?.toISOString()).toBe("2026-01-02T12:00:00.000Z");
    expect(expiryDate("7d", NOW)?.toISOString()).toBe("2026-01-08T12:00:00.000Z");
    expect(expiryDate("never", NOW)).toBeNull();
  });
  it("knows when a link is expired (exactly at the deadline counts as expired)", () => {
    expect(isExpired(null, NOW)).toBe(false);
    expect(isExpired(new Date(NOW.getTime() + 1), NOW)).toBe(false);
    expect(isExpired(NOW, NOW)).toBe(true);
    expect(isExpired("2025-12-31T00:00:00Z", NOW)).toBe(true);
  });
  it("describes expiry for humans", () => {
    expect(describeExpiry(null, NOW)).toBe("never expires");
    expect(describeExpiry("2026-01-01T11:00:00Z", NOW)).toBe("expired");
    expect(describeExpiry("2026-01-01T12:30:00Z", NOW)).toBe("expires in 30 min");
    expect(describeExpiry("2026-01-01T15:00:00Z", NOW)).toBe("expires in 3 h");
    expect(describeExpiry("2026-01-05T12:00:00Z", NOW)).toBe("expires in 4 days");
  });
});

describe("createShareLinkInput", () => {
  it("offers viewer, commenter and editor, never owner", () => {
    expect([...SHARE_LINK_ROLES]).toEqual(["VIEWER", "COMMENTER", "EDITOR"]);
    expect(createShareLinkInput.safeParse({ role: "OWNER" }).success).toBe(false);
  });
  it("defaults to a 7-day, open (no approval) link", () => {
    expect(createShareLinkInput.parse({ role: "VIEWER" })).toEqual({ role: "VIEWER", expiresIn: "7d", requiresApproval: false });
  });
  it("rejects unknown expiry choices", () => {
    expect(createShareLinkInput.safeParse({ role: "VIEWER", expiresIn: "forever" }).success).toBe(false);
    expect(createShareLinkInput.safeParse({ role: "VIEWER", expiresIn: "never", requiresApproval: true }).success).toBe(true);
  });
});

describe("displayNameSchema (guest names)", () => {
  it("trims and collapses whitespace", () => {
    expect(displayNameSchema.parse("  Gina    Guest ")).toBe("Gina Guest");
  });
  it("turns line separators and other odd whitespace into a plain space", () => {
    expect(displayNameSchema.parse("a\u2028b\tc\nd")).toBe("a b c d");
  });
  it("accepts ordinary international names", () => {
    expect(displayNameSchema.parse("Zoë Müller")).toBe("Zoë Müller");
    expect(displayNameSchema.parse("李雷")).toBe("李雷");
  });
  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["too long", "x".repeat(41)],
    ["control character", "a\u0000b"],
    ["right-to-left override", "evil\u202egpj.exe"],
    ["zero-width space", "a\u200bb"],
  ])("rejects %s", (_label, name) => {
    expect(displayNameSchema.safeParse(name).success).toBe(false);
  });
  it("joinAsGuestInput needs a well-formed token and a name", () => {
    const token = "A".repeat(43);
    expect(joinAsGuestInput.safeParse({ token, displayName: "Gina" }).success).toBe(true);
    expect(joinAsGuestInput.safeParse({ token: "short", displayName: "Gina" }).success).toBe(false);
    expect(joinAsGuestInput.safeParse({ token, displayName: "" }).success).toBe(false);
  });
});

describe("cursor labels for guests", () => {
  it("marks guests so they can't pass as signed-in teammates", () => {
    expect(cursorLabel({ initials: "GG", name: "Gina Guest", isGuest: true })).toBe("GG Gina Guest (guest)");
    expect(cursorLabel({ initials: "AD", name: "Alice Demo", isGuest: false })).toBe("AD Alice Demo");
  });
  it("keeps the guest marker when a long name is truncated", () => {
    const label = cursorLabel({ initials: "XX", name: "x".repeat(40), isGuest: true });
    expect(label.length).toBeLessThanOrEqual(32);
    expect(label.endsWith(" (guest)")).toBe(true);
  });
  it("only a real boolean true marks a guest", () => {
    expect(cursorLabel({ initials: "AD", name: "Alice", isGuest: "true" })).toBe("AD Alice");
  });
});
