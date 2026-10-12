// Monaco language id from a file name.
const BY_EXTENSION: Record<string, string> = {
  py: "python",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  java: "java",
  c: "c",
  h: "cpp",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  json: "json",
  md: "markdown",
  html: "html",
  css: "css",
  sh: "shell",
  txt: "plaintext",
};

export function monacoLanguageFor(fileName: string): string {
  const ext = fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase() : "";
  return BY_EXTENSION[ext] ?? "plaintext";
}
