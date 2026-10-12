// Serves Monaco from our own origin (public/monaco/vs) instead of a CDN, so the editor works
// offline, in Docker and in tests. Runs before `next dev` / `next build`; the copy is git-ignored.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// monaco-editor's "exports" map hides package.json from require.resolve, so use the
// workspace symlink in this app's node_modules (the script lives in apps/web/scripts).
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = join(appDir, "node_modules", "monaco-editor");
const version = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version;
const dest = join(appDir, "public", "monaco");
const stamp = join(dest, ".version");

if (existsSync(stamp) && readFileSync(stamp, "utf8") === version) {
  console.log(`monaco ${version} already copied`);
} else {
  mkdirSync(dest, { recursive: true });
  cpSync(join(pkgDir, "min", "vs"), join(dest, "vs"), { recursive: true, dereference: true });
  writeFileSync(stamp, version);
  console.log(`copied monaco ${version} to public/monaco/vs`);
}
