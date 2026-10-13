"use client";

import { useCallback, useEffect, useState } from "react";
import type { EventDto, EventsResponse, HistoryDiffResponse, MemberDto, PersonDto, RestoreEventDto, RestoreResultDto, Role } from "@collabcode/shared";
import { can, formatAgo } from "@collabcode/shared";
import { api, ApiRequestError } from "@/lib/client-api";
import { errorText, usePolled } from "@/lib/review";
import { formatAbs, toLocalInput } from "@/lib/time";
import { PersonChip } from "./PersonChip";

type Preset = "1h" | "24h" | "7d" | "all" | "custom";
const PRESET_LABEL: Record<Preset, string> = { "1h": "Last hour", "24h": "Last 24 hours", "7d": "Last 7 days", all: "All time", custom: "Custom range" };
const PRESET_MS: Record<"1h" | "24h" | "7d", number> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000 };

/**
 * The change timeline of one file, filterable by person and time range, and a diff of exactly what
 * the chosen person added and removed in that range.
 */
export function HistoryPanel({
  projectId,
  fileId,
  fileName,
  role,
  onTreeChanged,
}: {
  projectId: string;
  fileId: string;
  fileName: string;
  role: Role;
  onTreeChanged(): void;
}) {
  const [members, setMembers] = useState<MemberDto[]>([]);
  const [userId, setUserId] = useState("");
  const [preset, setPreset] = useState<Preset>("all");
  const [from, setFrom] = useState(toLocalInput(new Date(Date.now() - 86_400_000)));
  const [to, setTo] = useState(toLocalInput(new Date()));
  const [events, setEvents] = useState<EventDto[]>([]);
  const [people, setPeople] = useState<Map<string, PersonDto>>(new Map());
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState<HistoryDiffResponse | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  useEffect(() => {
    api<MemberDto[]>("GET", `/projects/${projectId}/members`).then(setMembers, () => undefined);
  }, [projectId]);

  /** The chosen range as ISO timestamps (presets are relative to "now" at the moment you ask). */
  const range = useCallback((): { from?: string; to?: string } => {
    if (preset === "all") return {};
    if (preset === "custom") return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
    return { from: new Date(Date.now() - PRESET_MS[preset]).toISOString() };
  }, [preset, from, to]);

  const query = useCallback(
    (extra: Record<string, string> = {}) => {
      const p = new URLSearchParams(extra);
      if (userId) p.set("userId", userId);
      const r = range();
      if (r.from) p.set("from", r.from);
      if (r.to) p.set("to", r.to);
      return p.toString();
    },
    [userId, range],
  );

  const load = useCallback(
    async (before?: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await api<EventsResponse>("GET", `/files/${fileId}/events?${query(before ? { before } : {})}`);
        setEvents((prev) => (before ? [...prev, ...res.events] : res.events));
        setPeople((prev) => new Map([...prev, ...res.users.map((u) => [u.id, u] as const)]));
        setNext(res.nextBefore);
      } catch (e) {
        setError(e instanceof ApiRequestError ? e.message : "Could not load the history.");
      } finally {
        setLoading(false);
      }
    },
    [fileId, query],
  );

  // Reload when a filter changes; a diff for the old filter no longer applies.
  useEffect(() => {
    setDiff(null);
    if (preset === "custom" && (isNaN(Date.parse(from)) || isNaN(Date.parse(to)))) return;
    void load();
  }, [load, preset, from, to]);

  async function showDiff() {
    setDiffLoading(true);
    setError(null);
    try {
      setDiff(await api<HistoryDiffResponse>("GET", `/files/${fileId}/history-diff?${query()}`));
    } catch (e) {
      setDiff(null);
      setError(e instanceof ApiRequestError ? e.message : "Could not build the diff.");
    } finally {
      setDiffLoading(false);
    }
  }

  const person = (id: string): PersonDto =>
    people.get(id) ?? members.find((m) => m.id === id) ?? { id, name: "Unknown user", isGuest: false, color: "#666666", initials: "?" };
  const chosen = members.find((m) => m.id === userId);
  const field = "mt-1 rounded border border-slate-400 bg-transparent px-2 py-1 text-sm";

  return (
    <section aria-label="File history" className="flex h-full flex-col gap-4 overflow-y-auto p-4" data-testid="history-panel">
      <h2 className="text-lg font-semibold">
        History of <span className="font-mono">{fileName}</span>
      </h2>

      <form className="flex flex-wrap items-end gap-3" aria-label="History filters" onSubmit={(e) => e.preventDefault()}>
        <label className="flex flex-col text-xs">
          Person
          <select value={userId} onChange={(e) => setUserId(e.target.value)} className={field} data-testid="history-person">
            <option value="" className="text-black">Everyone</option>
            {members.map((m) => (
              <option key={m.id} value={m.id} className="text-black">
                {m.name}{m.isGuest ? " (guest)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-xs">
          Time range
          <select value={preset} onChange={(e) => setPreset(e.target.value as Preset)} className={field} data-testid="history-range">
            {(Object.keys(PRESET_LABEL) as Preset[]).map((k) => (
              <option key={k} value={k} className="text-black">{PRESET_LABEL[k]}</option>
            ))}
          </select>
        </label>
        {preset === "custom" && (
          <>
            <label className="flex flex-col text-xs">
              From
              <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} className={field} />
            </label>
            <label className="flex flex-col text-xs">
              To
              <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} className={field} />
            </label>
          </>
        )}
        <button
          type="button"
          onClick={showDiff}
          disabled={!userId || diffLoading}
          title={userId ? "" : "Choose a person to see what they changed"}
          className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
          data-testid="history-show-diff"
        >
          {diffLoading ? "Building diff…" : chosen ? `Show what ${chosen.name} changed` : "Show changes by this person"}
        </button>
      </form>

      <div aria-live="polite">{error && <p role="alert" className="text-sm text-red-700 dark:text-red-400" data-testid="history-error">{error}</p>}</div>

      {diff && (
        <div data-testid="history-diff" className="rounded border border-slate-300 p-3 dark:border-slate-700">
          <h3 className="mb-2 text-sm font-semibold">
            Changes by <PersonChip person={person(userId)} /> {diff.changes.length === 0 && "(none in this range)"}
          </h3>
          <ol className="flex flex-col gap-3">
            {diff.changes.map((c) => (
              <li key={c.eventId} data-testid="diff-change">
                <p className="text-xs text-slate-600 dark:text-slate-400">{formatAbs(c.at)}</p>
                {c.hunks.map((h, i) => (
                  <pre
                    key={i}
                    data-testid={h.kind === "add" ? "hunk-add" : "hunk-del"}
                    className={`my-0.5 overflow-x-auto whitespace-pre-wrap rounded px-2 py-0.5 font-mono text-xs ${
                      h.kind === "add" ? "bg-green-100 text-green-950 dark:bg-green-950 dark:text-green-100" : "bg-red-100 text-red-950 dark:bg-red-950 dark:text-red-100"
                    }`}
                  >
                    {/* sign and word as well as colour, and the line number */}
                    <span className="mr-2 select-none font-bold">{h.kind === "add" ? "+" : "−"}</span>
                    <span className="sr-only">{h.kind === "add" ? "Added" : "Removed"} at line {h.line}: </span>
                    <span aria-hidden="true" className="mr-2 text-slate-500">L{h.line}</span>
                    {h.text.replace(/\n$/, "") || "(blank line)"}
                    {h.truncated && " … (truncated)"}
                  </pre>
                ))}
              </li>
            ))}
          </ol>
          <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
            Replayed {diff.replayedEvents.toLocaleString()} recorded changes from the start of the file&apos;s history. Line numbers are as of that replay.
          </p>
        </div>
      )}

      <RestoreEvents fileId={fileId} role={role} onTreeChanged={onTreeChanged} />

      <div>
        <h3 className="mb-2 text-sm font-semibold">Timeline</h3>
        {events.length === 0 && !loading ? (
          <p className="text-sm text-slate-600 dark:text-slate-400" data-testid="history-empty">No recorded changes for this filter.</p>
        ) : (
          <ol className="flex flex-col divide-y divide-slate-200 dark:divide-slate-800" data-testid="history-events">
            {events.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-sm" data-testid="history-event">
                <time dateTime={e.endedAt} title={formatAbs(e.endedAt)} className="w-28 shrink-0 text-xs text-slate-600 dark:text-slate-400">
                  {formatAgo(Date.parse(e.endedAt))}
                </time>
                <PersonChip person={person(e.userId)} />
                <span className="text-xs">
                  <span className="text-green-800 dark:text-green-400">+{e.added.toLocaleString()}</span>{" "}
                  <span className="text-red-800 dark:text-red-400">−{e.removed.toLocaleString()}</span> characters
                  {(e.linesAdded > 0 || e.linesRemoved > 0) && ` · +${e.linesAdded}/−${e.linesRemoved} lines`}
                </span>
                {e.origin === "suggestion-accept" && (
                  <span className="rounded border border-slate-400 px-1.5 text-xs" data-testid="event-origin">accepted suggestion</span>
                )}
                {e.origin === "restore" && (
                  <span className="rounded border border-slate-400 px-1.5 text-xs" data-testid="event-origin">restore</span>
                )}
                {e.recovered && (
                  <span
                    className="rounded border border-amber-600 px-1.5 text-xs"
                    title="Their own record was lost in a crash; this text was re-sent by someone else and credited to them"
                    data-testid="event-recovered"
                  >
                    attributed after recovery
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
        {next && (
          <button type="button" onClick={() => load(next)} disabled={loading} className="mt-2 rounded border border-slate-400 px-3 py-1 text-sm hover:bg-slate-100 dark:hover:bg-slate-800">
            Load older changes
          </button>
        )}
      </div>
    </section>
  );
}

/** Restores of checkpoints (and undos of them) that touched this file, newest first, each undoable once. */
function RestoreEvents({ fileId, role, onTreeChanged }: { fileId: string; role: Role; onTreeChanged(): void }) {
  const restores = usePolled<RestoreEventDto[]>(`/files/${fileId}/restores`, 4000);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const rows = restores.data ?? [];
  if (rows.length === 0 && !message) return null;

  const undo = async (e: RestoreEventDto) => {
    setBusy(e.id);
    setMessage(null);
    try {
      const r = await api<RestoreResultDto>("POST", `/restores/${e.id}/undo`);
      setMessage({ ok: true, text: r.status === "already" ? "Already at that content. Nothing was changed." : "Undone." });
      onTreeChanged();
      await restores.reload();
    } catch (err) {
      setMessage({ ok: false, text: errorText(err) });
      await restores.reload();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-testid="restore-events-section">
      <h3 className="mb-2 text-sm font-semibold">Restores</h3>
      {message && (
        <p role={message.ok ? "status" : "alert"} className="mb-2 text-sm" data-testid="restore-message">
          {message.text}
        </p>
      )}
      <ol className="flex flex-col divide-y divide-slate-200 dark:divide-slate-800" data-testid="restore-events">
        {rows.map((e) => (
          <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-sm" data-testid="restore-event">
            <PersonChip person={e.user} />
            <span data-testid="restore-event-text">
              {e.kind === "undo" ? "undid the restore of checkpoint" : "restored checkpoint"} “{e.targetName}” ({e.scope === "project" ? "whole project" : (e.filePath ?? "one file")})
            </span>
            <span className="text-xs text-slate-600 dark:text-slate-400">
              ·{" "}
              <time dateTime={e.createdAt} title={formatAbs(e.createdAt)}>
                {formatAgo(Date.parse(e.createdAt))}
              </time>
            </span>
            {e.undone ? (
              <span className="rounded border border-slate-400 px-1.5 text-xs" data-testid="restore-undone">undone</span>
            ) : (
              can(role, "checkpoint:restore") && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => undo(e)}
                  className="rounded border border-slate-400 px-2 py-0.5 text-xs hover:bg-slate-100 disabled:opacity-50 dark:hover:bg-slate-800"
                  data-testid="restore-undo"
                >
                  Undo this restore
                </button>
              )
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
