"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LANGUAGES, LANGUAGE_INFO, type Language } from "@collabcode/shared";
import { api } from "@/lib/client-api";

export function CreateProjectForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [language, setLanguage] = useState<Language>("PYTHON");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { id } = await api<{ id: string }>("POST", "/projects", { name, language });
      router.push(`/p/${id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3" aria-label="Create a project">
      <label className="flex flex-col text-sm">
        Project name
        <input
          required
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded border border-slate-400 bg-transparent px-3 py-2"
        />
      </label>
      <label className="flex flex-col text-sm">
        Language
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value as Language)}
          className="rounded border border-slate-400 bg-transparent px-3 py-2"
        >
          {LANGUAGES.map((l) => (
            <option key={l} value={l} className="text-black">
              {LANGUAGE_INFO[l].label}
            </option>
          ))}
        </select>
      </label>
      <button
        disabled={busy}
        className="rounded-md bg-blue-700 px-4 py-2 font-medium text-white hover:bg-blue-800 disabled:opacity-60"
      >
        Create project
      </button>
      {error && (
        <p role="alert" className="w-full text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </form>
  );
}
