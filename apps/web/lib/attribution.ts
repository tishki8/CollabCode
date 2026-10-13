"use client";

import { useEffect, useRef, useState } from "react";
import { AttributionIndex, type AttributionResponse, type PersonDto } from "@collabcode/shared";
import { api } from "./client-api";

const POLL_MS = 3000;

/**
 * Who wrote what in a file: the server's attribution ranges, fetched once and then incrementally
 * ("everything after event N") while `enabled`. Joined with the live text in the browser, so
 * hovering costs nothing and the result always matches what is on screen.
 * Text other people just typed shows up after their batch is saved (a few seconds).
 */
export function useAttribution(fileId: string, enabled: boolean) {
  const index = useRef(new AttributionIndex()).current;
  const users = useRef(new Map<string, PersonDto>()).current;
  const after = useRef<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      if (!document.hidden) {
        try {
          for (;;) {
            const q = after.current ? `?after=${after.current}` : "";
            const res = await api<AttributionResponse>("GET", `/files/${fileId}/attribution${q}`);
            res.users.forEach((u) => users.set(u.id, u));
            index.add(res.ranges.map(([client, start, end, u, at, , recovered]) => ({ client, start, end, user: res.users[u]!.id, at, recovered: recovered === 1 })));
            if (res.lastEventId) after.current = res.lastEventId;
            if (res.ranges.length > 0 || res.users.length > 0) setVersion((v) => v + 1);
            if (!res.hasMore) break;
          }
        } catch {
          /* transient (offline, API restarting): try again next tick */
        }
      }
      if (!stopped) timer = setTimeout(load, POLL_MS);
    };
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [fileId, enabled, index, users]);

  return { index, users, version };
}
