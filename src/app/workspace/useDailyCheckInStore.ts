"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { decodeDailyState, type DailyState } from "../../lib/workspace/daily-check-in";

/** Legacy account-scoped data is retained for briefing consent and read-only reply history. */
export function useDailyCheckInStore(userId: string | null) {
  const demo = userId === null;
  const key = "aiask-daily-check-in:v1:" + (demo ? "demo" : "user:" + userId);
  const [state, setState] = useState<DailyState | null>(null);
  const [storageError, setStorageError] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    const refresh = () => {
      try { setState(decodeDailyState(window.localStorage.getItem(key), demo)); setStorageError(false); }
      catch { setStorageError(true); }
    };
    const onStorage = (event: StorageEvent) => { if (event.key === null || event.key === key) refresh(); };
    refresh();
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", refresh);
    return () => { controller.abort(); window.removeEventListener("storage", onStorage); window.removeEventListener("focus", refresh); };
  }, [demo, key]);
  const mutate = useCallback(async (update: (state: DailyState) => DailyState) => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return false;
    const write = () => {
      if (signal.aborted) return false;
      const before = decodeDailyState(window.localStorage.getItem(key), demo);
      const after = update(before);
      if (before === after) return false;
      window.localStorage.setItem(key, JSON.stringify(after));
      setState(after); setStorageError(false);
      return true;
    };
    try { return navigator.locks ? await navigator.locks.request(key, { signal }, write) : write(); }
    catch { if (!signal.aborted) setStorageError(true); return false; }
  }, [demo, key]);
  return { state, storageError, mutate, lifetime };
}
