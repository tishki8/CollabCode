// CSS for remote cursors/selections in the editor. y-monaco only adds class names such as
// `yRemoteSelectionHead-<clientId>`; the colours and the name label are ours to supply.
//
// Names and colours arrive through awareness, i.e. from other browsers, so they are treated
// as untrusted: colours must be #rrggbb, labels are emitted as JSON string literals (which
// escapes quotes, backslashes and newlines) and the result is only ever set as style text,
// never as HTML.

export interface CursorUser {
  name?: unknown;
  color?: unknown;
  initials?: unknown;
  isGuest?: unknown;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
export const FALLBACK_COLOR = "#666666";
const MAX_LABEL = 32;

export const safeColor = (c: unknown): string => (typeof c === "string" && HEX.test(c) ? c : FALLBACK_COLOR);

/** Black or white, whichever reads better on the given #rrggbb background (WCAG luminance). */
export function readableTextColor(bg: string): "#000000" | "#ffffff" {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(bg.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.35 ? "#000000" : "#ffffff";
}

/** "AD Alice Demo": initials AND name, so identity never depends on colour alone. */
export function cursorLabel(user: CursorUser): string {
  const clean = (v: unknown) =>
    // eslint-disable-next-line no-control-regex
    typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "";
  const initials = clean(user.initials).slice(0, 3);
  const name = clean(user.name);
  // Guests are labelled so nobody can pass as a signed-in teammate by choosing a familiar name.
  const label = [initials, name, user.isGuest === true ? "(guest)" : ""].filter(Boolean).join(" ") || "Unknown";
  if (label.length <= MAX_LABEL) return label;
  // Truncate the name, but never cut off the "(guest)" marker.
  const marker = user.isGuest === true ? " (guest)" : "";
  return label.slice(0, MAX_LABEL - 1 - marker.length) + "…" + marker;
}

export function cursorCss(clientId: number, user: CursorUser): string {
  if (!Number.isInteger(clientId) || clientId < 0) return "";
  const color = safeColor(user.color);
  const text = readableTextColor(color);
  const label = JSON.stringify(cursorLabel(user));
  return [
    `.yRemoteSelection-${clientId} { background-color: ${color}40; }`,
    `.yRemoteSelectionHead-${clientId} { position: absolute; border-left: 2px solid ${color}; height: 100%; box-sizing: border-box; }`,
    `.yRemoteSelectionHead-${clientId}::after { content: ${label}; position: absolute; top: -1.4em; left: -2px; padding: 0 4px; border-radius: 3px 3px 3px 0; font: 600 11px/1.4 system-ui, sans-serif; white-space: nowrap; background: ${color}; color: ${text}; z-index: 10; pointer-events: none; }`,
  ].join("\n");
}
