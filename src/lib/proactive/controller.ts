import type { WorkflowAccountScope, WorkflowSessionToken, WorkflowStorageResult } from "./storage";
import { createWorkflowSession, workflowStorageKey } from "./storage";
import { advanceWorkflows, applyWorkflowCommand, holdQuestionsForSourceReview, requestTaskCheckIn, setWorkflowSettings } from "./engine";
import type { WorkflowCommand, WorkflowSettings, WorkflowState } from "./contracts";
import { isObject, PLANNER_KEY, readWorkspaceRecords, type PlannerTodo } from "../workspace/browser-records";
import { buildWorkspaceCoachHandoff, selectProactiveInsights } from "./interfaces";
import { adoptPlannerItem, approveTaskSnapshot, connectTeamSource as applyTeamSource, inspectTaskSources, ownedTaskObservation, plannerObservations, readBrowserTasksForReview, teamSourceFromConversation, transferTeamCasesToTasks, type TaskReview } from "./sources";
import type { AIConversation } from "../ai/conversations";
import { isInstant, taskSnapshot, WorkflowError } from "./rules";

type StorageAccess = Pick<Storage, "getItem" | "setItem">;
type Options = { timeZone?: string; locks?: Pick<LockManager, "request"> | null; now?: () => Date };

/** Framework-independent UI controller; source approvals and Cases share one atomic workflow envelope. */
export function createProactiveController(storage: StorageAccess, options: Options = {}) {
  const session = createWorkflowSession(storage, options);
  const now = options.now ?? (() => new Date());
  const readPlannerRecords = () => readWorkspaceRecords({
    getItem: key => key === PLANNER_KEY ? storage.getItem(key) : null,
  });
  const calendarObservations = (state: WorkflowState) => {
    const trackedIds = new Set(state.cases.filter(item => item.sourceType === "calendar").map(item => item.sourceId));
    return trackedIds.size ? plannerObservations(state.ownerId, readPlannerRecords(), trackedIds) : [];
  };

  function initialPreferences(state: WorkflowState): WorkflowState {
    try {
      if (storage.getItem(workflowStorageKey(state.ownerId)) !== null) return state;
      const raw = storage.getItem("aiask-daily-check-in:v1:user:" + state.ownerId);
      const legacy: unknown = raw === null ? null : JSON.parse(raw);
      // Carry only a previous global opt-out. Never import answers, topics, task ownership or AI context.
      return isObject(legacy) && legacy.version === 1 && legacy.enabled === false ? setWorkflowSettings(state, { enabled: false }) : state;
    } catch { return state; }
  }
  const transact = (token: WorkflowSessionToken, reduce: (state: WorkflowState) => WorkflowState) => session.update(token, state => reduce(initialPreferences(state)));

  function assertToken(token: WorkflowSessionToken) {
    const result = session.read();
    if (result.status !== "ready" || result.token.ownerId !== token.ownerId || result.token.generation !== token.generation) throw new WorkflowError("account_changed");
    return result;
  }
  function snapshot() {
    const result = session.read();
    if (result.status !== "ready") return result;
    const state = initialPreferences(result.state);
    const inspected = inspectTaskSources(state, storage);
    const views = [...inspected.views];
    let observations = inspected.observations;
    try {
      const currentSources = calendarObservations(state);
      const reviewedIds = new Set((state.taskSources ?? []).map(source => source.record.id));
      const unreviewedSources = currentSources.filter(entry => entry.source.type !== "task" || !reviewedIds.has(entry.source.record.id));
      observations = [...observations, ...unreviewedSources, ...(state.teamSources ?? []).map(source => ({ ownerId: state.ownerId, ownership: "verified_owner" as const, source }))];
      views.push(...unreviewedSources.map(entry => ({
        sourceId: entry.source.record.id,
        title: entry.source.type === "idea" ? entry.source.record.text : entry.source.record.title,
        status: entry.source.type === "task" ? (entry.source.record.status === "Done" ? "completed" as const : "current" as const)
          : entry.source.type === "calendar" && entry.source.record.completed ? "completed" as const : "current" as const,
        type: entry.source.type,
      })));
      views.push(...(state.teamSources ?? []).map(source => ({ sourceId: source.record.id, title: source.record.title, status: "current" as const, type: "conversation" as const })));
    } catch {
      // The refresh path reports storage failures; keep cached source labels visible but unusable.
      views.push(...state.cases.filter(item => item.sourceType !== "task").map(item => ({ sourceId: item.sourceId, title: item.sourceSnapshot.title, status: "unavailable" as const, type: item.sourceType })));
    }
    const currentIds = new Set(observations.map(entry => JSON.stringify([entry.source.type, entry.source.record.id])));
    const completedIds = new Set(views.filter(view => view.status === "completed").map(view => JSON.stringify([view.type ?? "task", view.sourceId])));
    return { ...result, state, sourceViews: views,
      insights: selectProactiveInsights(state).filter(insight =>
        currentIds.has(JSON.stringify([insight.sourceType, insight.sourceId])) &&
        !completedIds.has(JSON.stringify([insight.sourceType, insight.sourceId]))),
    };
  }
  function reconcile(state: WorkflowState) {
    const inspected = inspectTaskSources(state, storage);
    const currentSources = calendarObservations(state);
    const reviewedIds = new Set((state.taskSources ?? []).map(source => source.record.id));
    const unreviewedSources = currentSources.filter(entry => entry.source.type !== "task" || !reviewedIds.has(entry.source.record.id));
    const observations = [...inspected.observations, ...unreviewedSources,
      ...(state.teamSources ?? []).map(source => ({ ownerId: state.ownerId, ownership: "verified_owner" as const, source }))];
    const usableIds = new Set(observations.map(observation => JSON.stringify([observation.source.type, observation.source.record.id])));
    const heldIds = state.cases.filter(item => !usableIds.has(JSON.stringify([item.sourceType, item.sourceId]))).map(item => item.id);
    const transferred = transferTeamCasesToTasks(holdQuestionsForSourceReview(state, heldIds, now()), observations);
    return advanceWorkflows(transferred, observations, now());
  }
  async function refresh(token: WorkflowSessionToken) { return transact(token, reconcile); }

  /** Only call following an explicit UI request and acknowledgement of shared browser storage. */
  function reviewTasks(token: WorkflowSessionToken, acknowledgedSharedBrowserData: boolean): TaskReview[] {
    assertToken(token);
    if (acknowledgedSharedBrowserData !== true) throw new WorkflowError("source_review_consent_required");
    const records = readBrowserTasksForReview(storage);
    assertToken(token);
    return records.map(record => ({ record: { ...record }, revision: taskSnapshot(record).revision }));
  }
  async function connectTask(token: WorkflowSessionToken, review: TaskReview, ownershipConfirmed: boolean, restart = false): Promise<WorkflowStorageResult> {
    if (ownershipConfirmed !== true) throw new WorkflowError("source_ownership_confirmation_required");
    return transact(token, state => {
      const current = readBrowserTasksForReview(storage).find(task => task.id === review.record.id);
      if (!current || taskSnapshot(current).revision !== review.revision) throw new WorkflowError("source_changed_during_review");
      const source = approveTaskSnapshot(state.ownerId, { record: current, revision: review.revision }, now());
      const sources = state.taskSources ?? [];
      const next = { ...state, taskSources: [...sources.filter(entry => entry.record.id !== current.id), source] };
      return reconcile(requestTaskCheckIn(next, ownedTaskObservation(source), now(), restart));
    });
  }
  async function connectCalendar(token: WorkflowSessionToken, eventId: string, ownershipConfirmed: boolean): Promise<WorkflowStorageResult> {
    if (ownershipConfirmed !== true) throw new WorkflowError("source_ownership_confirmation_required");
    assertToken(token);
    adoptPlannerItem(storage, token.ownerId, "calendar", eventId);
    return transact(token, state => {
      const records = readPlannerRecords();
      const event = records.planner.data.events.find(entry => entry.id === eventId && entry.ownerId === state.ownerId);
      if (!event || records.planner.incomplete) throw new WorkflowError("source_unavailable");
      const task = records.planner.data.todos.find(entry => entry.id === event.todoId && entry.ownerId === state.ownerId);
      const observation = { ownerId: state.ownerId, ownership: "verified_owner" as const, trackingRequested: true,
        source: { type: "calendar" as const, record: { ...event, completed: task?.status === "Done" } } };
      return reconcile(advanceWorkflows(state, [observation], now()));
    });
  }
  async function connectConversation(token: WorkflowSessionToken, conversation: AIConversation): Promise<WorkflowStorageResult> {
    assertToken(token);
    return transact(token, state => applyTeamSource(state, teamSourceFromConversation(conversation), now()));
  }
  async function dispatch(token: WorkflowSessionToken, command: WorkflowCommand) {
    return transact(token, state => {
      if (command.type === "ask") throw new WorkflowError("manual_question_not_supported");
      if (command.type === "link_conversation") return applyWorkflowCommand(state, command, now());
      const item = state.cases.find(entry => entry.id === command.caseId);
      if (!item) throw new WorkflowError("case_unavailable");
      const currentSources = calendarObservations(state);
      const reviewedIds = new Set((state.taskSources ?? []).map(source => source.record.id));
      const observations = [...inspectTaskSources(state, storage).observations,
        ...currentSources.filter(entry => entry.source.type !== "task" || !reviewedIds.has(entry.source.record.id)),
        ...(state.teamSources ?? []).map(source => ({ ownerId: state.ownerId, ownership: "verified_owner" as const, source }))];
      const current = observations.some(entry => entry.source.type === item.sourceType && entry.source.record.id === item.sourceId);
      if (command.type !== "dismiss" && command.type !== "resolve" && !current) {
        // Reject rather than report a save for an answer that was not accepted. The UI retains the draft.
        throw new WorkflowError("source_review_required");
      }
      return reconcile(applyWorkflowCommand(state, command, now()));
    });
  }
  /** Only the post-save To-do creation bridge calls this, after fresh account re-verification. Never scan old rows. */
  async function captureCreatedTask(token: WorkflowSessionToken, event: { record: PlannerTodo; createdAt: string }) {
    return transact(token, state => {
      if (!isInstant(event.createdAt) || Math.abs(now().getTime() - Date.parse(event.createdAt)) > 120_000) throw new WorkflowError("stale_creation_event");
      const current = readBrowserTasksForReview(storage).find(task => task.id === event.record.id);
      const revision = taskSnapshot(event.record).revision;
      if (!current || current.status !== "Open" || taskSnapshot(current).revision !== revision) throw new WorkflowError("creation_source_changed");
      const existing = state.taskSources?.find(source => source.record.id === current.id);
      if (existing) {
        if (existing.revision !== revision) throw new WorkflowError("creation_event_is_not_an_edit_approval");
        return reconcile(state);
      }
      const source = { ...approveTaskSnapshot(state.ownerId, { record: current, revision }, now()), provenance: "user_created" as const };
      return reconcile({ ...state, taskSources: [...(state.taskSources ?? []), source] });
    });
  }
  async function settings(token: WorkflowSessionToken, changes: Partial<WorkflowSettings>) {
    return transact(token, state => reconcile(setWorkflowSettings(state, changes)));
  }
  function coachHandoff(token: WorkflowSessionToken, caseId: string) {
    const { state } = assertToken(token);
    const item = state.cases.find(entry => entry.id === caseId);
    const currentSources = calendarObservations(state);
    const reviewedIds = new Set((state.taskSources ?? []).map(source => source.record.id));
    const observations = [...inspectTaskSources(state, storage).observations,
      ...currentSources.filter(entry => entry.source.type !== "task" || !reviewedIds.has(entry.source.record.id)),
      ...(state.teamSources ?? []).map(source => ({ ownerId: state.ownerId, ownership: "verified_owner" as const, source }))];
    if (!item || !observations.some(entry => entry.source.type === item.sourceType && entry.source.record.id === item.sourceId)) throw new WorkflowError("source_review_required");
    const handoff = buildWorkspaceCoachHandoff(item);
    const teamSource = state.teamSources?.find(source => source.record.id === (item.sourceType === "conversation" ? item.sourceId : item.conversationId));
    return teamSource ? { ...handoff, teamSource } : handoff;
  }
  return { setAccount: session.setAccount, snapshot, refresh, reviewTasks, connectTask, connectCalendar, connectConversation, captureCreatedTask, dispatch, settings, coachHandoff };
}
export type ProactiveController = ReturnType<typeof createProactiveController>;
export type ProactiveSnapshot = ReturnType<ProactiveController["snapshot"]>;
