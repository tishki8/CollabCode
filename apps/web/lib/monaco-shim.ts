// y-monaco does `import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js"`, which would
// bundle a second copy of Monaco. We alias that import (see next.config.ts) to this shim, which
// re-exports the instance @monaco-editor/react already loaded from /monaco/vs.
// Only import y-monaco AFTER the editor has mounted, or `window.monaco` is not there yet.
type MonacoGlobal = typeof import("monaco-editor");
const m = (globalThis as unknown as { monaco?: MonacoGlobal }).monaco;
if (!m) throw new Error("Monaco is not loaded yet: import y-monaco only after the editor mounted");

export const Range = m.Range;
export const Selection = m.Selection;
export const SelectionDirection = m.SelectionDirection;
