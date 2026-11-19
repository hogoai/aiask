const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

const oldLoaders = Object.fromEntries([".ts", ".tsx", ".css"].map(extension => [extension, require.extensions[extension]]));
for (const extension of [".ts", ".tsx"]) require.extensions[extension] = (module, path) => module._compile(ts.transpileModule(readFileSync(path, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText, path);
require.extensions[".css"] = () => {};
const { createProactiveController } = require("../src/lib/proactive/controller.ts");
const { workflowStorageKey } = require("../src/lib/proactive/storage.ts");
const { createWorkflowState, advanceWorkflows } = require("../src/lib/proactive/engine.ts");
const { isWorkflowState } = require("../src/lib/proactive/validation.ts");
const { workflowCoachContext } = require("../src/lib/proactive/coach.ts");
const { localFollowUpInstant, formatWorkflowTime } = require("../src/lib/proactive/time.ts");
const { readWorkspaceRecords } = require("../src/lib/workspace/browser-records.ts");
const { buildDailyCheckIn, decodeDailyState, recordedDailyAnswers } = require("../src/lib/workspace/daily-check-in.ts");
const { default: ProactiveInsights, TaskCaseCard } = require("../src/app/workspace/ProactiveInsights.tsx");
const { default: DailyBriefing, LegacyCheckInReplies } = require("../src/app/workspace/DailyBriefing.tsx");
const { default: LegacyDailyCheckIn } = require("../src/app/workspace/DailyCheckIn.tsx");
const { captureCreatedTaskAfterVerification } = require("../src/lib/proactive/creation.ts");
for (const [extension, loader] of Object.entries(oldLoaders)) {
  if (loader) require.extensions[extension] = loader;
  else delete require.extensions[extension];
}

const owner = "phase2-user-a";
const clock = new Date("2026-11-18T09:00:00.000Z");
function task(id = "quotation", fields = {}) {
  return { id, title: "Submit the client booth quotation by Friday.", dueDate: "2026-11-20", status: "Open", ideaId: null, eventId: null, ...fields };
}
function memoryStorage(tasks = [task()]) {
  const original = JSON.stringify({ events: [], todos: tasks, extra: "preserve" });
  const values = new Map([["aiask-planner", original], ["aiask-idea-box", "private ideas"]]);
  const reads = [], writes = [];
  return { values, original, reads, writes, getItem(key) { reads.push(key); return values.get(key) ?? null; },
    setItem(key, value) { writes.push(key); values.set(key, value); } };
}
function locks() {
  const queues = new Map();
  return { request(key, callback) { const work = (queues.get(key) ?? Promise.resolve()).then(callback); queues.set(key, work.catch(() => {})); return work; } };
}
function setup(storage = memoryStorage(), userId = owner, sharedLocks = locks()) {
  let time = new Date(clock);
  const controller = createProactiveController(storage, { locks: sharedLocks, timeZone: "Europe/Berlin", now: () => new Date(time) });
  controller.setAccount({ status: "ready", userId });
  return { controller, storage, setTime(value) { time = new Date(value); } };
}
async function connect(controller, id = "quotation", restart = false) {
  const view = controller.snapshot();
  const review = controller.reviewTasks(view.token, true).find(entry => entry.record.id === id);
  const result = await controller.connectTask(view.token, review, true, restart);
  assert.equal(result.status, "ready");
  assert.ok(isWorkflowState(result.state, result.state.ownerId));
  return controller.snapshot();
}
async function send(controller, command) {
  const before = controller.snapshot();
  const result = await controller.dispatch(before.token, { caseId: before.state.cases[0].id, ...command });
  assert.equal(result.status, "ready");
  return controller.snapshot();
}
function editPlanner(storage, fields) {
  const planner = JSON.parse(storage.values.get("aiask-planner"));
  planner.todos[0] = { ...planner.todos[0], ...fields };
  storage.values.set("aiask-planner", JSON.stringify(planner));
}
const first = view => view.state.cases[0];

test("no legacy task or Idea Box reads occur before explicit source review", async () => {
  const { controller, storage } = setup();
  let view = controller.snapshot();
  await controller.refresh(view.token);
  view = controller.snapshot();
  assert.equal(view.state.cases.length, 0);
  assert.equal(view.insights.length, 0);
  assert.ok(storage.reads.every(key => key === workflowStorageKey(owner) || key === "aiask-daily-check-in:v1:user:" + owner));
  assert.throws(() => controller.reviewTasks(view.token, false), /source_review_consent_required/);
  assert.ok(!storage.reads.includes("aiask-planner"));
  const reviews = controller.reviewTasks(view.token, true);
  assert.equal(reviews.length, 1);
  assert.ok(!storage.reads.includes("aiask-idea-box"));
  assert.equal(controller.snapshot().state.taskSources, undefined);
});

test("Calendar connection is explicit and follow-up only observes the chosen event", async () => {
  const storage = memoryStorage([]);
  const planner = JSON.parse(storage.original);
  planner.events = [
    { id: "selected-event", title: "Prepare the proposal", scheduledDate: "2026-11-20", scheduledTime: "10:00", todoId: "selected-todo", ideaId: null },
    { id: "other-event", title: "Private event", scheduledDate: "2026-11-20", scheduledTime: null, todoId: null, ideaId: null },
  ];
  planner.todos = [{ ...task("selected-todo", { eventId: "selected-event" }), ownerId: owner }];
  storage.values.set("aiask-planner", JSON.stringify(planner));
  const { controller } = setup(storage);
  let view = controller.snapshot();
  assert.ok(!storage.reads.includes("aiask-planner"));
  const beforeDeniedConnection = storage.values.get("aiask-planner");
  await assert.rejects(controller.connectCalendar(view.token, "selected-event", false), /source_ownership_confirmation_required/);
  assert.equal(storage.values.get("aiask-planner"), beforeDeniedConnection);
  const result = await controller.connectCalendar(view.token, "selected-event", true);
  assert.equal(result.status, "ready");
  view = controller.snapshot();
  assert.deepEqual(view.sourceViews.map(source => source.sourceId), ["selected-event"]);
  assert.equal(first(view).sourceType, "calendar");
  assert.equal(first(view).assignedRoleId, "planner");
  const savedPlanner = JSON.parse(storage.values.get("aiask-planner"));
  assert.equal(savedPlanner.events.find(event => event.id === "selected-event").ownerId, owner);
  assert.equal(savedPlanner.todos.find(todo => todo.id === "selected-todo").ownerId, owner);
  assert.equal(savedPlanner.events.find(event => event.id === "other-event").ownerId, undefined);

  savedPlanner.todos[0].status = "Done";
  storage.values.set("aiask-planner", JSON.stringify(savedPlanner));
  await controller.refresh(view.token);
  view = controller.snapshot();
  assert.equal(first(view).workflowStatus, "resolved");
  assert.equal(view.sourceViews.find(source => source.sourceId === "selected-event").status, "completed");
});

test("AI Team conversation follow-up can continue through its created To-do", async () => {
  const { controller, storage } = setup(memoryStorage([]));
  const initial = controller.snapshot();
  const conversation = {
    id: "team-conversation", title: "A thoughtful next step", partnerRole: "planner",
    messages: [{ role: "assistant", kind: "structured_response", status: "completed", content: "A possible plan.", metadata: { structuredResponse: { nextStep: "Draft the first outline." } } }],
  };
  let view = await controller.connectConversation(initial.token, conversation);
  assert.equal(view.status, "ready");
  assert.equal(first(controller.snapshot()).sourceType, "conversation");

  const createdAt = clock.toISOString();
  const todo = task("team-task", { originConversationId: conversation.id, createdAt, dueDate: "" });
  const planner = JSON.parse(storage.values.get("aiask-planner") || '{"events":[],"todos":[]}');
  planner.todos.push(todo);
  storage.values.set("aiask-planner", JSON.stringify(planner));
  view = await controller.captureCreatedTask(view.token, { record: todo, createdAt });
  assert.equal(view.status, "ready");
  const followedTask = view.state.cases.find(item => item.sourceId === todo.id);
  assert.ok(followedTask);
  assert.equal(followedTask.sourceType, "task");
  assert.equal(followedTask.conversationId, conversation.id);
  const handoff = controller.coachHandoff(view.token, followedTask.id);
  assert.equal(handoff.teamSource.record.nextStep, "Draft the first outline.");
  assert.ok(storage.reads.every(key => key !== "aiask-idea-box"));
});

test("a reviewed existing quotation starts clarification and preserves all original business bytes", async () => {
  const { controller, storage } = setup();
  const view = await connect(controller);
  assert.equal(first(view).workflowStatus, "waiting_for_answer");
  assert.equal(first(view).assignedRoleId, "guide");
  assert.match(first(view).currentQuestion.text, /final design drawings and technical specifications/);
  assert.match(first(view).triggerReason, /You reviewed this task/);
  assert.equal(view.state.taskSources[0].record.id, "quotation");
  assert.equal(storage.values.get("aiask-planner"), storage.original);
  assert.equal(storage.values.get("aiask-idea-box"), "private ideas");
  assert.ok(storage.writes.every(key => key === workflowStorageKey(owner)));
  const saved = storage.values.get(workflowStorageKey(owner));
  await controller.refresh(view.token);
  assert.equal(storage.values.get(workflowStorageKey(owner)), saved);
});

test("source approval and Case creation are atomic when storage quota fails", async () => {
  const storage = memoryStorage();
  storage.setItem = () => { throw new Error("quota exceeded"); };
  const { controller } = setup(storage);
  const view = controller.snapshot();
  const review = controller.reviewTasks(view.token, true)[0];
  assert.equal((await controller.connectTask(view.token, review, true)).status, "write_failed");
  assert.equal(controller.snapshot().state.taskSources, undefined);
  assert.equal(controller.snapshot().state.cases.length, 0);
});

test("ownership confirmation and fresh reviewed content are both required", async () => {
  const { controller, storage } = setup();
  const view = controller.snapshot();
  const review = controller.reviewTasks(view.token, true)[0];
  await assert.rejects(controller.connectTask(view.token, review, false), /source_ownership_confirmation_required/);
  editPlanner(storage, { title: "Changed after the preview was shown" });
  assert.equal((await controller.connectTask(view.token, review, true)).status, "invalid_update");
  assert.equal(controller.snapshot().state.cases.length, 0);
  assert.equal(controller.snapshot().state.taskSources, undefined);
});

test("full reviewed quotation flow links Coach, preserves confirmation, and follows up after reopening", async () => {
  const { controller, storage, setTime } = setup();
  let view = await connect(controller);
  view = await send(controller, { type: "answer", questionId: first(view).currentQuestion.id, text: "  I'm missing the final design drawings.\n" });
  assert.equal(first(view).memory.confirmedFacts.length, 0);
  assert.equal(first(view).blocker, null);
  view = await send(controller, { type: "confirm_inference", inferenceId: first(view).memory.inferences[0].id });
  const handoff = controller.coachHandoff(view.token, first(view).id);
  assert.equal(handoff.context.confirmedFacts.length, 1);
  assert.equal(handoff.context.unconfirmedInferences.length, 0);
  assert.equal(handoff.locale, "en");
  const context = workflowCoachContext(handoff);
  assert.match(context.relevantDecisions[0], /User-confirmed/);
  assert.ok(!JSON.stringify(context).includes("private ideas"));
  view = await send(controller, { type: "link_conversation", conversationId: "owned-coach-thread" });
  view = await send(controller, { type: "schedule_followup", at: localFollowUpInstant("2026-11-19T10:00", "Europe/Berlin") });
  assert.equal(first(view).workflowStatus, "waiting_for_followup");
  setTime("2026-11-19T09:00:00.000Z");
  const reopened = setup(storage);
  reopened.setTime("2026-11-19T09:00:00.000Z");
  await reopened.controller.refresh(reopened.controller.snapshot().token);
  view = reopened.controller.snapshot();
  assert.match(view.insights[0].question.text, /Last time.*drawings/);
  assert.equal(first(view).conversationId, "owned-coach-thread");
  view = await send(reopened.controller, { type: "followup_result", questionId: first(view).currentQuestion.id, outcome: "still_waiting" });
  view = await send(reopened.controller, { type: "snooze", until: "2026-11-20T09:00:00.000Z" });
  assert.equal(first(view).workflowStatus, "snoozed");
  assert.equal(storage.values.get("aiask-planner"), storage.original);
});

test("changed source details never appear in insights or Coach before a fresh review", async () => {
  const { controller, storage } = setup();
  const before = await connect(controller);
  editPlanner(storage, { title: "UNAPPROVED PRIVATE TEXT FROM ANOTHER EDIT", priority: "urgent" });
  let view = controller.snapshot();
  assert.equal(view.insights.length, 0);
  assert.equal(view.sourceViews[0].status, "changed");
  assert.ok(!JSON.stringify(view).includes("UNAPPROVED PRIVATE TEXT"));
  assert.throws(() => controller.coachHandoff(before.token, first(before).id), /source_review_required/);
  const rejected = await controller.dispatch(before.token, { type: "answer", caseId: first(before).id, questionId: first(before).currentQuestion.id, text: "An answer to the old question" });
  assert.equal(rejected.status, "invalid_update");
  assert.equal(first(controller.snapshot()).memory.answers.length, 0);
  await controller.refresh(before.token);
  view = controller.snapshot();
  assert.equal(first(view).workflowStatus, "pending");
  assert.ok(first(view).memory.questions[0].invalidatedAt);
  view = await connect(controller);
  assert.match(first(view).sourceSnapshot.title, /UNAPPROVED PRIVATE TEXT/);
  assert.equal(first(view).triggerType, "source_updated");
  assert.ok(isWorkflowState(view.state, owner));
});

test("completed tasks stop automatically without importing other changed fields", async () => {
  const { controller, storage } = setup();
  const before = await connect(controller);
  editPlanner(storage, { status: "Done", title: "UNREVIEWED COMPLETION TITLE", dueDate: "2026-12-31" });
  assert.equal(controller.snapshot().insights.length, 0);
  await controller.refresh(before.token);
  const view = controller.snapshot();
  assert.equal(first(view).workflowStatus, "resolved");
  assert.equal(first(view).nextFollowUpAt, null);
  assert.equal(first(view).sourceSnapshot.title, task().title);
  assert.ok(!JSON.stringify(view).includes("UNREVIEWED COMPLETION TITLE"));
});

test("deleted or unreadable sources pause prompts rather than infer deletion or discard memory", async () => {
  for (const raw of [JSON.stringify({ todos: [], events: [] }), "{invalid json"]) {
    const { controller, storage } = setup();
    const initial = await connect(controller);
    storage.values.set("aiask-planner", raw);
    await controller.refresh(initial.token);
    const view = controller.snapshot();
    assert.equal(view.insights.length, 0);
    assert.equal(first(view).workflowStatus, "pending");
    assert.equal(first(view).memory.questions.length, 1);
    assert.ok(["missing", "unavailable"].includes(view.sourceViews[0].status));
    assert.equal(storage.values.get("aiask-planner"), raw);
  }
});

test("source edits do not wake a future agreed follow-up; approval resumes at the chosen time", async () => {
  const { controller, storage, setTime } = setup();
  let view = await connect(controller);
  view = await send(controller, { type: "answer", questionId: first(view).currentQuestion.id, text: "Waiting for drawings." });
  view = await send(controller, { type: "schedule_followup", at: "2026-11-20T09:00:00.000Z" });
  editPlanner(storage, { dueDate: "2026-11-24" });
  await controller.refresh(view.token);
  view = await connect(controller);
  assert.equal(first(view).workflowStatus, "waiting_for_followup");
  assert.equal(first(view).nextFollowUpAt, "2026-11-20T09:00:00.000Z");
  setTime("2026-11-20T09:00:00.000Z");
  await controller.refresh(view.token);
  assert.equal(controller.snapshot().insights.length, 1);
});

test("Snooze and Dismiss survive refresh; only an explicit reviewed restart reopens a closed Case", async () => {
  const { controller, storage, setTime } = setup();
  let view = await connect(controller);
  view = await send(controller, { type: "snooze", until: "2026-11-19T09:00:00.000Z" });
  setTime("2026-11-19T09:00:00.000Z");
  await controller.refresh(view.token);
  view = await send(controller, { type: "dismiss" });
  assert.equal(first(view).workflowStatus, "dismissed");
  assert.equal(first(setup(storage).controller.snapshot()).workflowStatus, "dismissed");
  view = await connect(controller);
  assert.equal(first(view).workflowStatus, "dismissed");
  view = await connect(controller, "quotation", true);
  assert.equal(first(view).workflowStatus, "waiting_for_answer");
  assert.equal(view.state.cases.length, 1);
  assert.ok(first(view).memory.history.some(entry => entry.event === "user_restarted_after_source_review"));
});

test("changed sources free visible capacity while other reviewed tasks keep moving", async () => {
  const storage = memoryStorage([task("first"), task("second")]);
  const { controller } = setup(storage);
  let view = await connect(controller, "first");
  view = await connect(controller, "second");
  assert.equal(view.insights.length, 1);
  editPlanner(storage, { title: "Needs a fresh review" });
  await controller.refresh(view.token);
  view = controller.snapshot();
  assert.equal(view.insights.length, 1);
  assert.equal(view.insights[0].sourceId, "second");
});

test("accounts, stale review tokens and A -> B -> A transitions isolate all new workflow data", async () => {
  const { controller, storage } = setup();
  const a = await connect(controller);
  const review = controller.reviewTasks(a.token, true)[0];
  controller.setAccount({ status: "loading" });
  assert.equal(controller.snapshot().state, null);
  controller.setAccount({ status: "ready", userId: "phase2-user-b" });
  storage.reads.length = 0;
  const b = controller.snapshot();
  assert.equal(b.state.cases.length, 0);
  assert.equal(b.state.taskSources, undefined);
  assert.ok(!storage.reads.includes("aiask-planner"));
  assert.throws(() => controller.reviewTasks(a.token, true), /account_changed/);
  assert.equal((await controller.connectTask(a.token, review, true)).status, "account_changed");
  controller.setAccount({ status: "ready", userId: owner });
  assert.equal((await controller.refresh(a.token)).status, "account_changed");
  assert.equal(controller.snapshot().state.cases.length, 1);
});

test("concurrent source approvals re-read the shared envelope and never drop another tab's Case", async () => {
  const storage = memoryStorage([task("one"), task("two")]);
  const manager = locks();
  const a = setup(storage, owner, manager).controller;
  const b = setup(storage, owner, manager).controller;
  const av = a.snapshot(), bv = b.snapshot();
  const ar = a.reviewTasks(av.token, true)[0], br = b.reviewTasks(bv.token, true)[1];
  const results = await Promise.all([a.connectTask(av.token, ar, true), b.connectTask(bv.token, br, true)]);
  assert.ok(results.every(result => result.status === "ready"));
  const view = a.snapshot();
  assert.equal(view.state.cases.length, 2);
  assert.equal(view.state.taskSources.length, 2);
  assert.equal(view.insights.length, 1);
});

test("Phase 1 envelopes remain compatible; malformed approvals preserve the entire existing store", async () => {
  const old = createWorkflowState(owner);
  const storage = memoryStorage();
  storage.values.set(workflowStorageKey(owner), JSON.stringify(old));
  const { controller } = setup(storage);
  assert.equal(controller.snapshot().status, "ready");
  await connect(controller);
  const malformed = JSON.parse(storage.values.get(workflowStorageKey(owner)));
  malformed.taskSources[0].ownerId = "another-user";
  const original = JSON.stringify(malformed);
  storage.values.set(workflowStorageKey(owner), original);
  assert.equal(controller.snapshot().status, "corrupt");
  assert.equal(storage.values.get(workflowStorageKey(owner)), original);
});

test("Daily Briefing preserves task summaries and the old entry point no longer mounts a question engine", () => {
  const storage = memoryStorage([task("managed"), task("other")]);
  const records = readWorkspaceRecords(storage);
  const briefing = buildDailyCheckIn(records, clock);
  assert.equal(briefing.dueSoon.length, 2);
  assert.equal(LegacyDailyCheckIn, DailyBriefing);
});

test("earlier replies remain available as read-only history without a second proactive question card", () => {
  const raw = JSON.stringify({ version: 1, localDataAllowed: true, enabled: true, muted: [], questions: {
    '["deadline","legacy","2026-10-30"]': { status: "answered", answer: { kind: "overdue", at: clock.getTime(), text: "I already contacted the client." } },
  } });
  const answers = recordedDailyAnswers(decodeDailyState(raw, false));
  const html = renderToStaticMarkup(React.createElement(LegacyCheckInReplies, { answers }));
  assert.match(html, /I already contacted the client/);
  assert.match(html, /read-only history/);
  assert.match(html, /Proactive Insights/);
  assert.ok(!html.includes("<textarea"));
  assert.ok(!html.includes("Rephrase with AI"));
  assert.ok(!html.includes("Show proactive questions"));
});

test("new tasks captured from a verified creation event are connected once without scanning older tasks", async () => {
  const { controller, storage } = setup();
  const view = controller.snapshot();
  const event = { record: task(), createdAt: clock.toISOString() };
  const result = await captureCreatedTaskAfterVerification(controller, event, async () => owner);
  assert.equal(result.status, "ready");
  assert.equal(result.state.taskSources[0].provenance, "user_created");
  assert.equal(result.state.cases[0].workflowStatus, "waiting_for_answer");
  assert.equal(result.state.cases[0].triggerType, "task_needs_clarification");
  const saved = storage.values.get(workflowStorageKey(owner));
  await controller.captureCreatedTask(view.token, event);
  assert.equal(storage.values.get(workflowStorageKey(owner)), saved);
  assert.equal(storage.values.get("aiask-planner"), storage.original);
});

test("fresh account re-verification rejects stale creation callbacks, including a switch while verification is pending", async () => {
  const { controller, storage } = setup();
  const event = { record: task(), createdAt: clock.toISOString() };
  assert.equal((await captureCreatedTaskAfterVerification(controller, event, async () => "other-user")).status, "account_changed");
  let complete;
  const pending = captureCreatedTaskAfterVerification(controller, event, () => new Promise(resolve => { complete = resolve; }));
  controller.setAccount({ status: "loading" });
  controller.setAccount({ status: "ready", userId: "other-user" });
  complete(owner);
  assert.equal((await pending).status, "account_changed");
  assert.equal(storage.writes.length, 0);
});

test("creation events cannot approve stale content or silently approve later edits", async () => {
  const { controller, storage } = setup();
  const token = controller.snapshot().token;
  assert.equal((await controller.captureCreatedTask(token, { record: task(), createdAt: "2026-11-18T08:00:00.000Z" })).status, "invalid_update");
  await controller.captureCreatedTask(token, { record: task(), createdAt: clock.toISOString() });
  editPlanner(storage, { title: "Unreviewed edit" });
  const result = await controller.captureCreatedTask(token, { record: task("quotation", { title: "Unreviewed edit" }), createdAt: clock.toISOString() });
  assert.equal(result.status, "invalid_update");
  assert.equal(controller.snapshot().state.taskSources[0].record.title, task().title);
});

test("captured task creation is retained while prompts are off and resumes when explicitly enabled", async () => {
  const { controller } = setup();
  let token = controller.snapshot().token;
  await controller.settings(token, { enabled: false });
  const result = await controller.captureCreatedTask(token, { record: task(), createdAt: clock.toISOString() });
  assert.equal(result.state.cases.length, 0);
  assert.equal(result.state.taskSources.length, 1);
  await controller.settings(token, { enabled: true });
  assert.equal(controller.snapshot().insights.length, 1);
});

test("retiring legacy questions preserves a previous global opt-out without migrating old replies into workflows", async () => {
  const storage = memoryStorage();
  const legacyKey = "aiask-daily-check-in:v1:user:" + owner;
  const oldRaw = JSON.stringify({ version: 1, enabled: false, localDataAllowed: true, muted: [], questions: {
    '["deadline","old","2026-10-30"]': { status: "answered", answer: { kind: "overdue", at: clock.getTime(), text: "Private earlier reply" } },
  } });
  storage.values.set(legacyKey, oldRaw);
  const { controller } = setup(storage);
  assert.equal(controller.snapshot().state.settings.enabled, false);
  await connect(controller);
  const before = controller.snapshot();
  assert.equal(before.insights.length, 0);
  assert.ok(!JSON.stringify(before.state).includes("Private earlier reply"));
  await controller.settings(before.token, { enabled: true });
  assert.equal(controller.snapshot().insights.length, 1);
  assert.equal(storage.values.get(legacyKey), oldRaw);
});

test("generic blockers are only candidate interpretations until the user confirms them", async () => {
  const { controller } = setup();
  let view = await connect(controller);
  view = await send(controller, { type: "answer", questionId: first(view).currentQuestion.id, text: "Waiting for client approval." });
  assert.equal(first(view).blocker, null);
  assert.equal(first(view).memory.confirmedFacts.length, 0);
  assert.match(first(view).memory.inferences[0].text, /Waiting for client approval/);
  view = await send(controller, { type: "confirm_inference", inferenceId: first(view).memory.inferences[0].id });
  assert.match(first(view).blocker.text, /Waiting for client approval/);
});

test("local follow-up time conversion handles selected zones, year rollover and DST explicitly", () => {
  assert.equal(localFollowUpInstant("2026-11-19T10:00", "Europe/Berlin"), "2026-11-19T09:00:00.000Z");
  assert.equal(localFollowUpInstant("2026-12-31T23:30", "America/New_York"), "2027-01-01T04:30:00.000Z");
  assert.equal(localFollowUpInstant("2026-11-19T10:15", "Asia/Kathmandu"), "2026-11-19T04:30:00.000Z");
  assert.throws(() => localFollowUpInstant("2026-03-29T02:30", "Europe/Berlin"), /nonexistent_local_time/);
  assert.throws(() => localFollowUpInstant("2026-10-25T02:30", "Europe/Berlin"), /ambiguous_local_time/);
  assert.throws(() => localFollowUpInstant("2026-02-30T10:00", "Europe/Berlin"), /invalid_local_followup_time/);
  assert.match(formatWorkflowTime("2026-11-19T09:00:00.000Z", "Europe/Berlin"), /10:00/);
});

test("Coach receives only the chosen workflow, with proposals clearly labelled and no model calls on handoff", async () => {
  const { controller } = setup();
  let view = await connect(controller);
  view = await send(controller, { type: "answer", questionId: first(view).currentQuestion.id, text: "Missing the final design drawings." });
  const handoff = controller.coachHandoff(view.token, first(view).id);
  const context = workflowCoachContext(handoff);
  assert.equal(context.relevantDecisions.length, 0);
  assert.ok(context.relevantNotes.some(note => note.startsWith("UNCONFIRMED rule proposal:")));
  assert.equal(first(view).conversationId, null);
  assert.equal(handoff.partnerRole, "guide");
});

test("English UI has a sign-in boundary and does not render a response form for paused or capped questions", async () => {
  const html = renderToStaticMarkup(React.createElement(ProactiveInsights, { account: { status: "ready", userId: null }, onDiscuss() {}, conversationLink: null }));
  assert.match(html, /Sign in/);
  assert.ok(!html.includes("Show tasks for review"));
  const { controller } = setup();
  const view = await connect(controller);
  const props = { item: first(view), current: false, showQuestion: false, enabled: true, busy: false, timeZone: "Europe/Berlin", sourceStatus: "changed", onReview() {}, onDiscuss() {}, command: async () => true };
  const paused = renderToStaticMarkup(React.createElement(TaskCaseCard, props));
  assert.match(paused, /Questions are paused/);
  assert.ok(!paused.includes("<textarea"));
  assert.ok(!paused.includes("Have the final design drawings"));
  const visible = renderToStaticMarkup(React.createElement(TaskCaseCard, { ...props, current: true, showQuestion: true }));
  assert.match(visible, /Your answer/);
  assert.match(visible, /Save answer/);
  const capped = renderToStaticMarkup(React.createElement(TaskCaseCard, { ...props, current: true }));
  assert.ok(!capped.includes("<textarea"));
});
