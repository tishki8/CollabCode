"use client";

import { useCallback, useEffect, useState } from "react";
import { can, formatAgo, type CheckpointDetailDto, type CheckpointDto, type RestoreResultDto, type Role } from "@collabcode/shared";
import { api } from "@/lib/client-api";
import { errorText } from "@/lib/review";
import { formatAbs } from "@/lib/time";
import { PersonChip } from "./PersonChip";

const btn = "rounded border px-2 py-1 text-xs hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50";

type Confirm = { checkpoint: CheckpointDto; scope: "project" | "file" } | null;

/**
 * Named checkpoints: a snapshot of every file. Restoring (owner only) is a normal edit credited to
 * whoever restores, and a safety checkpoint is taken first, so a restore can itself be undone.
 */
export function CheckpointsPanel({
  projectId,
  role,
  activeFile,
  onTreeChanged,
}: {
  projectId: string;
  role: Role;
  activeFile: { id: string; name: string } | null;
  onTreeChanged(): void;
}) {
  const [items, setItems] = useState<CheckpointDto[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [detail, setDetail] = useState<CheckpointDetailDto | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await api<CheckpointDto[]>("GET", `/projects/${projectId}/checkpoints`));
    } catch (e) {
      setError(errorText(e, "Could not load checkpoints"));
    }
  }, [projectId]);
  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const cp = await api<CheckpointDto>("POST", `/projects/${projectId}/checkpoints`, { name });
      setName("");
      setNotice(`Checkpoint “${cp.name}” saved (${cp.fileCount} file${cp.fileCount === 1 ? "" : "s"}).`);
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    if (!confirm) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = confirm.scope === "file" && activeFile ? { fileId: activeFile.id } : {};
      const r = await api<RestoreResultDto>("POST", `/checkpoints/${confirm.checkpoint.id}/restore`, body);
      if (r.status === "already") {
        setNotice("Already at this checkpoint. Nothing was changed.");
        setConfirm(null);
        return;
      }
      const parts = [`${r.restored} file${r.restored === 1 ? "" : "s"} restored`];
      if (r.recreated) parts.push(`${r.recreated} brought back`);
      if (r.removed) parts.push(`${r.removed} removed`);
      setNotice(`Restored “${confirm.checkpoint.name}”: ${parts.join(", ")}. You can undo this from the History tab.`);
      setConfirm(null);
      onTreeChanged();
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const canCreate = can(role, "checkpoint:create");
  const canRestore = can(role, "checkpoint:restore");

  return (
    <section aria-label="Checkpoints" className="flex h-full flex-col gap-4 overflow-y-auto p-4" data-testid="checkpoints-panel">
      <div>
        <h2 className="text-lg font-semibold">Checkpoints</h2>
        <p className="text-sm text-slate-600 dark:text-slate-400">A named snapshot of every file in the project. Replay can start from any of them.</p>
      </div>

      {canCreate ? (
        <form onSubmit={create} className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="checkpoint-name" className="text-sm font-medium">Checkpoint name</label>
            <input id="checkpoint-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className="w-72 rounded border border-slate-400 bg-transparent px-2 py-1 text-sm" />
          </div>
          <button type="submit" disabled={busy || !name.trim()} className="rounded border border-blue-700 bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700 disabled:opacity-50" data-testid="checkpoint-create">
            Create checkpoint
          </button>
        </form>
      ) : (
        <p className="text-sm text-slate-600 dark:text-slate-400">Editors and the owner can create checkpoints.</p>
      )}

      {notice && <p role="status" className="rounded border border-green-700 p-2 text-sm" data-testid="checkpoint-notice">{notice}</p>}
      {error && <p role="alert" className="rounded border border-red-700 p-2 text-sm text-red-800 dark:text-red-300" data-testid="checkpoint-error">{error}</p>}

      {confirm && (
        <div role="alertdialog" aria-label="Confirm restore" className="rounded border border-amber-600 p-3 text-sm" data-testid="restore-confirm">
          <p>
            {confirm.scope === "project"
              ? <>Restore the <strong>whole project</strong> to “{confirm.checkpoint.name}”? Files created since then will be removed and deleted files brought back.</>
              : <>Restore <strong>{activeFile?.name}</strong> to “{confirm.checkpoint.name}”?</>}{" "}
            The current content is saved automatically first (you can undo from the History tab), and the restore is recorded as your edit.
          </p>
          <div className="mt-2 flex gap-2">
            <button type="button" className={`${btn} border-amber-700`} disabled={busy} onClick={restore} data-testid="restore-confirm-yes">
              Restore
            </button>
            <button type="button" className={btn} onClick={() => setConfirm(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {items.length === 0 ? (
        <p className="text-sm text-slate-600 dark:text-slate-400" data-testid="checkpoints-empty">No checkpoints yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-slate-200 dark:divide-slate-800" data-testid="checkpoint-list">
          {items.map((c) => (
            <li key={c.id} className="flex flex-col gap-1 py-2" data-testid="checkpoint-item">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <strong data-testid="checkpoint-name">{c.name}</strong>
                <span className="text-xs text-slate-600 dark:text-slate-400">
                  <time dateTime={c.createdAt} title={formatAbs(c.createdAt)}>{formatAgo(Date.parse(c.createdAt))}</time> · {c.fileCount} file{c.fileCount === 1 ? "" : "s"}
                </span>
                <PersonChip person={c.createdBy} />
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={btn}
                  onClick={async () => setDetail(detail?.id === c.id ? null : await api<CheckpointDetailDto>("GET", `/checkpoints/${c.id}`))}
                  aria-expanded={detail?.id === c.id}
                >
                  Files
                </button>
                {canRestore && (
                  <>
                    <button type="button" className={btn} onClick={() => setConfirm({ checkpoint: c, scope: "project" })} data-testid="restore-project">
                      Restore project
                    </button>
                    {activeFile && (
                      <button type="button" className={btn} onClick={() => setConfirm({ checkpoint: c, scope: "file" })} data-testid="restore-file">
                        Restore {activeFile.name}
                      </button>
                    )}
                  </>
                )}
              </div>
              {detail?.id === c.id && (
                <ul className="ml-2 list-disc pl-4 text-xs font-mono">
                  {detail.files.map((f) => (
                    <li key={f.fileId}>{f.path}{f.deleted && " (deleted since)"}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {!canRestore && items.length > 0 && <p className="text-xs text-slate-600 dark:text-slate-400">Only the project owner can restore a checkpoint.</p>}
    </section>
  );
}
