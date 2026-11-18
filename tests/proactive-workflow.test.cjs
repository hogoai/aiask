const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const ts = require("typescript");

// Reuse the project's existing Node test + TypeScript transpilation approach.
const previousLoader = require.extensions[".ts"];
require.extensions[".ts"] = (module, path) => module._compile(ts.transpileModule(readFileSync(path, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, path);
const { createWorkflowState, advanceWorkflows, applyWorkflowCommand, setWorkflowSettings } = require("../src/lib/proactive/engine.ts");
const { detectTriggers, normalizeFollowUpTime, triggerRole } = require("../src/lib/proactive/rules.ts");
const { buildQuestionInput, generateRuleQuestion, buildWorkflowContext, workflowSuggestion, selectProactiveInsights, buildWorkspaceCoachHandoff } = require("../src/lib/proactive/interfaces.ts");
const { createWorkflowSession, workflowStorageKey } = require("../src/lib/proactive/storage.ts");
const { isWorkflowState } = require("../src/lib/proactive/validation.ts");
const { readWorkspaceRecords } = require("../src/lib/workspace/browser-records.ts");
const { PARTNER_ROLE_IDS } = require("../src/lib/ai/contracts.ts");
if (previousLoader) require.extensions[".ts"] = previousLoader;
else delete require.extensions[".ts"];

const owner = "owner-a";
const start = new Date("2026-11-18T09:00:00.000Z");
const followup = new Date("2026-11-19T09:00:00.000Z");
function observation(id = "quote-1", record = {}, extra = {}) {
  return { ownerId: owner, ownership: "verified_owner", taskCreated: true, source: { type: "task", record: {
    id, ideaId: null, eventId: null, title: "Submit the client booth quotation by Friday.", dueDate: "2026-11-20", status: "Open", ...record,
  } }, ...extra };
}
const fresh = () => createWorkflowState(owner, "Europe/Berlin");
const started = (source = observation()) => advanceWorkflows(fresh(), [source], start);
const item = state => state.cases[0];
function change(state, command, now = start) {
  const result = applyWorkflowCommand(state, { caseId: item(state).id, ...command }, now);
  assert.ok(isWorkflowState(result, result.ownerId), `Invalid persisted state after ${command.type}`);
  return result;
}
function answer(state, text = "I'm still missing the final design drawings.") {
  return change(state, { type: "answer", questionId: item(state).currentQuestion.id, text });
}
function blocked() {
  const replied = answer(started());
  return change(replied, { type: "confirm_inference", inferenceId: item(replied).memory.inferences[0].id });
}
function scheduled() { return change(blocked(), { type: "schedule_followup", at: followup.toISOString() }); }
function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const reads = [], writes = [];
  return { values, reads, writes, getItem(key) { reads.push(key); return values.get(key) ?? null; }, setItem(key, value) { writes.push(key); values.set(key, value); } };
}
function locks() {
  const queues = new Map();
  return { request(key, callback) {
    const result = (queues.get(key) ?? Promise.resolve()).then(callback);
    queues.set(key, result.catch(() => {}));
    return result;
  } };
}
function session(storage, userId = owner, lockManager = locks()) {
  const value = createWorkflowSession(storage, { locks: lockManager, timeZone: "Europe/Berlin" });
  value.setAccount({ status: "ready", userId });
  return value;
}
function deepFreeze(value) {
  if (value && typeof value === "object") { Object.freeze(value); Object.values(value).forEach(deepFreeze); }
  return value;
}

test("quotation scenario persists from clarification to confirmed blocker, scheduled follow-up, and resolution", async () => {
  const source = deepFreeze(observation());
  const originalSource = JSON.stringify(source);
  const storage = memoryStorage();
  let store = session(storage);
  let view = store.read();
  view = await store.update(view.token, state => advanceWorkflows(state, [source], start));
  assert.equal(view.status, "ready");
  assert.equal(item(view.state).sourceId, source.source.record.id);
  assert.equal(item(view.state).assignedRoleId, "guide");
  assert.equal(item(view.state).currentQuestion.text, "Have the final design drawings and technical specifications for the quotation been confirmed?");
  const rawReply = "  I'm still missing the final design drawings.\n";
  view = await store.update(view.token, state => answer(state, rawReply));
  assert.equal(item(view.state).memory.answers[0].text, rawReply);
  assert.equal(item(view.state).memory.inferences[0].status, "unconfirmed");
  assert.deepEqual(item(view.state).memory.confirmedFacts, []);
  assert.equal(item(view.state).blocker, null);
  view = await store.update(view.token, state => change(state, { type: "confirm_inference", inferenceId: item(state).memory.inferences[0].id }));
  assert.equal(item(view.state).blocker.text, "Waiting for final design drawings.");
  assert.match(workflowSuggestion(item(view.state)), /questions.*designer/);
  view = await store.update(view.token, state => change(state, { type: "schedule_followup", at: "2026-11-19T10:00:00+01:00" }));
  assert.equal(item(view.state).nextFollowUpAt, followup.toISOString());
  assert.equal(item(view.state).workflowStatus, "waiting_for_followup");

  store = session(storage); // Simulate closing and reopening the application.
  view = store.read();
  assert.equal(view.status, "ready");
  view = await store.update(view.token, state => advanceWorkflows(state, [source], new Date(followup.getTime() - 1)));
  assert.equal(selectProactiveInsights(view.state).length, 0);
  view = await store.update(view.token, state => advanceWorkflows(state, [source], followup));
  const question = item(view.state).currentQuestion;
  assert.match(question.text, /Last time.*design drawings.*progress/);
  assert.equal(item(view.state).assignedRoleId, "action_partner");
  assert.equal(item(view.state).triggerType, "blocker_followup");
  view = await store.update(view.token, state => change(state, { type: "followup_result", questionId: question.id, outcome: "received" }, followup));
  assert.equal(item(view.state).workflowStatus, "resolved");
  assert.equal(item(view.state).nextFollowUpAt, null);
  assert.equal(item(view.state).blocker, null);
  assert.match(item(view.state).memory.confirmedFacts.at(-1).text, /received/);
  assert.equal(selectProactiveInsights(view.state).length, 0);
  assert.equal(JSON.stringify(source), originalSource); // Resolving a Case never completes the business task.
  assert.equal(source.source.record.status, "Open");
  assert.deepEqual(item(view.state).memory.history.map(entry => entry.to), [
    "pending", "waiting_for_answer", "answered", "answered", "waiting_for_followup", "pending", "waiting_for_answer", "answered", "resolved",
  ]);
  assert.ok(storage.reads.every(key => key === workflowStorageKey(owner)));
  assert.ok(storage.writes.every(key => key === workflowStorageKey(owner)));
});

test("refresh and duplicate creation signals do not create more Cases, questions, or writes", async () => {
  const storage = memoryStorage();
  const store = session(storage);
  let view = await store.update(store.read().token, state => advanceWorkflows(state, [observation()], start));
  const original = JSON.stringify(view.state);
  view = await store.update(view.token, state => advanceWorkflows(state, [observation()], new Date("2026-11-18T13:00:00.000Z")));
  assert.equal(view.changed, false);
  assert.equal(storage.writes.length, 1);
  assert.equal(JSON.stringify(session(storage).read().state), original);
  assert.equal(detectTriggers(view.state, [observation()], start).triggers.length, 0);
});

test("AI proposals remain unconfirmed and can be rejected without becoming facts", () => {
  const state = started();
  const replied = change(state, { type: "answer", questionId: item(state).currentQuestion.id, text: "I need to check.", proposals: [
    { kind: "blocker", text: "Possibly waiting for approval.", derivedBy: "ai" },
  ] });
  const context = buildWorkflowContext(item(replied));
  assert.equal(context.confirmedFacts.length, 0);
  assert.equal(context.unconfirmedInferences[0].derivedBy, "ai");
  assert.equal(item(replied).blocker, null);
  const rejected = change(replied, { type: "reject_inference", inferenceId: item(replied).memory.inferences[0].id });
  assert.equal(item(rejected).memory.inferences[0].status, "rejected");
  assert.equal(item(rejected).memory.confirmedFacts.length, 0);
  assert.throws(() => change(rejected, { type: "confirm_inference", inferenceId: item(rejected).memory.inferences[0].id }), /inference_not_confirmable/);
});

test("Snooze survives refresh, holds before its time, and asks once on return", () => {
  const first = started();
  const original = item(first).currentQuestion.text;
  const snoozed = change(first, { type: "snooze", until: followup.toISOString() });
  assert.equal(item(snoozed).workflowStatus, "snoozed");
  const restored = JSON.parse(JSON.stringify(snoozed));
  assert.equal(advanceWorkflows(restored, [observation()], start), restored);
  const due = advanceWorkflows(restored, [observation()], followup);
  assert.equal(item(due).currentQuestion.text, original);
  assert.equal(item(due).memory.questions.length, 2);
  assert.equal(advanceWorkflows(due, [observation()], followup), due);
});

test("Dismiss is persistent and source edits or later deadlines do not revive the Case", () => {
  const dismissed = change(scheduled(), { type: "dismiss" });
  assert.equal(item(dismissed).workflowStatus, "dismissed");
  assert.equal(item(dismissed).nextFollowUpAt, null);
  const changedSource = observation("quote-1", { title: "Revised quotation", dueDate: "2026-11-19" });
  assert.equal(advanceWorkflows(dismissed, [changedSource], followup), dismissed);
  assert.throws(() => change(dismissed, { type: "resolve" }), /case_closed/);
});

test("completion stops active, snoozed, and blocked follow-ups even when prompts are disabled", () => {
  const first = started();
  for (const state of [first, scheduled(), change(first, { type: "snooze", until: followup.toISOString() })]) {
    const muted = setWorkflowSettings(state, { enabled: false });
    const result = advanceWorkflows(muted, [observation("quote-1", { status: "Done" })], start);
    assert.equal(item(result).workflowStatus, "resolved");
    assert.equal(item(result).nextFollowUpAt, null);
    assert.equal(item(result).currentQuestion, null);
    assert.equal(item(result).memory.history.at(-1).event, "source_completed");
    assert.equal(item(result).sourceSnapshot.completed, true);
    assert.ok(isWorkflowState(result, owner));
    assert.equal(advanceWorkflows(result, [observation()], followup), result);
  }
  assert.equal(started(observation("closed", { status: "Done" })).cases.length, 0);
});

test("source edits invalidate an outstanding question and reject its delayed answer", () => {
  const first = started();
  const oldQuestion = item(first).currentQuestion.id;
  const edited = observation("quote-1", { title: "Submit the revised booth quotation.", dueDate: "2026-11-23" });
  const next = advanceWorkflows(first, [edited], start);
  assert.equal(next.cases.length, 1);
  assert.equal(item(next).sourceVersion, 2);
  assert.equal(item(next).triggerType, "source_updated");
  assert.equal(item(next).assignedRoleId, "evaluator");
  assert.ok(item(next).memory.questions[0].invalidatedAt);
  assert.match(item(next).currentQuestion.text, /updated/);
  assert.throws(() => change(next, { type: "answer", questionId: oldQuestion, text: "Yes" }), /stale_answer/);
  assert.equal(advanceWorkflows(next, [edited], start), next);
  const reverted = advanceWorkflows(next, [observation()], start);
  assert.equal(item(reverted).sourceVersion, 3);
});

test("source edits supersede unconfirmed interpretations and preserve confirmed history", () => {
  const replied = answer(started());
  const edited = advanceWorkflows(replied, [observation("quote-1", { title: "Revised quotation" })], start);
  assert.equal(item(edited).memory.inferences[0].status, "superseded");
  assert.equal(item(edited).memory.answers.length, 1);
  assert.equal(item(edited).memory.confirmedFacts.length, 0);
  assert.throws(() => change(edited, { type: "confirm_inference", inferenceId: item(edited).memory.inferences[0].id }), /inference_not_confirmable/);
});

test("editing a source respects a future snooze or agreed follow-up time", () => {
  for (const waiting of [scheduled(), change(started(), { type: "snooze", until: followup.toISOString() })]) {
    const edited = observation("quote-1", { title: "Revised quotation" });
    const result = advanceWorkflows(waiting, [edited], start);
    assert.equal(item(result).workflowStatus, item(waiting).workflowStatus);
    assert.equal(item(result).nextFollowUpAt, followup.toISOString());
    assert.equal(selectProactiveInsights(result).length, 0);
    assert.ok(isWorkflowState(result, owner));
    const due = advanceWorkflows(result, [edited], followup);
    assert.equal(item(due).workflowStatus, "waiting_for_answer");
    assert.ok(item(due).memory.questions[0].invalidatedAt);
    if (item(waiting).workflowStatus === "snoozed") assert.notEqual(item(due).currentQuestion.text, item(waiting).memory.questions[0].text);
  }
});

test("still waiting records a reply and requires the user to choose another follow-up", () => {
  const due = advanceWorkflows(scheduled(), [observation()], followup);
  const waiting = change(due, { type: "followup_result", questionId: item(due).currentQuestion.id, outcome: "still_waiting" }, followup);
  assert.equal(item(waiting).workflowStatus, "answered");
  assert.equal(item(waiting).nextFollowUpAt, null);
  assert.ok(item(waiting).blocker);
  const later = change(waiting, { type: "schedule_followup", at: "2026-11-20T09:00:00.000Z" }, followup);
  assert.equal(item(later).workflowStatus, "waiting_for_followup");
  assert.equal(item(later).memory.answers.length, 2);
});

test("follow-up can be snoozed or dismissed through the same commands", () => {
  const due = advanceWorkflows(scheduled(), [observation()], followup);
  const later = change(due, { type: "snooze", until: "2026-11-20T09:00:00.000Z" }, followup);
  assert.equal(item(later).workflowStatus, "snoozed");
  assert.equal(item(change(due, { type: "dismiss" }, followup)).workflowStatus, "dismissed");
});

test("disabled prompts generate no new Cases and resume existing questions without re-asking", () => {
  const off = setWorkflowSettings(fresh(), { enabled: false });
  assert.equal(advanceWorkflows(off, [observation()], start), off);
  const first = started();
  const disabled = setWorkflowSettings(first, { enabled: false });
  assert.equal(selectProactiveInsights(disabled).length, 0);
  assert.equal(advanceWorkflows(disabled, [observation()], start), disabled);
  const enabled = setWorkflowSettings(disabled, { enabled: true });
  assert.equal(selectProactiveInsights(enabled)[0].question.id, item(first).currentQuestion.id);
});

test("visible question limits queue other sources and never ask every partner", () => {
  const sources = ["a", "b", "c", "d"].map(id => observation(id));
  let state = advanceWorkflows(setWorkflowSettings(fresh(), { maxVisibleQuestions: 2 }), sources, start);
  assert.equal(state.cases.length, 4);
  assert.equal(selectProactiveInsights(state).length, 2);
  assert.equal(state.cases.filter(row => row.workflowStatus === "pending").length, 2);
  const unchanged = advanceWorkflows(state, sources, start);
  assert.equal(unchanged, state);
  state = answer(state, "The requirements are confirmed.");
  state = advanceWorkflows(state, sources, start);
  assert.equal(selectProactiveInsights(state).length, 2);
  assert.equal(state.cases[2].workflowStatus, "waiting_for_answer");
  assert.equal(selectProactiveInsights(setWorkflowSettings(state, { maxVisibleQuestions: 1 })).length, 1);
  assert.ok(Object.values(triggerRole).every(role => PARTNER_ROLE_IDS.includes(role)));
  assert.throws(() => setWorkflowSettings(state, { maxVisibleQuestions: 6 }), /invalid_settings/);
});

test("deadline rules use the selected IANA time zone rather than host time", () => {
  const source = observation("due", { title: "Submit deliverable", dueDate: "2026-11-21" }, { taskCreated: false });
  const clock = new Date("2026-11-18T00:30:00.000Z");
  const berlin = detectTriggers(fresh(), [source], clock);
  const losAngeles = detectTriggers(createWorkflowState(owner, "America/Los_Angeles"), [source], clock);
  assert.equal(berlin.triggers[0].type, "task_deadline_near");
  assert.equal(losAngeles.triggers.length, 0);
  assert.match(berlin.triggers[0].reason, /three calendar days/);
  assert.throws(() => createWorkflowState(owner, "Not/A_TimeZone"), /invalid_timezone/);
});

test("follow-up instants require explicit offsets and remain precise across DST", () => {
  assert.equal(normalizeFollowUpTime("2026-10-25T02:30:00+02:00"), "2026-10-25T00:30:00.000Z");
  assert.equal(normalizeFollowUpTime("2026-10-25T02:30:00+01:00"), "2026-10-25T01:30:00.000Z");
  for (const value of ["2026-10-25T02:30", "2026-02-30T09:00:00Z", "2026-11-18T25:00:00Z"]) {
    assert.throws(() => normalizeFollowUpTime(value), /invalid_followup_time/);
  }
  assert.throws(() => change(blocked(), { type: "schedule_followup", at: start.toISOString() }), /followup_must_be_future/);
});

test("the same deadline is handled once, with a cooldown after a different question", () => {
  let state = answer(started(), "The requirements are confirmed.");
  assert.equal(advanceWorkflows(state, [observation()], start), state);
  state = advanceWorkflows(state, [observation()], followup);
  assert.equal(item(state).triggerType, "task_deadline_near");
  assert.equal(item(state).memory.questions.length, 2);
  state = change(state, { type: "answer", questionId: item(state).currentQuestion.id, text: "All on track." }, followup);
  const later = new Date("2026-11-20T09:00:00.000Z");
  assert.equal(advanceWorkflows(state, [observation()], later), state);
});

test("invalid transitions, duplicate confirmations, stale output, and unsupported locale are rejected", () => {
  const first = started();
  assert.throws(() => change(first, { type: "schedule_followup", at: followup.toISOString() }), /answer_required_before_followup/);
  const replied = answer(first);
  assert.throws(() => change(replied, { type: "ask", output: generateRuleQuestion({ ...buildQuestionInput({ ...item(replied), workflowStatus: "pending" }) }) }), /question_not_available/);
  const confirmed = blocked();
  assert.throws(() => change(confirmed, { type: "confirm_inference", inferenceId: item(confirmed).memory.inferences[0].id }), /inference_not_confirmable/);
  const pending = advanceWorkflows(setWorkflowSettings(fresh(), { maxVisibleQuestions: 1 }), [observation("1"), observation("2")], start).cases[1];
  const state = { ...fresh(), cases: [pending] };
  const output = generateRuleQuestion(buildQuestionInput(pending));
  for (const changes of [{ sourceRevision: "stale" }, { partnerRole: "seventh_partner" }, { locale: "zh-CN" }, { caseId: "other" }]) {
    assert.throws(() => applyWorkflowCommand(state, { caseId: pending.id, type: "ask", output: { ...output, ...changes } }, start), /stale_or_invalid_question/);
  }
});

test("manual resolution is terminal and never modifies the linked task", () => {
  const source = deepFreeze(observation());
  const resolved = change(started(source), { type: "resolve" });
  assert.equal(item(resolved).workflowStatus, "resolved");
  assert.equal(source.source.record.status, "Open");
  assert.equal(advanceWorkflows(resolved, [source], followup), resolved);
  assert.throws(() => change(resolved, { type: "answer", questionId: "old", text: "reply" }), /case_closed/);
});

test("unowned, wrong-owner, and duplicate source inputs fail before any Case is created", () => {
  assert.throws(() => advanceWorkflows(fresh(), [observation("1", {}, { ownerId: "owner-b" })], start), /source_owner_unverified/);
  assert.throws(() => advanceWorkflows(fresh(), [observation("1", {}, { ownership: undefined })], start), /source_owner_unverified/);
  assert.throws(() => advanceWorkflows(fresh(), [observation(), observation()], start), /duplicate_source_observation/);
  assert.equal(fresh().cases.length, 0);
});

test("old To-do records remain unchanged and are not falsely treated as newly created", () => {
  const raw = JSON.stringify({ todos: [{ id: "old", title: "Submit quotation", status: "Open", dueDate: "", custom: "keep", remindAt: "unchanged" }], events: [], legacy: true });
  const storage = memoryStorage({ "aiask-planner": raw });
  const old = readWorkspaceRecords(storage).planner.data.todos[0];
  const source = { ownerId: owner, ownership: "verified_owner", source: { type: "task", record: old } };
  assert.equal(advanceWorkflows(fresh(), [source], start).cases.length, 0);
  assert.equal(storage.getItem("aiask-planner"), raw);
  assert.equal(storage.writes.length, 0);
  const actualCreation = advanceWorkflows(fresh(), [{ ...source, taskCreated: true }], start);
  assert.equal(actualCreation.cases.length, 1);
  assert.equal(item(actualCreation).sourceId, "old");
});

test("calendar and idea types are accepted without adding Phase 2 initial triggers", () => {
  const sources = [
    { ownerId: owner, ownership: "verified_owner", source: { type: "calendar", record: { id: "e", title: "Meeting", scheduledDate: "2026-11-19", scheduledTime: "10:00", todoId: null, ideaId: null } } },
    { ownerId: owner, ownership: "verified_owner", source: { type: "idea", record: { id: "i", text: "Reuse booth materials", createdAt: start.toISOString() } } },
  ];
  assert.equal(advanceWorkflows(fresh(), sources, start).cases.length, 0);
});

test("context, insights, and Coach handoff expose only the linked Case and English locale", () => {
  const state = blocked();
  const handoff = buildWorkspaceCoachHandoff(item(state));
  assert.equal(handoff.locale, "en");
  assert.equal(handoff.partnerRole, "guide");
  assert.equal(handoff.conversationId, null);
  assert.equal(handoff.context.source.id, "quote-1");
  assert.equal(handoff.context.confirmedFacts.length, 1);
  assert.equal(handoff.context.unconfirmedInferences.length, 0);
  handoff.context.confirmedFacts[0].text = "Modified copy";
  assert.notEqual(item(state).memory.confirmedFacts[0].text, "Modified copy");
});

test("pure engine preserves source records and prior states", () => {
  const state = deepFreeze(fresh());
  const source = deepFreeze(observation());
  const next = advanceWorkflows(state, [source], start);
  assert.equal(state.cases.length, 0);
  const first = deepFreeze(next);
  const replied = answer(first);
  assert.equal(item(first).workflowStatus, "waiting_for_answer");
  assert.equal(item(replied).workflowStatus, "answered");
});

test("loading, signed-out, and demo scopes cannot read or persist workflow data", async () => {
  const storage = memoryStorage();
  const store = createWorkflowSession(storage, { locks: locks() });
  for (const scope of [{ status: "loading" }, { status: "unavailable" }, { status: "ready", userId: null }]) {
    store.setAccount(scope);
    assert.equal(store.read().status, "scope_unavailable");
  }
  assert.equal(storage.reads.length, 0);
  assert.equal(storage.writes.length, 0);
});

test("account switches isolate data and reject stale A -> B -> A callbacks", async () => {
  const storage = memoryStorage();
  const store = session(storage);
  const view = await store.update(store.read().token, state => advanceWorkflows(state, [observation()], start));
  const token = view.token;
  store.setAccount({ status: "loading" });
  assert.equal(store.read().state, null);
  store.setAccount({ status: "ready", userId: "owner-b" });
  assert.equal(store.read().state.ownerId, "owner-b");
  assert.equal(store.read().state.cases.length, 0);
  assert.equal((await store.update(token, () => assert.fail("stale callback must not run"))).status, "account_changed");
  store.setAccount({ status: "ready", userId: owner });
  assert.equal(store.read().state.cases.length, 1);
  assert.equal((await store.update(token, () => assert.fail("A -> B -> A must reject the original token"))).status, "account_changed");
});

test("account changes while waiting for a cross-tab lock prevent all stale writes", async () => {
  let release;
  const storage = memoryStorage();
  const store = session(storage, owner, { request: (_key, callback) => new Promise(resolve => { release = () => resolve(callback()); }) });
  const pending = store.update(store.read().token, () => assert.fail("obsolete work must not run"));
  store.setAccount({ status: "loading" });
  store.setAccount({ status: "ready", userId: "owner-b" });
  release();
  assert.equal((await pending).status, "account_changed");
  assert.equal(storage.writes.length, 0);
});

test("cross-tab transactions re-read latest data under the same account lock", async () => {
  const storage = memoryStorage();
  const lockManager = locks();
  const a = session(storage, owner, lockManager);
  const b = session(storage, owner, lockManager);
  const [first, second] = await Promise.all([
    a.update(a.read().token, state => setWorkflowSettings(state, { enabled: false })),
    b.update(b.read().token, state => setWorkflowSettings(state, { maxVisibleQuestions: 2 })),
  ]);
  assert.equal(first.status, "ready");
  assert.equal(second.status, "ready");
  assert.deepEqual(a.read().state.settings, { enabled: false, timeZone: "Europe/Berlin", maxVisibleQuestions: 2 });
});

test("malformed and future-version data fail safely and are preserved byte-for-byte", async () => {
  const key = workflowStorageKey(owner);
  for (const [raw, status] of [["{broken", "corrupt"], [JSON.stringify({ version: 2 }), "unsupported_version"], [JSON.stringify({ version: 1, ownerId: owner }), "corrupt"]]) {
    const storage = memoryStorage({ [key]: raw });
    const store = session(storage);
    assert.equal(store.read().status, status);
    assert.equal(store.read().state, null);
    assert.equal((await store.update({ ownerId: owner, generation: 1 }, () => assert.fail("corrupt storage must not be reset"))).status, status);
    assert.equal(storage.getItem(key), raw);
    assert.equal(storage.writes.length, 0);
  }
});

test("nested owner mismatches, orphan facts, duplicate sources, and invalid schedules are rejected", () => {
  for (const corrupt of [
    state => { item(state).ownerId = "owner-b"; },
    state => { item(state).memory.confirmedFacts.push({ id: "f", answerId: "nonexistent", inferenceId: null, text: "Unverified", confirmedAt: start.toISOString() }); },
    state => { state.cases.push({ ...item(state), id: "other-case" }); },
    state => { item(state).workflowStatus = "waiting_for_followup"; },
    state => { item(state).currentQuestion.text = "Tampered"; },
  ]) {
    const state = JSON.parse(JSON.stringify(started()));
    corrupt(state);
    const storage = memoryStorage({ [workflowStorageKey(owner)]: JSON.stringify(state) });
    assert.equal(session(storage).read().status, "corrupt");
  }
});

test("storage failures and unavailable locks never claim a successful save", async () => {
  const readFailure = createWorkflowSession({ getItem() { throw new Error("blocked"); }, setItem() { assert.fail(); } }, { locks: locks() });
  readFailure.setAccount({ status: "ready", userId: owner });
  assert.equal(readFailure.read().status, "read_failed");
  const storage = memoryStorage();
  storage.setItem = () => { throw new Error("quota"); };
  const store = session(storage);
  assert.equal((await store.update(store.read().token, state => advanceWorkflows(state, [observation()], start))).status, "write_failed");
  assert.equal(store.read().state.cases.length, 0);
  const noLocks = session(memoryStorage(), owner, null);
  assert.equal((await noLocks.update(noLocks.read().token, () => assert.fail("no unsafe fallback"))).status, "locking_unavailable");
});

test("invalid reducers cannot overwrite storage or bypass account changes", async () => {
  const storage = memoryStorage();
  const store = session(storage);
  const view = store.read();
  assert.equal((await store.update(view.token, () => { throw new Error("invalid operation"); })).status, "invalid_update");
  assert.equal((await store.update(view.token, state => ({ ...state, ownerId: "owner-b" }))).status, "corrupt");
  assert.equal((await store.update(view.token, state => { store.setAccount({ status: "loading" }); return state; })).status, "account_changed");
  assert.equal(storage.writes.length, 0);
});

test("no workflow operation reads, writes, or migrates legacy business and conversation keys", async () => {
  const original = { "aiask-planner": "original planner", "aiask-idea-box": "original ideas", "aiask-daily-check-in:v1:user:owner-a": "original check-in", "aiask-conversations": "original conversations" };
  const storage = memoryStorage(original);
  const store = session(storage);
  await store.update(store.read().token, state => advanceWorkflows(state, [observation()], start));
  for (const [key, value] of Object.entries(original)) assert.equal(storage.values.get(key), value);
  assert.ok(storage.reads.every(key => key.startsWith("aiask-proactive-workflows:v1:user:")));
  assert.ok(storage.writes.every(key => key.startsWith("aiask-proactive-workflows:v1:user:")));
});
