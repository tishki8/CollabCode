export const LANGUAGES = ["PYTHON", "JAVASCRIPT", "JAVA", "CPP"] as const;
export type Language = (typeof LANGUAGES)[number];

export interface LanguageInfo {
  label: string;
  defaultEntryFile: string;
  /** Compiled languages get a separate compile step with its own time limit. */
  compiled: boolean;
}

export const LANGUAGE_INFO: Record<Language, LanguageInfo> = {
  PYTHON: { label: "Python", defaultEntryFile: "main.py", compiled: false },
  JAVASCRIPT: { label: "JavaScript", defaultEntryFile: "index.js", compiled: false },
  JAVA: { label: "Java", defaultEntryFile: "Main.java", compiled: true },
  CPP: { label: "C++", defaultEntryFile: "main.cpp", compiled: true },
};

export const COMPILE_TIMEOUT_MS = 15_000;
export const RUN_TIMEOUT_MS = 10_000;
