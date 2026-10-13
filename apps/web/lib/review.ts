"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SuggestionDto, ThreadDto } from "@collabcode/shared";
import { ApiRequestError, api } from "./client-api";

const POLL_MS = 2500;
const NO_SUGGESTIONS: SuggestionDto[] = [];
const NO_THREADS: ThreadDto[] = [];

/** Fetch `path` now and then every few seconds while the tab is visible. */
export function usePolled<T>(path: string, ms = POLL_MS) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const reload = useCallback(async () => {
    try {
      const res = await api<T>("GET", path);
      if (alive.current) {
        setData(res);
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError(e instanceof ApiRequestError ? e.message : "Could not load");
    }
  }, [path]);

  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (!document.hidden) await reload();
      if (alive.current) timer = setTimeout(tick, ms);
    };
    void tick();
    return () => {
      alive.current = false;
      clearTimeout(timer);
    };
  }, [reload, ms]);

  return { data, error, reload, setData };
}

/** Suggestions and comment threads of one file, kept fresh by polling and updated at once after your own actions. */
export function useReviewData(fileId: string) {
  const suggestions = usePolled<SuggestionDto[]>(`/files/${fileId}/suggestions`);
  const threads = usePolled<ThreadDto[]>(`/files/${fileId}/threads`);
  return {
    suggestions: suggestions.data ?? NO_SUGGESTIONS,
    threads: threads.data ?? NO_THREADS,
    reloadAll: async () => {
      await Promise.all([suggestions.reload(), threads.reload()]);
    },
    setThread: (t: ThreadDto) => threads.setData((cur) => (cur ? (cur.some((x) => x.id === t.id) ? cur.map((x) => (x.id === t.id ? t : x)) : [...cur, t]) : [t])),
    setSuggestion: (s: SuggestionDto) =>
      suggestions.setData((cur) => (cur ? (cur.some((x) => x.id === s.id) ? cur.map((x) => (x.id === s.id ? s : x)) : [s, ...cur]) : [s])),
  };
}

export const errorText = (e: unknown, fallback = "Something went wrong") => (e instanceof ApiRequestError ? e.message : fallback);
