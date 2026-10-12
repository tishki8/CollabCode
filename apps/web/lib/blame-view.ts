"use client";

import { useEffect, useMemo, useState } from "react";
import type * as Monaco from "monaco-editor";
import type * as Y from "yjs";
import {
  blameYText,
  lineHoverMarkdown,
  readableTextColor,
  safeColor,
  cursorLabel,
  type AttributionIndex,
  type PersonDto,
} from "@collabcode/shared";
import { formatAbs } from "./time";

export interface LegendEntry {
  person: PersonDto;
  /** Position in the legend; also picks the underline style so colour is not the only cue. */
  idx: number;
}

interface Options {
  editor: Monaco.editor.IStandaloneCodeEditor | null;
  monaco: typeof Monaco | null;
  ytext: Y.Text | null;
  /** Yjs clientID of this browser's document: its not-yet-saved text is attributed to `me`. */
  clientId: number | null;
  me: PersonDto | null;
  index: AttributionIndex;
  users: Map<string, PersonDto>;
  /** Bumps when new attribution data arrives. */
  version: number;
  hover: boolean;
  colours: boolean;
}

const UNDERLINES = ["solid", "dashed", "dotted", "double"] as const;
const STYLE_ID = "cc-blame-style";

const css = (people: LegendEntry[]): string => {
  const rules = [
    `.cc-g-unknown::before { content: "?"; }`,
    `.cc-g-unknown, .cc-g { font: 600 10px/1.9 system-ui, sans-serif; text-align: center; }`,
    `.cc-g::before { display: inline-block; min-width: 100%; }`,
  ];
  for (const { person, idx } of people) {
    const color = safeColor(person.color);
    const text = readableTextColor(color);
    // JSON.stringify yields a safely escaped CSS string; the label is initials only (plus a guest star).
    const label = JSON.stringify(`${cursorLabel({ initials: person.initials }).slice(0, 3)}${person.isGuest ? "*" : ""}`);
    const style = UNDERLINES[idx % UNDERLINES.length];
    rules.push(
      `.cc-a-${idx} { background-color: ${color}33; border-bottom: 2px ${style} ${color}; }`,
      `.cc-g-${idx}::before { content: ${label}; background: ${color}; color: ${text}; }`,
    );
  }
  return rules.join("\n");
};

/**
 * Blame in the editor, computed from the LIVE text (so it is always current) joined with the
 * server's attribution ranges:
 *  - hover: a message on every line saying who wrote it and when ("and N others" if shared)
 *  - colours: each person's text tinted in their colour, with their initials in the gutter and an
 *    underline pattern, so identity never relies on colour alone
 */
export function useBlameView(o: Options): { legend: LegendEntry[]; hasUnknown: boolean } {
  const { editor, monaco, ytext, clientId, me, index, users, version, hover, colours } = o;
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState<{ legend: LegendEntry[]; hasUnknown: boolean }>({ legend: [], hasUnknown: false });

  // Recompute shortly after the text changes. Two sources, because either can come first:
  //  - the editor's model: this fires when the Yjs binding FILLS an empty editor on open (a viewer who
  //    only reads, or an editor who does not type, would otherwise never get blame) and on local typing
  //  - the shared text: remote edits
  useEffect(() => {
    if (!editor || !ytext || !(hover || colours)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setTick((t) => t + 1), 150);
    };
    const model = editor.onDidChangeModelContent(schedule);
    ytext.observe(schedule);
    schedule(); // the content may already be there
    return () => {
      model.dispose();
      ytext.unobserve(schedule);
      clearTimeout(timer);
    };
  }, [editor, ytext, hover, colours]);

  const people = useMemo(() => {
    const m = new Map(users);
    if (me) m.set(me.id, me); // your own identity is known even before the server reports your first edit
    return m;
  }, [users, me, version]);

  useEffect(() => {
    if (!editor || !monaco || !ytext || !(hover || colours)) {
      setResult({ legend: [], hasUnknown: false });
      return;
    }
    const model = editor.getModel();
    // The binding may still be catching up with the document: try again on the next change.
    if (!model || model.getValueLength() !== ytext.length) return;

    const { lines, pieces } = blameYText(ytext, index, (c) => (me && c === clientId ? { user: me.id, at: Date.now() } : null));

    // Stable legend order: by name, then id.
    const present = new Map<string, PersonDto>();
    let hasUnknown = false;
    for (const p of pieces) {
      if (p.user === null) hasUnknown = true;
      else present.set(p.user, people.get(p.user) ?? { id: p.user, name: "Unknown user", isGuest: false, color: "#666666", initials: "?" });
    }
    const legend = [...present.values()]
      .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1))
      .map((person, idx) => ({ person, idx }));
    const idxOf = new Map(legend.map((l) => [l.person.id, l.idx]));

    const now = Date.now();
    const lineDecos: Monaco.editor.IModelDeltaDecoration[] = [];
    for (const line of lines) {
      if (!line.main) continue;
      const hoverMessage = hover ? lineHoverMarkdown(line, (id) => people.get(id), now, formatAbs) : null;
      const gutter = colours ? (line.main.user === null ? "cc-g cc-g-unknown" : `cc-g cc-g-${idxOf.get(line.main.user)}`) : undefined;
      if (!hoverMessage && !gutter) continue;
      lineDecos.push({
        range: new monaco.Range(line.line, 1, line.line, 1),
        options: {
          isWholeLine: true,
          ...(hoverMessage ? { hoverMessage: { value: hoverMessage, isTrusted: false } } : {}),
          ...(gutter ? { linesDecorationsClassName: gutter } : {}),
        },
      });
    }

    const textDecos: Monaco.editor.IModelDeltaDecoration[] = [];
    if (colours) {
      for (const p of pieces) {
        if (p.user === null || p.length === 0) continue;
        const a = model.getPositionAt(p.offset);
        const b = model.getPositionAt(p.offset + p.length);
        textDecos.push({ range: new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column), options: { inlineClassName: `cc-a-${idxOf.get(p.user)}` } });
      }
    }

    // Colours and initials are written into one <style> element (values are validated/escaped above).
    let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      document.head.appendChild(style);
    }
    style.textContent = css(legend);

    editor.updateOptions({ lineDecorationsWidth: colours ? 30 : 10 });
    const lineCollection = editor.createDecorationsCollection(lineDecos);
    const textCollection = editor.createDecorationsCollection(textDecos);
    setResult({ legend, hasUnknown });
    return () => {
      lineCollection.clear();
      textCollection.clear();
    };
  }, [editor, monaco, ytext, clientId, me, index, people, version, tick, hover, colours]);

  return result;
}
