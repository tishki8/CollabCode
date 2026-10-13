"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import {
  ReplayEngine,
  base64ToBytes,
  formatAgo,
  playbackDelay,
  visibleSteps,
  type PersonDto,
  type ReplayFrame,
  type ReplayPointDto,
  type ReplayResponse,
  type ReplayStep,
} from "@collabcode/shared";
import { api } from "@/lib/client-api";
import { errorText } from "@/lib/review";
import { formatAbs } from "@/lib/time";
import { PersonChip } from "./PersonChip";

const SPEEDS = [0.5, 1, 2, 4, 8, 16];
const MAX_LINES_SHOWN = 4000;
const btn = "rounded border border-slate-400 px-2.5 py-1 text-sm hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50";
const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n)}…` : s);

interface Loaded {
  engine: ReplayEngine;
  steps: ReplayStep[];
  people: Map<string, PersonDto>;
}

/**
 * Plays back how a file was written, from a checkpoint (or the beginning): play/pause, speed,
 * a scrubber, and a filter that steps through just one person's changes (everyone else's are still
 * applied, so the text on screen is always right).
 */
export function ReplayPanel({ fileId, fileName }: { fileId: string; fileName: string }) {
  const [points, setPoints] = useState<ReplayPointDto[]>([]);
  const [start, setStart] = useState<string>("");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [person, setPerson] = useState<string>("");
  const [pos, setPos] = useState(-1); // index into the visible steps; -1 = the starting state
  const [frame, setFrame] = useState<ReplayFrame | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  const engineRef = useRef<ReplayEngine | null>(null);

  // 1. Where can playback start?
  useEffect(() => {
    let cancelled = false;
    api<ReplayPointDto[]>("GET", `/files/${fileId}/replay-points`).then(
      (p) => {
        if (cancelled) return;
        setPoints(p);
        // Long history and a checkpoint to start from: don't make people load everything by default.
        const begin = p[0];
        setStart(begin && begin.events > 2000 && p[1] ? (p[1].checkpointId ?? "") : "");
      },
      (e) => !cancelled && setError(errorText(e, "Could not load replay options")),
    );
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  // 2. Load the starting state and every event after it.
  useEffect(() => {
    if (points.length === 0) return;
    let cancelled = false;
    setPlaying(false);
    setError(null);
    setLoaded(null);
    setFrame(null);
    setPos(-1);
    setPerson("");
    (async () => {
      try {
        const steps: ReplayStep[] = [];
        const people = new Map<string, PersonDto>();
        let base: Uint8Array | null = null;
        let after: string | null = null;
        for (let page = 0; ; page++) {
          const q = new URLSearchParams();
          if (start) q.set("checkpointId", start);
          if (after) q.set("after", after);
          const res: ReplayResponse = await api<ReplayResponse>("GET", `/files/${fileId}/replay?${q}`);
          if (cancelled) return;
          if (res.base) base = base64ToBytes(res.base.state);
          res.users.forEach((u) => people.set(u.id, u));
          for (const e of res.events) {
            steps.push({ id: e.id, userId: e.userId, startedAt: Date.parse(e.startedAt), endedAt: Date.parse(e.endedAt), origin: e.origin, update: base64ToBytes(e.update) });
          }
          setLoading(`Loading changes… ${steps.length} of ${res.totalEvents}`);
          after = res.nextAfter;
          if (!after) break;
        }
        if (cancelled) return;
        engineRef.current?.destroy();
        const engine = new ReplayEngine(Y, base ?? Y.encodeStateAsUpdate(new Y.Doc()), steps);
        engineRef.current = engine;
        setLoaded({ engine, steps, people });
        setFrame(engine.seek(-1));
        setLoading(null);
      } catch (e) {
        if (!cancelled) {
          setError(errorText(e, "Could not load the history"));
          setLoading(null);
        }
      }
    })();
    setLoading("Loading changes…");
    return () => {
      cancelled = true;
    };
  }, [fileId, start, points]);

  useEffect(() => () => engineRef.current?.destroy(), []);

  const visible = useMemo(() => (loaded ? visibleSteps(loaded.steps, person || null) : []), [loaded, person]);

  const go = useCallback(
    (k: number) => {
      if (!loaded) return;
      const clamped = Math.max(-1, Math.min(k, visible.length - 1));
      setPos(clamped);
      setFrame(loaded.engine.seek(clamped === -1 ? -1 : visible[clamped]!));
    },
    [loaded, visible],
  );

  // Changing the person restarts from the beginning of the replay.
  useEffect(() => {
    setPlaying(false);
    if (loaded) go(-1);
  }, [person]);

  // 3. Playback: wait (scaled by speed), then show the next change.
  useEffect(() => {
    if (!playing || !loaded) return;
    if (pos >= visible.length - 1) {
      setPlaying(false);
      return;
    }
    const cur = pos >= 0 ? loaded.steps[visible[pos]!]! : null;
    const next = loaded.steps[visible[pos + 1]!]!;
    const gap = cur ? next.startedAt - cur.endedAt : 600;
    const timer = setTimeout(() => go(pos + 1), playbackDelay(gap, speed));
    return () => clearTimeout(timer);
  }, [playing, pos, speed, loaded, visible, go]);

  const current = loaded && frame && frame.index >= 0 ? loaded.steps[frame.index]! : null;
  const who = current ? loaded!.people.get(current.userId) : null;
  const atEnd = pos >= visible.length - 1;

  return (
    <section aria-label="Replay" className="flex h-full min-h-0 flex-col gap-3 p-4" data-testid="replay-panel">
      <div>
        <h2 className="text-lg font-semibold">Replay: {fileName}</h2>
        <p className="text-sm text-slate-600 dark:text-slate-400">Watch how this file was written. Start from a checkpoint to skip the early history.</p>
      </div>

      <div className="flex flex-wrap items-end gap-3 text-sm">
        <div className="flex flex-col gap-1">
          <label htmlFor="replay-start" className="font-medium">Start from</label>
          <select id="replay-start" value={start} onChange={(e) => setStart(e.target.value)} className="rounded border border-slate-400 bg-transparent px-2 py-1" data-testid="replay-start">
            {points.map((p) => (
              <option key={p.checkpointId ?? "begin"} value={p.checkpointId ?? ""}>
                {p.name} ({p.events} change{p.events === 1 ? "" : "s"})
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="replay-person" className="font-medium">Step through changes by</label>
          <select id="replay-person" value={person} onChange={(e) => setPerson(e.target.value)} className="rounded border border-slate-400 bg-transparent px-2 py-1" data-testid="replay-person" disabled={!loaded}>
            <option value="">Everyone</option>
            {loaded && [...new Set(loaded.steps.map((s) => s.userId))].map((id) => (
              <option key={id} value={id}>{loaded.people.get(id)?.name ?? "Unknown user"}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="replay-speed" className="font-medium">Speed</label>
          <select id="replay-speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="rounded border border-slate-400 bg-transparent px-2 py-1" data-testid="replay-speed">
            {SPEEDS.map((s) => (
              <option key={s} value={s}>{s}×</option>
            ))}
          </select>
        </div>
      </div>

      {error && <p role="alert" className="rounded border border-red-700 p-2 text-sm text-red-800 dark:text-red-300" data-testid="replay-error">{error}</p>}
      {loading && <p role="status" className="text-sm" data-testid="replay-loading">{loading}</p>}

      {loaded && (
        <>
          <div className="flex items-center gap-2">
            <button type="button" className={btn} onClick={() => go(pos - 1)} disabled={pos < 0} aria-label="Previous change" data-testid="replay-prev">⏮</button>
            <button
              type="button"
              className={`${btn} min-w-20`}
              onClick={() => {
                if (!playing && atEnd) go(-1);
                setPlaying((p) => !p);
              }}
              disabled={visible.length === 0}
              aria-label={playing ? "Pause" : "Play"}
              data-testid="replay-play"
            >
              {playing ? "⏸ Pause" : "▶ Play"}
            </button>
            <button type="button" className={btn} onClick={() => go(pos + 1)} disabled={atEnd} aria-label="Next change" data-testid="replay-next">⏭</button>
            <input
              type="range"
              min={0}
              max={visible.length}
              value={pos + 1}
              onChange={(e) => {
                setPlaying(false);
                go(Number(e.target.value) - 1);
              }}
              aria-label="Replay position"
              aria-valuetext={`Change ${pos + 1} of ${visible.length}`}
              disabled={visible.length === 0}
              className="min-w-0 flex-1"
              data-testid="replay-scrubber"
            />
            <span className="w-28 shrink-0 text-right text-sm tabular-nums" data-testid="replay-position">
              {pos + 1} / {visible.length}
            </span>
          </div>

          <p className="min-h-6 text-sm" data-testid="replay-caption">
            {current && who ? (
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <PersonChip person={who} />
                <time dateTime={new Date(current.endedAt).toISOString()} title={formatAbs(current.endedAt)}>{formatAgo(current.endedAt)}</time>
                {frame?.change && (
                  <span className="text-xs">
                    <span className="text-green-800 dark:text-green-400">+{frame.change.inserted.length}</span>{" "}
                    <span className="text-red-800 dark:text-red-400">−{frame.change.removed.length}</span> characters
                  </span>
                )}
                {current.origin !== "edit" && (
                  <span className="rounded border border-slate-400 px-1.5 text-xs">{current.origin === "restore" ? "restore" : "accepted suggestion"}</span>
                )}
                {frame?.change?.removed && <span className="text-xs text-red-800 dark:text-red-300">removed <q className="font-mono">{clip(frame.change.removed)}</q></span>}
              </span>
            ) : visible.length === 0 ? (
              "No recorded changes for this selection."
            ) : (
              "The starting point. Press play, or drag the slider."
            )}
          </p>

          <ReplayText frame={frame} />
        </>
      )}
    </section>
  );
}

function ReplayText({ frame }: { frame: ReplayFrame | null }) {
  const lines = useMemo(() => {
    if (!frame) return [];
    const out: { n: number; start: number; text: string }[] = [];
    let start = 0;
    frame.text.split("\n").forEach((text, i) => {
      out.push({ n: i + 1, start, text });
      start += text.length + 1;
    });
    return out;
  }, [frame]);
  if (!frame) return null;
  const hl = frame.change && frame.change.inserted ? { from: frame.change.from, to: frame.change.from + frame.change.inserted.length } : null;
  const shown = lines.slice(0, MAX_LINES_SHOWN);

  return (
    <div className="min-h-0 flex-1 overflow-auto rounded border border-slate-300 bg-slate-950 p-2 font-mono text-xs text-slate-100 dark:border-slate-700" data-testid="replay-text" tabIndex={0} aria-label="File text at this point">
      {shown.map((l) => {
        const a = hl ? Math.max(hl.from, l.start) - l.start : 0;
        const b = hl ? Math.min(hl.to, l.start + l.text.length) - l.start : 0;
        const marked = hl && b > a;
        const touches = hl && hl.from <= l.start + l.text.length && hl.to >= l.start && (marked || (hl.from <= l.start + l.text.length && hl.to > l.start));
        return (
          <div key={l.n} className="flex" data-changed={touches ? "true" : undefined}>
            <span className="w-10 shrink-0 select-none pr-2 text-right text-slate-500">{l.n}</span>
            <span className="whitespace-pre">
              {marked ? (
                <>
                  {l.text.slice(0, a)}
                  <mark className="bg-green-700/60 text-inherit" data-testid="replay-mark">{l.text.slice(a, b)}</mark>
                  {l.text.slice(b)}
                </>
              ) : (
                l.text || " "
              )}
            </span>
          </div>
        );
      })}
      {lines.length > MAX_LINES_SHOWN && <p className="pt-2 text-slate-400">…{lines.length - MAX_LINES_SHOWN} more lines not shown</p>}
    </div>
  );
}
