"use client";

import { useState } from "react";
import { can, formatAgo, type Anchors, type PersonDto, type Role, type SuggestionDto, type ThreadDto } from "@collabcode/shared";
import { api } from "@/lib/client-api";
import { ApiRequestError } from "@/lib/client-api";
import { errorText, type useReviewData } from "@/lib/review";
import { formatAbs } from "@/lib/time";
import { PersonChip } from "./PersonChip";

export interface EditorSelection {
  from: number;
  to: number;
  text: string;
  line: number;
}

interface Props {
  fileId: string;
  role: Role;
  me: PersonDto;
  data: ReturnType<typeof useReviewData>;
  selection: EditorSelection | null;
  makeAnchors(from: number, to: number): Anchors | null;
  /** The text an anchor points at right now (null if it cannot be found). */
  rangeText(anchors: Anchors): string | null;
  /** Whose code the anchored range holds (from the blame data), biggest share first. */
  authorsOf(anchors: Anchors): { person: PersonDto | null; chars: number }[] | null;
  onReveal(anchors: Anchors): void;
}

type Tab = "suggestions" | "comments";
type Draft = { kind: "comment" | "suggest"; anchors: Anchors; excerpt: string; original: string; line: number };

const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n)}…` : s);
const btn = "rounded border px-2 py-0.5 text-xs hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50";
const textarea = "w-full rounded border border-slate-400 bg-transparent p-1.5 text-sm";

/**
 * Suggestions and inline comments of the open file. Everyone who can see the file can read them;
 * what you can DO comes from your role (the server enforces the same rules).
 */
export function ReviewSidebar({ fileId, role, me, data, selection, makeAnchors, rangeText, authorsOf, onReveal }: Props) {
  const [tab, setTab] = useState<Tab>("suggestions");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);

  const canComment = can(role, "comment:create");
  const canSuggest = can(role, "suggestion:create");
  const openSuggestions = data.suggestions.filter((s) => s.status === "OPEN");
  const doneSuggestions = data.suggestions.filter((s) => s.status !== "OPEN");
  const openThreads = data.threads.filter((t) => !t.resolvedAt);
  const resolvedThreads = data.threads.filter((t) => t.resolvedAt);

  const start = (kind: Draft["kind"]) => {
    if (!selection) return;
    const anchors = makeAnchors(selection.from, selection.to);
    if (!anchors) return;
    setError(null);
    setDraft({ kind, anchors, excerpt: selection.text, original: selection.text, line: selection.line });
    setText(kind === "suggest" ? selection.text : "");
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
      await data.reloadAll();
    } finally {
      setBusy(false);
    }
  };

  const submitDraft = () =>
    run(async () => {
      if (!draft) return;
      if (draft.kind === "comment") {
        data.setThread(await api<ThreadDto>("POST", `/files/${fileId}/threads`, { anchors: draft.anchors, body: text }));
        setTab("comments");
      } else {
        data.setSuggestion(await api<SuggestionDto>("POST", `/files/${fileId}/suggestions`, { anchors: draft.anchors, newText: text }));
        setTab("suggestions");
      }
      setDraft(null);
      setText("");
    });

  const decide = (s: SuggestionDto, what: "accept" | "reject") =>
    run(async () => {
      try {
        data.setSuggestion(await api<SuggestionDto>("POST", `/suggestions/${s.id}/${what}`));
      } catch (e) {
        if (e instanceof ApiRequestError && e.code === "SUGGESTION_STALE") {
          setError("The text this suggestion was about has been deleted, so it can no longer be applied.");
          await data.reloadAll();
          return;
        }
        throw e;
      }
    });

  return (
    <aside aria-label="Review" data-testid="review-sidebar" className="flex min-h-0 w-80 shrink-0 flex-col border-l border-slate-200 text-sm dark:border-slate-800">
      <div role="tablist" aria-label="Review views" className="flex border-b border-slate-200 dark:border-slate-800">
        {(["suggestions", "comments"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            data-testid={`review-tab-${t}`}
            className={`flex-1 px-2 py-1.5 text-xs ${tab === t ? "border-b-2 border-blue-600 font-semibold" : "text-slate-600 dark:text-slate-400"}`}
          >
            {t === "suggestions" ? `Suggestions (${openSuggestions.length})` : `Comments (${openThreads.length})`}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-2 border-b border-slate-200 p-2 dark:border-slate-800" data-testid="selection-box">
        {selection && selection.text.length > 0 ? (
          <p className="text-xs text-slate-600 dark:text-slate-400">
            Selected: <q className="font-mono">{clip(selection.text, 60)}</q>
          </p>
        ) : (
          <p className="text-xs text-slate-600 dark:text-slate-400">
            {selection ? `Cursor on line ${selection.line}. Select text to comment on or suggest a change to it.` : "Click in the text, or select some, to comment or suggest."}
          </p>
        )}
        {(canComment || canSuggest) && !draft && (
          <div className="flex gap-2">
            {canComment && (
              <button type="button" className={btn} disabled={!selection} onClick={() => start("comment")} data-testid="btn-comment">
                Comment
              </button>
            )}
            {canSuggest && (
              <button type="button" className={btn} disabled={!selection} onClick={() => start("suggest")} data-testid="btn-suggest">
                Suggest change
              </button>
            )}
          </div>
        )}
        {!canComment && !canSuggest && <p className="text-xs">You can read suggestions and comments but not add them.</p>}
        {draft && (
          <form
            className="flex flex-col gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              void submitDraft();
            }}
            data-testid="draft-form"
          >
            <label className="text-xs font-semibold" htmlFor="draft-text">
              {draft.kind === "comment" ? `Comment on line ${draft.line}` : draft.original ? "Replace the selected text with" : `Insert at line ${draft.line}`}
            </label>
            <textarea id="draft-text" className={`${textarea} font-mono`} rows={draft.kind === "suggest" ? 4 : 3} value={text} onChange={(e) => setText(e.target.value)} data-testid="draft-text" />
            <div className="flex gap-2">
              <button type="submit" className={`${btn} border-blue-700 bg-blue-600 text-white hover:bg-blue-700`} disabled={busy || (draft.kind === "comment" && text.trim() === "")} data-testid="draft-submit">
                {draft.kind === "comment" ? "Post comment" : "Suggest"}
              </button>
              <button type="button" className={btn} onClick={() => setDraft(null)}>
                Cancel
              </button>
            </div>
          </form>
        )}
        {error && (
          <p role="alert" className="text-xs text-red-700 dark:text-red-400" data-testid="review-error">
            {error}
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {tab === "suggestions" ? (
          <div className="flex flex-col gap-2">
            {openSuggestions.length === 0 && <p className="text-xs text-slate-600 dark:text-slate-400" data-testid="no-suggestions">No open suggestions.</p>}
            {openSuggestions.map((s) => {
              const current = rangeText(s.anchors);
              const drifted = current !== null && current !== s.originalText;
              const isMine = s.author.id === me.id;
              const authors = authorsOf(s.anchors);
              const onMyCode = !isMine && !!authors?.some((a) => a.person?.id === me.id);
              return (
                <article
                  key={s.id}
                  className={`flex flex-col gap-1 rounded border p-2 ${onMyCode ? "border-blue-600 bg-blue-50 dark:bg-blue-950" : "border-slate-300 dark:border-slate-700"}`}
                  data-testid="suggestion-item"
                  data-on-my-code={onMyCode ? "true" : "false"}
                >
                  <header className="flex items-center justify-between gap-2">
                    <PersonChip person={s.author} />
                    <time dateTime={s.createdAt} title={formatAbs(s.createdAt)} className="text-xs text-slate-600 dark:text-slate-400">
                      {formatAgo(Date.parse(s.createdAt))}
                    </time>
                  </header>
                  <p className="text-xs" data-testid="suggestion-target">
                    {onMyCode && <span className="mr-1.5 rounded bg-blue-700 px-1.5 py-0.5 font-semibold text-white" data-testid="suggestion-on-mine">On your code</span>}
                    {targetSentence(s.author, authors, me)}
                  </p>
                  <button type="button" className="text-left" onClick={() => onReveal(s.anchors)} title="Show in the editor" data-testid="suggestion-reveal">
                    {s.originalText ? (
                      <del className="block whitespace-pre-wrap break-words font-mono text-xs text-red-800 dark:text-red-300" data-testid="suggestion-old">
                        {clip(s.originalText, 300)}
                      </del>
                    ) : (
                      <span className="text-xs italic text-slate-600 dark:text-slate-400">Insert:</span>
                    )}
                    <ins className="block whitespace-pre-wrap break-words font-mono text-xs text-green-800 no-underline dark:text-green-300" data-testid="suggestion-new">
                      {s.newText ? clip(s.newText, 300) : <em>(delete)</em>}
                    </ins>
                  </button>
                  {drifted && <p className="text-xs text-amber-800 dark:text-amber-400">The text has changed since this was suggested.</p>}
                  <div className="flex gap-2">
                    {can(role, "suggestion:resolve") && !isMine && (
                      <button type="button" className={`${btn} border-green-700`} disabled={busy} onClick={() => decide(s, "accept")} data-testid="suggestion-accept">
                        Accept
                      </button>
                    )}
                    {(can(role, "suggestion:resolve") || isMine) && (
                      <button type="button" className={btn} disabled={busy} onClick={() => decide(s, "reject")} data-testid="suggestion-reject">
                        {isMine ? "Withdraw" : "Reject"}
                      </button>
                    )}
                  </div>
                  {isMine && can(role, "suggestion:resolve") && (
                    <p className="text-xs text-slate-600 dark:text-slate-400" data-testid="self-accept-note">
                      Someone else has to accept your suggestion. You can withdraw it.
                    </p>
                  )}
                </article>
              );
            })}
            {doneSuggestions.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer">Handled ({doneSuggestions.length})</summary>
                <ul className="mt-1 flex flex-col gap-1" data-testid="handled-suggestions">
                  {doneSuggestions.map((s) => (
                    <li key={s.id} className="rounded border border-slate-300 p-1.5 dark:border-slate-700">
                      <span className="font-semibold">{s.status === "ACCEPTED" ? "Accepted" : s.status === "REJECTED" ? "Rejected" : "Out of date"}</span>
                      {s.resolvedBy && <> by {s.resolvedBy.name}</>}: <q className="font-mono">{clip(s.newText, 60) || "(delete)"}</q> from {s.author.name}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {openThreads.length === 0 && <p className="text-xs text-slate-600 dark:text-slate-400" data-testid="no-threads">No open comments.</p>}
            {openThreads.map((t) => (
              <Thread key={t.id} t={t} role={role} me={me} busy={busy} rangeText={rangeText} onReveal={onReveal} run={run} data={data} />
            ))}
            {resolvedThreads.length > 0 && (
              <div>
                <label className="flex items-center gap-1.5 text-xs">
                  <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} data-testid="show-resolved" />
                  Show resolved ({resolvedThreads.length})
                </label>
                {showResolved && (
                  <div className="mt-2 flex flex-col gap-2" data-testid="resolved-threads">
                    {resolvedThreads.map((t) => (
                      <Thread key={t.id} t={t} role={role} me={me} busy={busy} rangeText={rangeText} onReveal={onReveal} run={run} data={data} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

/** "Alice suggested a change to Bob's code" / "...to their own code" / "...to your code". */
function targetSentence(suggester: PersonDto, authors: { person: PersonDto | null; chars: number }[] | null, me: PersonDto): string {
  const first = suggester.name;
  if (!authors || authors.length === 0) return `${first} suggested a change`;
  const names = authors.map((a) => {
    if (a.person === null) return "code with no recorded author";
    if (a.person.id === me.id) return "you";
    if (a.person.id === suggester.id) return "themselves";
    return a.person.name;
  });
  const only = authors.length === 1 ? authors[0]!.person : undefined;
  if (only && only.id === suggester.id) return `${first} suggested a change to their own code`;
  if (only === null) return `${first} suggested a change to code with no recorded author`;
  const shown = names.filter((n) => n !== "code with no recorded author");
  const list = shown.length <= 1 ? shown.join("") : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
  const possessive = list === "you" ? "your" : list.endsWith("s") ? `${list}'` : `${list}'s`;
  return `${first} suggested a change to ${possessive} code`;
}

function Thread({
  t,
  role,
  me,
  busy,
  rangeText,
  onReveal,
  run,
  data,
}: {
  t: ThreadDto;
  role: Role;
  me: PersonDto;
  busy: boolean;
  rangeText(a: Anchors): string | null;
  onReveal(a: Anchors): void;
  run(fn: () => Promise<void>): Promise<void>;
  data: ReturnType<typeof useReviewData>;
}) {
  const [reply, setReply] = useState("");
  const quote = rangeText(t.anchors) ?? t.quote;
  const canResolve = can(role, "comment:resolve") || (t.createdBy.id === me.id && can(role, "comment:create"));
  return (
    <article className={`flex flex-col gap-1.5 rounded border p-2 ${t.resolvedAt ? "border-slate-300 opacity-75 dark:border-slate-700" : "border-yellow-600"}`} data-testid="thread-item" data-resolved={t.resolvedAt ? "true" : "false"}>
      <button type="button" className="text-left text-xs text-slate-600 dark:text-slate-400" onClick={() => onReveal(t.anchors)} title="Show in the editor">
        {quote ? <q className="font-mono">{clip(quote, 80)}</q> : "At a position in the file"}
      </button>
      <ol className="flex flex-col gap-1.5">
        {t.comments.map((c) => (
          <li key={c.id} className="flex flex-col gap-0.5" data-testid="comment">
            <span className="flex items-center justify-between gap-2">
              <PersonChip person={c.author} />
              <time dateTime={c.createdAt} title={formatAbs(c.createdAt)} className="text-xs text-slate-600 dark:text-slate-400">
                {formatAgo(Date.parse(c.createdAt))}
              </time>
            </span>
            <p className="whitespace-pre-wrap break-words" data-testid="comment-body">{c.body}</p>
          </li>
        ))}
      </ol>
      {t.resolvedAt && t.resolvedBy && <p className="text-xs text-slate-600 dark:text-slate-400">Resolved by {t.resolvedBy.name}</p>}
      {can(role, "comment:create") && (
        <form
          className="flex flex-col gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (!reply.trim()) return;
            void run(async () => {
              data.setThread(await api<ThreadDto>("POST", `/threads/${t.id}/comments`, { body: reply }));
              setReply("");
            });
          }}
        >
          <label className="sr-only" htmlFor={`reply-${t.id}`}>Reply</label>
          <textarea id={`reply-${t.id}`} className={textarea} rows={2} placeholder="Reply…" value={reply} onChange={(e) => setReply(e.target.value)} data-testid="thread-reply-input" />
          <button type="submit" className={`${btn} self-start`} disabled={busy || !reply.trim()} data-testid="thread-reply-send">
            Reply
          </button>
        </form>
      )}
      {canResolve && (
        <button
          type="button"
          className={`${btn} self-start`}
          disabled={busy}
          onClick={() => run(async () => data.setThread(await api<ThreadDto>("POST", `/threads/${t.id}/${t.resolvedAt ? "reopen" : "resolve"}`)))}
          data-testid={t.resolvedAt ? "thread-reopen" : "thread-resolve"}
        >
          {t.resolvedAt ? "Reopen" : "Resolve"}
        </button>
      )}
    </article>
  );
}
