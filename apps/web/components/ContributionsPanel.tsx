"use client";

import { useEffect, useState } from "react";
import { formatDuration, safeColor, type ContributionsResponse } from "@collabcode/shared";
import { api, ApiRequestError } from "@/lib/client-api";
import { formatAbs } from "@/lib/time";
import { PersonChip } from "./PersonChip";

type Preset = "24h" | "7d" | "30d" | "all";
const LABEL: Record<Preset, string> = { "24h": "Last 24 hours", "7d": "Last 7 days", "30d": "Last 30 days", all: "All time" };
const DAYS: Record<Exclude<Preset, "all">, number> = { "24h": 1, "7d": 7, "30d": 30 };

/**
 * Who did what, as a story over time rather than a scoreboard: one lane per person, ordered by when
 * they started, with the amount of activity in each interval. Nothing is ranked or summed across people.
 */
export function ContributionsPanel({ projectId }: { projectId: string }) {
  const [preset, setPreset] = useState<Preset>("all");
  const [data, setData] = useState<ContributionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const q = preset === "all" ? "" : `?from=${encodeURIComponent(new Date(Date.now() - DAYS[preset] * 86_400_000).toISOString())}`;
    api<ContributionsResponse>("GET", `/projects/${projectId}/contributions${q}`)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e instanceof ApiRequestError ? e.message : "Could not load contributions."))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [projectId, preset]);

  const intervalLabel = data ? (data.bucketMs <= 3_600_000 ? "hour" : data.bucketMs === 86_400_000 ? "day" : formatDuration(data.bucketMs)) : "";

  return (
    <section aria-label="Contributions" className="flex h-full flex-col gap-4 overflow-y-auto p-4" data-testid="contributions-panel">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Contributions</h2>
          <p className="text-xs text-slate-600 dark:text-slate-400">
            Everyone&apos;s activity across the whole project, in the order people started. This is a timeline, not a ranking.
          </p>
        </div>
        <label className="flex flex-col text-xs">
          Time range
          <select value={preset} onChange={(e) => setPreset(e.target.value as Preset)} className="mt-1 rounded border border-slate-400 bg-transparent px-2 py-1 text-sm" data-testid="contrib-range">
            {(Object.keys(LABEL) as Preset[]).map((k) => (
              <option key={k} value={k} className="text-black">{LABEL[k]}</option>
            ))}
          </select>
        </label>
      </div>

      <div aria-live="polite">{error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}</div>
      {loading && !data && <p role="status" className="text-sm">Loading…</p>}

      {data && data.people.length === 0 && (
        <p className="text-sm text-slate-600 dark:text-slate-400" data-testid="contrib-empty">No recorded activity in this range yet. Edit a file and it will show up here.</p>
      )}

      {data && data.people.length > 0 && (
        <>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="People" data-testid="contrib-people">
            {data.people.map((p) => (
              <li key={p.id} className="rounded-lg border border-slate-300 p-3 text-sm dark:border-slate-700" data-testid="contrib-card">
                <PersonChip person={p} />
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                  <dt className="text-slate-600 dark:text-slate-400">Lines added / removed</dt>
                  <dd data-testid="c-lines">+{p.linesAdded.toLocaleString()} / −{p.linesRemoved.toLocaleString()}</dd>
                  <dt className="text-slate-600 dark:text-slate-400">Characters</dt>
                  <dd>+{p.added.toLocaleString()} / −{p.removed.toLocaleString()}</dd>
                  <dt className="text-slate-600 dark:text-slate-400">Active time</dt>
                  <dd data-testid="c-active">{formatDuration(p.activeMs)} in {p.sessions} session{p.sessions === 1 ? "" : "s"}</dd>
                  <dt className="text-slate-600 dark:text-slate-400">Lines still theirs</dt>
                  <dd data-testid="c-surviving">{p.survivingLines.toLocaleString()}</dd>
                  <dt className="text-slate-600 dark:text-slate-400">Active between</dt>
                  <dd>{formatAbs(p.firstAt)} to {formatAbs(p.lastAt)}</dd>
                </dl>
              </li>
            ))}
          </ul>

          <div>
            <h3 className="mb-1 text-sm font-semibold">Activity over time (one cell per {intervalLabel})</h3>
            <div className="flex flex-col gap-2" data-testid="contrib-timeline">
              {data.lanes.map((lane) => {
                const person = data.people.find((p) => p.id === lane.userId)!;
                const activeCells = lane.cells.filter((c) => c.activeMs > 0 || c.added > 0 || c.removed > 0).length;
                const peak = Math.max(1, ...lane.cells.map((c) => c.activeMs));
                return (
                  <div key={lane.userId} className="flex items-center gap-3" data-testid="contrib-lane">
                    <div className="w-44 shrink-0 text-sm"><PersonChip person={person} /></div>
                    <div
                      role="img"
                      aria-label={`${person.name}: active in ${activeCells} of ${lane.cells.length} intervals, ${formatDuration(person.activeMs)} in total`}
                      className="grid h-7 flex-1 gap-px rounded bg-slate-100 dark:bg-slate-900"
                      style={{ gridTemplateColumns: `repeat(${lane.cells.length}, minmax(0, 1fr))` }}
                    >
                      {lane.cells.map((c, i) => {
                        const level = c.activeMs > 0 ? Math.max(0.15, c.activeMs / peak) : c.added + c.removed > 0 ? 0.15 : 0;
                        return (
                          <div
                            key={i}
                            className="flex items-end"
                            title={level ? `${formatAbs(Date.parse(data.from) + i * data.bucketMs)}: ${formatDuration(c.activeMs)} active, +${c.added} / −${c.removed} characters` : undefined}
                          >
                            {level > 0 && (
                              // height is the cue (not just colour); the person's colour ties it to their lane
                              <div className="w-full rounded-sm" style={{ height: `${Math.round(level * 100)}%`, backgroundColor: safeColor(person.color), minHeight: 3 }} />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
              <div className="ml-[11.75rem] flex justify-between text-[10px] text-slate-600 dark:text-slate-400">
                <span>{formatAbs(data.from)}</span>
                <span>{formatAbs(data.to)}</span>
              </div>
            </div>
          </div>
          {data.truncated && <p className="text-xs text-amber-800 dark:text-amber-400">Very busy project: only the first 200,000 changes are summarised.</p>}
          <p className="text-xs text-slate-600 dark:text-slate-400">
            Active time counts the time between a person&apos;s edits, joining edits less than 5 minutes apart into one session. &quot;Lines&quot; counts line breaks typed or removed.
          </p>
        </>
      )}
    </section>
  );
}
