// Human-readable text for blame, kept free of any editor or React code so it can be unit tested.
import type { LineBlame } from "./blame";

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function formatAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** Escape text so it shows literally inside Markdown (names are chosen by users, guests included). */
export const escapeMarkdown = (s: string): string => s.replace(/[\\`*_{}[\]()#+\-.!|<>~&]/g, "\\$&");

export interface PersonLike {
  name: string;
  isGuest: boolean;
}

export interface LineDescription {
  /** Name of the main author, or null when the line has no recorded author. */
  mainName: string | null;
  mainIsGuest: boolean;
  /** When the main author last wrote on this line (ms), if known. */
  at: number | null;
  /** The main author's text here was credited after crash recovery. */
  recovered: boolean;
  /** Number of other authors besides the main one. */
  others: number;
  otherNames: string[];
}

export function describeLine(line: LineBlame, personOf: (userId: string) => PersonLike | undefined): LineDescription {
  const label = (user: string | null) => (user === null ? { name: "Unknown author", isGuest: false } : (personOf(user) ?? { name: "Unknown user", isGuest: false }));
  const main = line.main;
  const mainPerson = main ? label(main.user) : null;
  return {
    mainName: mainPerson?.name ?? null,
    mainIsGuest: mainPerson?.isGuest ?? false,
    at: main?.lastAt ?? null,
    recovered: main?.recovered ?? false,
    others: line.others,
    otherNames: line.authors.slice(1).map((a) => label(a.user).name),
  };
}

/**
 * The text shown when hovering a line: the main author, when, and "and N others".
 * Returns null for lines with no characters at all.
 */
export function lineHoverMarkdown(
  line: LineBlame,
  personOf: (userId: string) => PersonLike | undefined,
  now: number,
  formatAbs: (ms: number) => string,
): string | null {
  if (!line.main) return null;
  const d = describeLine(line, personOf);
  const parts: string[] = [];
  const who = `**${escapeMarkdown(d.mainName!)}**${d.mainIsGuest ? " (guest)" : ""}`;
  parts.push(d.mainName === "Unknown author" ? "Author unknown: written before authorship tracking" : `${who} wrote this line`);
  if (d.at !== null) parts.push(`${formatAgo(d.at, now)} (${formatAbs(d.at)})`);
  if (d.recovered) parts.push("_attributed after recovery: the author's own record was lost in a crash and someone else re-sent this text_");
  if (d.others > 0) {
    const shown = d.otherNames.slice(0, 3).map(escapeMarkdown).join(", ");
    const more = d.otherNames.length > 3 ? ` and ${d.otherNames.length - 3} more` : "";
    parts.push(`and ${d.others} other${d.others > 1 ? "s" : ""}: ${shown}${more}`);
  }
  return parts.join("\n\n");
}
