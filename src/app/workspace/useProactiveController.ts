"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createProactiveController, type ProactiveSnapshot } from "../../lib/proactive/controller";
import { PLANNER_KEY } from "../../lib/workspace/browser-records";
import { WORKFLOW_UPDATED, workflowStorageKey, type WorkflowSessionToken, type WorkflowStorageResult } from "../../lib/proactive/storage";

export function useProactiveController(ownerId: string) {
  const [controller] = useState(() => createProactiveController({
    getItem: key => window.localStorage.getItem(key), setItem: (key, value) => window.localStorage.setItem(key, value),
  }, { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" }));
  const [view, setView] = useState<ProactiveSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const lifetime = useRef(false);
  const pending = useRef(false);
  const refreshing = useRef(false);
  const epoch = useRef(0);

  const refresh = useCallback(async () => {
    if (!lifetime.current || pending.current || refreshing.current) return;
    const requestEpoch = epoch.current;
    const before = controller.snapshot();
    if (before.status !== "ready") { setView(before); return; }
    refreshing.current = true;
    try {
      const result = await controller.refresh(before.token);
      if (lifetime.current && epoch.current === requestEpoch) setView(result.status === "ready" ? controller.snapshot() : result);
    } finally { if (epoch.current === requestEpoch) refreshing.current = false; }
  }, [controller]);

  useEffect(() => {
    lifetime.current = true;
    epoch.current++;
    pending.current = false;
    refreshing.current = false;
    controller.setAccount({ status: "ready", userId: ownerId });
    setView(controller.snapshot());
    void refresh();
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === PLANNER_KEY || event.key === workflowStorageKey(ownerId)) void refresh();
    };
    const onVisible = () => { if (!document.hidden) void refresh(); };
    window.addEventListener("storage", onStorage);
    window.addEventListener(WORKFLOW_UPDATED, onVisible);
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(onVisible, 60_000);
    return () => {
      lifetime.current = false;
      epoch.current++;
      controller.setAccount({ status: "unavailable" });
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(WORKFLOW_UPDATED, onVisible);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [controller, ownerId, refresh]);

  useEffect(() => {
    if (view?.status !== "ready" || !view.state.settings.enabled) return;
    const earliest = view.state.cases.map(item => item.nextFollowUpAt).filter((value): value is string => Boolean(value))
      .map(Date.parse).filter(value => value > Date.now()).sort((a, b) => a - b)[0];
    if (!earliest) return;
    const timer = window.setTimeout(() => void refresh(), Math.min(2_147_483_647, Math.max(1, earliest - Date.now())));
    return () => window.clearTimeout(timer);
  }, [view, refresh]);

  const run = useCallback(async (action: (token: WorkflowSessionToken) => Promise<WorkflowStorageResult>, message = "Workflow updated.") => {
    if (!lifetime.current || pending.current) return false;
    const requestEpoch = epoch.current;
    const before = controller.snapshot();
    if (before.status !== "ready") { setView(before); return false; }
    pending.current = true;
    setBusy(true);
    setNotice("");
    try {
      const result = await action(before.token);
      if (!lifetime.current || epoch.current !== requestEpoch) return false;
      if (result.status !== "ready") { setView(controller.snapshot()); setNotice(result.status === "invalid_update" ? "This task or workflow changed. Review the source and try again." : "The workflow could not be saved. Your previous data is preserved."); return false; }
      setView(controller.snapshot());
      setNotice(message);
      return true;
    } catch (error) {
      if (lifetime.current && epoch.current === requestEpoch) setNotice(error instanceof Error && error.message === "ambiguous_local_time"
        ? "This time occurs twice when clocks change. Choose a different local time."
        : error instanceof Error && error.message === "nonexistent_local_time" ? "This local time does not exist when clocks change. Choose another time."
        : "Choose a valid future time and review the task before continuing.");
      return false;
    } finally {
      if (epoch.current === requestEpoch) {
        pending.current = false;
        if (lifetime.current) { setBusy(false); void refresh(); }
      }
    }
  }, [controller, refresh]);
  return { controller, view, busy, notice, setNotice, run, refresh };
}
