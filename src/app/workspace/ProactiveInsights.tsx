"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Clock3, MessageCircleQuestion, Sparkles } from "lucide-react";
import type { ProactiveCase, WorkflowCommand } from "../../lib/proactive/contracts";
import type { WorkflowAccountScope } from "../../lib/proactive/storage";
import type { TaskReview } from "../../lib/proactive/sources";
import { workflowSuggestion } from "../../lib/proactive/interfaces";
import { workflowRoleNames, type WorkflowCoachRequest, type WorkflowConversationLink } from "../../lib/proactive/coach";
import { formatWorkflowTime, localFollowUpInstant } from "../../lib/proactive/time";
import { isTimeZone } from "../../lib/proactive/rules";
import { useProactiveController } from "./useProactiveController";
import "./proactive-insights.css";

type Props = {
  account: WorkflowAccountScope;
  onDiscuss: (request: WorkflowCoachRequest) => void;
  conversationLink: WorkflowConversationLink | null;
};
const statusText: Record<ProactiveCase["workflowStatus"], string> = {
  pending: "Queued", waiting_for_answer: "Waiting for your answer", answered: "Answer saved",
  waiting_for_followup: "Follow-up scheduled", snoozed: "Snoozed", dismissed: "Follow-up dismissed", resolved: "Follow-up resolved",
};

export default function ProactiveInsights(props: Props) {
  const account = props.account;
  if (account.status !== "ready" || !account.userId) return <section className="workspace-panel proactive-panel" aria-labelledby="proactive-insights-title">
    <h2 id="proactive-insights-title">Proactive Insights</h2>
    <p>{account.status === "loading" ? "Verifying your account..." : "Sign in to connect Calendar, To-do, or AI Team conversations to private follow-ups."}</p>
    {account.status !== "loading" && <Link href="/login?next=%2Fworkspace">Sign in <ArrowRight size={13} /></Link>}
  </section>;
  return <ScopedInsights key={account.userId} {...props} ownerId={account.userId} />;
}

function ScopedInsights({ ownerId, onDiscuss, conversationLink }: Props & { ownerId: string }) {
  const { controller, view, busy, notice, setNotice, run, refresh } = useProactiveController(ownerId);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [reviews, setReviews] = useState<TaskReview[] | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [ownershipConfirmed, setOwnershipConfirmed] = useState(false);
  const [search, setSearch] = useState("");
  const [timeZoneDraft, setTimeZoneDraft] = useState("");
  const ready = view?.status === "ready";
  const state = ready ? view.state : null;
  const selectedReview = reviews?.find(review => review.record.id === selectedId);
  useEffect(() => {
    if (conversationLink?.ownerId !== ownerId) return;
    const before = controller.snapshot();
    if (before.status !== "ready") return;
    let active = true;
    void controller.dispatch(before.token, { type: "link_conversation", caseId: conversationLink.caseId, conversationId: conversationLink.conversationId }).then(result => {
      if (active && result.status === "ready") { setNotice("Coach conversation linked."); void refresh(); }
    });
    return () => { active = false; };
  }, [conversationLink, controller, ownerId, refresh, setNotice]);

  function openReview(id = "") {
    setReviewOpen(true); setSelectedId(id); setReviews(null); setOwnershipConfirmed(false); setSearch("");
    window.requestAnimationFrame(() => document.getElementById("proactive-source-review")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }
  function loadReviews() {
    if (view?.status !== "ready") return;
    setOwnershipConfirmed(false);
    try { setReviews(controller.reviewTasks(view.token, acknowledged)); setNotice(""); }
    catch { setNotice("Browser tasks could not be read. No data was imported or changed."); }
  }
  function discuss(item: ProactiveCase) {
    if (view?.status !== "ready") return;
    try {
      onDiscuss({ requestId: crypto.randomUUID(), ownerId, handoff: controller.coachHandoff(view.token, item.id),
        draft: item.blocker ? "Help me list the questions to clarify this blocker and choose a next step." : "Help me work out the next step for this task." });
    } catch { setNotice("Review the latest task snapshot before discussing it with the Coach."); void refresh(); }
  }

  return <section className="workspace-panel proactive-panel" aria-labelledby="proactive-insights-title">
    <div className="proactive-heading"><div><span className="panel-kicker"><Sparkles size={13} /> YOUR AI TEAM, FOLLOWING THROUGH</span>
      <h2 id="proactive-insights-title">Proactive Insights</h2><p>Keep one useful question moving, at your pace.</p></div>
      {ready && <button type="button" onClick={() => openReview()} disabled={busy}>Connect a task</button>}</div>
    {!view && <p role="status">Loading your workflow...</p>}
    {view && !ready && <div role="alert"><p>{view.status === "corrupt" || view.status === "unsupported_version"
      ? "Workflow data cannot be read safely. The saved data has been preserved."
      : view.status === "locking_unavailable" ? "This browser cannot safely save concurrent workflow updates. Use a browser with Web Locks support."
      : "Your workflow is temporarily unavailable. Your saved data is preserved."}</p><button type="button" onClick={() => void refresh()}>Try again</button></div>}
    {ready && state && <>
      <div className="proactive-settings">
        <label><input type="checkbox" checked={state.settings.enabled} disabled={busy} onChange={event => {
          const enabled = event.target.checked; void run(token => controller.settings(token, { enabled }), enabled ? "Proactive questions enabled." : "Proactive questions paused.");
        }} /> Proactive questions</label>
        <label>Show <select aria-label="Maximum visible proactive questions" value={state.settings.maxVisibleQuestions} disabled={busy} onChange={event => {
          const count = Number(event.target.value); void run(token => controller.settings(token, { maxVisibleQuestions: count }));
        }}><option value={1}>1 question</option><option value={2}>2 questions</option><option value={3}>3 questions</option></select></label>
        <details><summary>Time zone: {state.settings.timeZone}</summary><form onSubmit={event => { event.preventDefault(); if (!isTimeZone(timeZoneDraft.trim())) { setNotice("Use a valid IANA time zone, such as Europe/Berlin."); return; } void run(token => controller.settings(token, { timeZone: timeZoneDraft.trim() })); }}>
          <label>Time zone<input required aria-label="Workflow time zone" value={timeZoneDraft} placeholder={state.settings.timeZone} onChange={event => setTimeZoneDraft(event.target.value)} /></label>
          <small>Use an IANA name, such as Europe/Berlin.</small><button disabled={busy || !timeZoneDraft.trim()}>Save time zone</button>
        </form></details>
      </div>
      {!state.settings.enabled && <p className="proactive-note">Questions are paused. Your answers and follow-up times are preserved.</p>}
      {reviewOpen && <div id="proactive-source-review" className="proactive-source-review" aria-label="Review task ownership">
        <div className="proactive-review-heading"><h3>Connect a task you own</h3><button type="button" onClick={() => { setReviewOpen(false); setReviews(null); }}>Close</button></div>
        <p>Browser-stored tasks can be shared across accounts on this device. Nothing is automatically assigned to you. Review a task and confirm that it belongs to you before connecting its snapshot.</p>
        <label className="proactive-check"><input type="checkbox" checked={acknowledged} onChange={event => { setAcknowledged(event.target.checked); setReviews(null); setOwnershipConfirmed(false); }} /> I understand and want to review this browser&apos;s tasks.</label>
        <button type="button" disabled={!acknowledged || busy} onClick={loadReviews}>Show tasks for review</button>
        {reviews && <>
          <label className="proactive-search">Find a task<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search browser tasks" /></label>
          <fieldset className="proactive-source-list"><legend>Choose one task</legend>
            {reviews.filter(review => review.record.title.toLowerCase().includes(search.toLowerCase())).slice(0, 30).map(review => <label key={review.record.id}>
              <input type="radio" name="proactive-task-review" value={review.record.id} checked={selectedId === review.record.id} disabled={review.record.status === "Done"} onChange={() => { setSelectedId(review.record.id); setOwnershipConfirmed(false); }} />
              <span><strong>{review.record.title}</strong><small>{review.record.status} · {review.record.dueDate || "No deadline"}</small></span>
            </label>)}
            {!reviews.length && <p>No tasks are stored in this browser. Add one in To-do first.</p>}
          </fieldset>
          {selectedReview && <div className="proactive-inference" aria-label="Selected task snapshot">
            <small>Selected snapshot to approve</small><p><strong>{selectedReview.record.title}</strong></p>
            <p>{selectedReview.record.status} · Due: {selectedReview.record.dueDate || "No deadline"} · Priority: {selectedReview.record.priority ?? "onTrack"}</p>
          </div>}
          <label className="proactive-check"><input type="checkbox" checked={ownershipConfirmed} disabled={selectedReview?.record.status !== "Open"} onChange={event => setOwnershipConfirmed(event.target.checked)} /> This selected task belongs to me. Connect this exact snapshot for follow-up.</label>
          <button type="button" disabled={busy || !ownershipConfirmed || selectedReview?.record.status !== "Open"} onClick={async () => {
            const review = selectedReview;
            if (!review) return;
            const restart = state.cases.some(item => item.sourceId === selectedId && (item.workflowStatus === "resolved" || item.workflowStatus === "dismissed"));
            if (await run(token => controller.connectTask(token, review, ownershipConfirmed, restart), "Task snapshot connected. The original task is unchanged.")) { setReviewOpen(false); setReviews(null); setOwnershipConfirmed(false); }
          }}>{state.cases.some(item => item.sourceId === selectedId && (item.workflowStatus === "resolved" || item.workflowStatus === "dismissed")) ? "Confirm and restart check-in" : "Confirm and connect task"}</button>
        </>}
      </div>}
      {!view.sourceViews.length && !reviewOpen && <div className="proactive-empty"><MessageCircleQuestion size={24} /><h3>Connect a plan or AI Team conversation.</h3>
        <p>Link a Calendar event, review a To-do you own, or connect a saved AI Team conversation. Your AI Team can clarify next steps and check in at a time you choose.</p></div>}
      <div className="proactive-case-list">{view.sourceViews.map(source => {
        const sourceType = source.type ?? "task";
        const item = state.cases.find(entry => entry.sourceType === sourceType && entry.sourceId === source.sourceId);
        if (!item) return <article className="proactive-case" key={`${sourceType}:${source.sourceId}`}><h3>{source.title}</h3><p>{source.status === "completed" ? "This item is complete. No follow-up is needed." : source.status === "current" ? "Connected. Your AI Team will check in when a useful trigger arrives." : "Review this source before starting a check-in."}</p>{sourceType === "task" && source.status !== "completed" && <button type="button" disabled={busy} onClick={() => openReview(source.sourceId)}>Review task for a check-in</button>}</article>;
        const current = source.status === "current";
        return <TaskCaseCard key={item.id} item={item} current={current}
          showQuestion={view.insights.some(insight => insight.caseId === item.id)} enabled={state.settings.enabled} busy={busy} timeZone={state.settings.timeZone}
          sourceStatus={source.status} onReview={() => openReview(source.sourceId)} onDiscuss={() => discuss(item)}
          command={command => run(token => controller.dispatch(token, command))} />;
      })}</div>
      <p className="proactive-privacy">Workflow memory is saved locally for this account. Changed task details need review. Follow-up is checked when the app opens or is active; no background notifications or external actions are sent.</p>
    </>}
    {notice && <p className="proactive-notice" role="status">{notice}</p>}
  </section>;
}

export function TaskCaseCard({ item, current, showQuestion, enabled, busy, timeZone, sourceStatus, onReview, onDiscuss, command }: {
  item: ProactiveCase; current: boolean; showQuestion: boolean; enabled: boolean; busy: boolean; timeZone: string;
  sourceStatus: string; onReview: () => void; onDiscuss: () => void; command: (command: WorkflowCommand) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<{ questionId: string; text: string }>({ questionId: "", text: "" });
  const answer = draft.questionId === item.currentQuestion?.id ? draft.text : "";
  const [followUp, setFollowUp] = useState("");
  const [timeError, setTimeError] = useState("");
  const closed = item.workflowStatus === "dismissed" || item.workflowStatus === "resolved";
  return <article className="proactive-case">
    <div className="proactive-case-meta"><span>{workflowRoleNames[item.assignedRoleId]}</span><small>{statusText[item.workflowStatus]}</small></div>
    <h3><Link href={item.sourceType === "calendar" ? "/?view=calendar" : item.sourceType === "conversation" ? "/partners" : "/?view=todos"}>{item.sourceSnapshot.title}</Link></h3><p className="proactive-reason">{item.triggerReason}</p>
    {!current && !closed && <div className="proactive-review-required" role="status"><p>{sourceStatus === "completed" ? "This item is complete. Follow-up has stopped."
      : sourceStatus === "missing" ? "The linked item is no longer available. Follow-up is paused."
      : sourceStatus === "unavailable" ? "The linked item cannot be read safely. Follow-up is paused."
      : "The linked item changed. Questions are paused until it is reviewed."}</p>{item.sourceType === "task" && <button type="button" disabled={busy} onClick={onReview}>Review task</button>}</div>}
    {current && showQuestion && enabled && item.currentQuestion && <>
      <p className="proactive-question">{item.currentQuestion.text}</p>
      {draft.text && draft.questionId !== item.currentQuestion.id && <details><summary>An unsent draft from an earlier question is available</summary><p>{draft.text}</p><button type="button" onClick={() => setDraft({ questionId: item.currentQuestion!.id, text: draft.text })}>Use this draft after reviewing the question</button></details>}
      <form onSubmit={async event => { event.preventDefault(); if (item.currentQuestion && await command({ type: "answer", caseId: item.id, questionId: item.currentQuestion.id, text: answer })) setDraft({ questionId: "", text: "" }); }}>
        <label>Your answer<textarea value={answer} rows={3} maxLength={4000} disabled={busy} onChange={event => setDraft({ questionId: item.currentQuestion!.id, text: event.target.value })} /></label>
        <button disabled={busy || !answer.trim()}>Save answer</button>
      </form>
      {item.blocker && <div className="proactive-actions"><button type="button" disabled={busy} onClick={() => void command({ type: "followup_result", caseId: item.id, questionId: item.currentQuestion!.id, outcome: "received" })}>The blocker is cleared</button>
        <button type="button" disabled={busy} onClick={() => void command({ type: "followup_result", caseId: item.id, questionId: item.currentQuestion!.id, outcome: "still_waiting" })}>Still waiting</button></div>}
    </>}
    {current && item.workflowStatus === "answered" && <div className="proactive-answer-stage">
      <p><strong>Your last answer</strong><br />{item.memory.answers.at(-1)?.text}</p>
      {item.memory.inferences.filter(inference => inference.status === "unconfirmed").map(inference => <div className="proactive-inference" key={inference.id}>
        <small>Unconfirmed {inference.derivedBy === "ai" ? "AI interpretation" : "rule-based interpretation"}</small><p>{inference.text}</p>
        <div className="proactive-actions"><button type="button" disabled={busy} onClick={() => void command({ type: "confirm_inference", caseId: item.id, inferenceId: inference.id })}>Confirm this fact</button>
          <button type="button" disabled={busy} onClick={() => void command({ type: "reject_inference", caseId: item.id, inferenceId: inference.id })}>That is not correct</button></div>
      </div>)}
      {workflowSuggestion(item) && <p>{workflowSuggestion(item)}</p>}
      <form onSubmit={event => {
        event.preventDefault();
        try {
          const at = localFollowUpInstant(followUp, timeZone);
          if (Date.parse(at) <= Date.now()) { setTimeError("Choose a future follow-up time."); return; }
          setTimeError(""); void command({ type: "schedule_followup", caseId: item.id, at });
        } catch (error) { setTimeError(error instanceof Error && error.message === "ambiguous_local_time" ? "This time occurs twice when clocks change. Choose another local time." : "This local time is invalid or does not exist when clocks change. Choose another time."); }
      }}>
        <label>Follow up at ({timeZone})<input type="datetime-local" value={followUp} required onChange={event => setFollowUp(event.target.value)} disabled={busy} /></label>
        <button disabled={busy || !followUp}>Schedule follow-up</button>
        {timeError && <p role="alert">{timeError}</p>}
      </form>
    </div>}
    {item.nextFollowUpAt && <p className="proactive-next"><Clock3 size={13} /> {formatWorkflowTime(item.nextFollowUpAt, timeZone)} · {timeZone}</p>}
    {current && !closed && <div className="proactive-actions">
      <button type="button" disabled={busy} onClick={onDiscuss}>Discuss with Coach <ArrowRight size={12} /></button>
      <button type="button" disabled={busy} onClick={() => void command({ type: "snooze", caseId: item.id, until: new Date(Date.now() + 3_600_000).toISOString() })}>Snooze 1 hour</button>
      <button type="button" disabled={busy} onClick={() => void command({ type: "dismiss", caseId: item.id })}>Stop following up</button>
    </div>}
    {closed && current && item.sourceType === "task" && <button type="button" disabled={busy} onClick={onReview}>Review task to start another check-in</button>}
    {item.memory.answers.length > 0 && <details className="proactive-history"><summary>Follow-up record ({item.memory.answers.length} replies)</summary>
      {item.memory.answers.slice(-5).map(reply => <p key={reply.id}><small>{formatWorkflowTime(reply.answeredAt, timeZone)}</small><br />{reply.text}</p>)}
      {item.memory.confirmedFacts.length > 0 && <><strong>User-confirmed facts</strong><ul>{item.memory.confirmedFacts.slice(-5).map(fact => <li key={fact.id}>{fact.text} <small>({formatWorkflowTime(fact.confirmedAt, timeZone)})</small></li>)}</ul></>}
    </details>}
  </article>;
}
