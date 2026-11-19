"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { AIConversation, ConversationMessage } from "../../lib/ai/conversations";
import { PARTNER_ROLE_IDS } from "../../lib/ai/contracts";
import { isObject } from "../../lib/workspace/browser-records";
import { createProactiveController } from "../../lib/proactive/controller";
import { WORKFLOW_UPDATED } from "../../lib/proactive/storage";
import { createClient } from "../../lib/supabase/client";
import { useWorkspaceAccount } from "./useWorkspaceAccount";
import "./workflow-connection.css";

type SourceLink = { type: "calendar" | "conversation"; id: string };

function isPartnerRole(value: unknown): value is AIConversation["partnerRole"] {
  return typeof value === "string" && PARTNER_ROLE_IDS.some(role => role === value);
}

function parseConversation(value: unknown, id: string): AIConversation | null {
  if (!isObject(value) || !isObject(value.conversation)) return null;
  const conversation = value.conversation;
  if (conversation.id !== id || typeof conversation.title !== "string" ||
    (conversation.ideaId !== null && typeof conversation.ideaId !== "string") ||
    (conversation.projectId !== null && typeof conversation.projectId !== "string") ||
    !isPartnerRole(conversation.partnerRole) || typeof conversation.isFavorite !== "boolean" ||
    typeof conversation.createdAt !== "string" || typeof conversation.updatedAt !== "string" ||
    !Array.isArray(conversation.messages)) return null;
  const messages: ConversationMessage[] = [];
  for (const message of conversation.messages) {
    if (!isObject(message) || typeof message.id !== "string" ||
      (message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string" ||
      !["idea", "follow_up", "structured_response"].includes(String(message.kind)) ||
      !["pending", "completed", "failed", "save_failed"].includes(String(message.status)) ||
      typeof message.createdAt !== "string" || !isObject(message.metadata)) return null;
    messages.push({
      id: message.id, role: message.role, content: message.content,
      kind: message.kind as ConversationMessage["kind"], status: message.status as ConversationMessage["status"],
      createdAt: message.createdAt, metadata: message.metadata,
    });
  }
  return {
    id: conversation.id, title: conversation.title,
    ideaId: conversation.ideaId, projectId: conversation.projectId,
    partnerRole: conversation.partnerRole, isFavorite: conversation.isFavorite,
    createdAt: conversation.createdAt, updatedAt: conversation.updatedAt, messages,
  };
}

export function WorkflowConnect({ type, id }: SourceLink) {
  const account = useWorkspaceAccount();
  if (account.status !== "ready" || !account.userId) {
    return <span className="workflow-connect"><Link href="/login?next=%2Fworkspace">Sign in to link follow-up</Link></span>;
  }
  return <OwnedWorkflowConnect key={`${account.userId}:${type}:${id}`} ownerId={account.userId} type={type} id={id} />;
}

function OwnedWorkflowConnect({ ownerId, type, id }: SourceLink & { ownerId: string }) {
  const controller = useMemo(() => createProactiveController({
    getItem: key => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
  }, { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" }), []);
  const alive = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [ownershipConfirmed, setOwnershipConfirmed] = useState(false);

  useEffect(() => {
    alive.current = true;
    controller.setAccount({ status: "ready", userId: ownerId });
    return () => {
      alive.current = false;
      controller.setAccount({ status: "unavailable" });
    };
  }, [controller, ownerId]);

  async function connect() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const before = controller.snapshot();
      if (before.status !== "ready") throw new Error(`Follow-up storage is unavailable (${before.status}).`);
      if (!navigator.locks) throw new Error("This browser cannot safely connect follow-ups.");
      if (type === "calendar") {
        if (!ownershipConfirmed) throw new Error("Confirm that this Calendar event belongs to you before linking it.");
        const { data, error } = await createClient().auth.getUser();
        if (!alive.current || error || data.user?.id !== ownerId) throw new Error("Account changed. Reopen this page.");
        const result = await navigator.locks.request("aiask-planner", () => controller.connectCalendar(before.token, id, ownershipConfirmed));
        if (result.status !== "ready") throw new Error(`Could not connect this Calendar event (${result.status}).`);
      } else {
        const verifyAccount = async () => {
          const { data, error } = await createClient().auth.getUser();
          if (!alive.current || error || data.user?.id !== ownerId) throw new Error("Account changed. Reopen this page.");
        };
        await verifyAccount();
        const response = await fetch(`/api/ai/conversations/${encodeURIComponent(id)}`);
        const payload: unknown = await response.json();
        const conversation = parseConversation(payload, id);
        if (!response.ok || !conversation) throw new Error("This AI Team conversation could not be connected.");
        await verifyAccount();
        const result = await controller.connectConversation(before.token, conversation);
        if (result.status !== "ready") throw new Error(`Could not connect this conversation (${result.status}).`);
      }
      if (!alive.current) return;
      setMessage("Connected. Continue in My Workspace.");
      window.dispatchEvent(new Event(WORKFLOW_UPDATED));
    } catch (error) {
      if (alive.current) setMessage(error instanceof Error ? error.message : "Could not connect this follow-up.");
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return <span className="workflow-connect">
    {type === "calendar" && <label><input type="checkbox" checked={ownershipConfirmed} disabled={busy} onChange={event => setOwnershipConfirmed(event.target.checked)} /> This Calendar event belongs to me.</label>}
    <button type="button" disabled={busy || (type === "calendar" && !ownershipConfirmed)} onClick={() => void connect()}>{busy ? "Connecting…" : `Link ${type === "conversation" ? "AI Team" : type} follow-up`}</button>
    {message && <small role="status">{message}{message.startsWith("Connected") && <> <Link href="/workspace">Open Workspace</Link></>}</small>}
  </span>;
}
