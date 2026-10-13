"use client";

import { useEffect, useState } from "react";
import type * as Monaco from "monaco-editor";
import * as Y from "yjs";
import { escapeMarkdown, resolveAnchors, type SuggestionDto, type ThreadDto } from "@collabcode/shared";

interface Options {
  editor: Monaco.editor.IStandaloneCodeEditor | null;
  monaco: typeof Monaco | null;
  ydoc: Y.Doc | null;
  ytext: Y.Text | null;
  suggestions: SuggestionDto[];
  threads: ThreadDto[];
  /** Also mark resolved threads (faintly). */
  showResolved: boolean;
}

const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n)}…` : s);
const code = (s: string) => "`" + clip(s).replace(/`/g, "'").replace(/\n/g, "↵") + "`";

/**
 * Draws open suggestions and comment threads over the text. Each is placed by resolving its Yjs
 * anchors against the LIVE text, so it follows the characters it was made for; recomputed shortly
 * after the text or the data changes.
 */
export function useReviewDecorations(o: Options) {
  const { editor, monaco, ydoc, ytext, suggestions, threads, showResolved } = o;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!editor || !ytext) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setTick((t) => t + 1), 120);
    };
    const model = editor.onDidChangeModelContent(schedule);
    ytext.observe(schedule);
    schedule();
    return () => {
      model.dispose();
      ytext.unobserve(schedule);
      clearTimeout(timer);
    };
  }, [editor, ytext]);

  useEffect(() => {
    if (!editor || !monaco || !ydoc || !ytext) return;
    const model = editor.getModel();
    if (!model || model.getValueLength() !== ytext.length) return; // the binding is still catching up
    const place = (from: number, to: number) => {
      const a = model.getPositionAt(from);
      const b = model.getPositionAt(to);
      return new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column);
    };

    const decos: Monaco.editor.IModelDeltaDecoration[] = [];
    for (const s of suggestions) {
      if (s.status !== "OPEN") continue;
      const r = resolveAnchors(Y, ydoc, ytext, s.anchors);
      if (!r) continue;
      const who = escapeMarkdown(s.author.name);
      const hover = s.anchors.collapsed
        ? `**${who}** suggests inserting ${code(s.newText)}`
        : `**${who}** suggests replacing ${code(ytext.toString().slice(r.from, r.to))} with ${s.newText ? code(s.newText) : "nothing (delete)"}`;
      decos.push({
        range: place(r.from, r.to),
        options: {
          ...(r.to > r.from ? { inlineClassName: "cc-sugg" } : {}),
          hoverMessage: { value: hover, isTrusted: false },
          after: { content: ` ✎ ${s.author.initials} suggests`, inlineClassName: "cc-sugg-tag" },
        },
      });
    }
    for (const t of threads) {
      if (t.resolvedAt && !showResolved) continue;
      const r = resolveAnchors(Y, ydoc, ytext, t.anchors);
      if (!r) continue;
      const first = t.comments[0];
      decos.push({
        range: place(r.from, r.to),
        options: {
          ...(r.to > r.from ? { inlineClassName: t.resolvedAt ? "cc-thread cc-thread-resolved" : "cc-thread" } : {}),
          hoverMessage: first ? { value: `**${escapeMarkdown(first.author.name)}**: ${escapeMarkdown(clip(first.body, 200))}${t.comments.length > 1 ? ` _(+${t.comments.length - 1} repl${t.comments.length === 2 ? "y" : "ies"})_` : ""}`, isTrusted: false } : undefined,
          after: { content: ` 💬${t.comments.length}${t.resolvedAt ? " ✓" : ""}`, inlineClassName: "cc-thread-tag" },
        },
      });
    }
    const collection = editor.createDecorationsCollection(decos);
    return () => collection.clear();
  }, [editor, monaco, ydoc, ytext, suggestions, threads, showResolved, tick]);
}
