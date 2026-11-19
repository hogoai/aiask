"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useWorkspaceAccount } from "./useWorkspaceAccount";
import { createClient } from "../../lib/supabase/client";
import { createProactiveController } from "../../lib/proactive/controller";
import { isObject, type PlannerTodo } from "../../lib/workspace/browser-records";
import { isInstant } from "../../lib/proactive/rules";
import { captureCreatedTaskAfterVerification, TASK_CREATED_EVENT } from "../../lib/proactive/creation";

export default function TaskCreationBridge() {
  const account = useWorkspaceAccount();
  return account.status === "ready" && account.userId ? <ScopedCreationBridge key={account.userId} ownerId={account.userId} /> : null;
}

function ScopedCreationBridge({ ownerId }: { ownerId: string }) {
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    const controller = createProactiveController({ getItem: key => window.localStorage.getItem(key), setItem: (key, value) => window.localStorage.setItem(key, value) },
      { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" });
    controller.setAccount({ status: "ready", userId: ownerId });
    const onCreated = (event: Event) => {
      const detail: unknown = (event as CustomEvent<unknown>).detail;
      if (!isObject(detail) || !isObject(detail.record) || typeof detail.record.id !== "string" || typeof detail.record.title !== "string" || !isInstant(detail.createdAt)) return;
      const source = { record: { ...detail.record } as PlannerTodo, createdAt: detail.createdAt };
      void (async () => {
        try {
          const result = await captureCreatedTaskAfterVerification(controller, source, async () => {
            const { data: { user }, error } = await createClient().auth.getUser();
            return active && !error && user?.id === ownerId ? user.id : null;
          });
          if (active) setNotice(result.status === "ready" ? "Your new task is connected for proactive follow-up." : "The task is saved. Connect it from My Workspace to enable proactive follow-up.");
        } catch { if (active) setNotice("The task is saved. Proactive follow-up can be connected from My Workspace."); }
      })();
    };
    window.addEventListener(TASK_CREATED_EVENT, onCreated);
    return () => { active = false; controller.setAccount({ status: "unavailable" }); window.removeEventListener(TASK_CREATED_EVENT, onCreated); };
  }, [ownerId]);
  return notice ? <p className="planner-sync-notice" role="status">{notice} <Link href="/workspace">Open My Workspace</Link></p> : null;
}
