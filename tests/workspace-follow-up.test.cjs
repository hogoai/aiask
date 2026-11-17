const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const ts = require("typescript");

// Keep the tests runnable on the same Node versions as Next.js without a test-only dependency.
const previousTsLoader = require.extensions[".ts"];
const loadTs = (module, path) => module._compile(ts.transpileModule(readFileSync(path, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, path);
require.extensions[".ts"] = loadTs;
const { readWorkspaceRecords, toggleStoredTodo } = require("../src/lib/workspace/browser-records.ts");
const {
  activeQuestion, advanceDailyState, buildDailyCheckIn, decodeDailyState, emptyDailyState, recordedDailyAnswers, saveDailyAnswer,
} = require("../src/lib/workspace/daily-check-in.ts");
if (previousTsLoader) require.extensions[".ts"] = previousTsLoader;
else delete require.extensions[".ts"];

const now = new Date(2026, 10, 17, 11, 30);
const stamp = (day, hour = 11) => new Date(2026, 10, day, hour).toISOString();
const event = (id, date, time, props = {}) => ({ id, title: id, scheduledDate: date, scheduledTime: time, ...props });
const todo = (id, props = {}) => ({ id, title: id, status: "Open", dueDate: "", ...props });
const idea = (id, props = {}) => ({ id, text: id, createdAt: stamp(1), status: "In progress", ...props });

function fixture({ events = [], todos = [], ideas = [] }) {
  const data = new Map([["aiask-planner", JSON.stringify({ events, todos, extra: "keep" })], ["aiask-idea-box", JSON.stringify(ideas)]]);
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}

function summarize(rows, date = now) {
  return buildDailyCheckIn(readWorkspaceRecords(fixture(rows)), date);
}

test("only identical future start times produce one possible calendar conflict with both sources", () => {
  const events = [
    event("Clinic", "2026-11-17", "13:00"),
    event("Call", "2026-11-17", "13:00"),
    event("Later", "2026-11-17", "13:30"),
    event("Unscheduled time", "2026-11-17", null, { origin: "calendar" }),
    event("Deadline mirror", "2026-11-17", "13:00", { origin: "task-deadline" }),
    event("Morning A", "2026-11-17", "09:00"),
    event("Morning B", "2026-11-17", "09:00"),
  ];
  const briefing = summarize({ events });
  const conflicts = briefing.followUps.filter(item => item.kind === "calendarConflict");
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].time, "13:00");
  assert.deepEqual([conflicts[0].title, ...conflicts[0].relatedTitles].sort(), ["Call", "Clinic"]);
  assert.equal(briefing.candidates[0].kind, "calendarConflict");
  assert.equal(summarize({ events: [...events].reverse() }).followUps[0].key, conflicts[0].key);
});

test("prior-day follow-up excludes deadline mirrors, unresolved legacy all-day links, and today's events", () => {
  const events = [
    event("Recorded appointment", "2026-11-16", "10:00", { todoId: "paired" }),
    event("Actual all-day entry", "2026-11-14", null, { todoId: "known", origin: "calendar" }),
    event("Deadline mirror", "2026-11-16", null, { todoId: "due", origin: "task-deadline" }),
    event("Ambiguous legacy pair", "2026-11-16", null, { todoId: "ambiguous" }),
    event("Earlier today", "2026-11-17", "08:00"),
    event("Too old", "2026-11-13", "08:00"),
  ];
  const todos = ["paired", "known", "due", "ambiguous"].map(id => todo(id, { dueDate: id === "known" ? "2026-11-14" : "2026-11-16" }));
  const { followUps } = summarize({ events, todos });
  assert.deepEqual(followUps.filter(item => item.kind === "calendarFollowUp").map(item => item.title), ["Recorded appointment", "Actual all-day entry"]);
  assert.deepEqual(followUps.filter(item => item.kind === "overdue").map(item => item.title).sort(), ["ambiguous", "due"]);
});

test("stale task reminders require an explicit old update and importance, and do not duplicate deadline prompts", () => {
  const todos = [
    todo("Old update", { priority: "urgent", updatedAt: stamp(3) }),
    todo("Boundary", { priority: "attention", updatedAt: new Date(2026, 10, 3, 11, 30).toISOString() }),
    todo("Recent", { priority: "urgent", updatedAt: stamp(4) }),
    todo("Created only", { priority: "urgent", createdAt: stamp(1) }),
    todo("Date-only timestamp", { priority: "urgent", updatedAt: "2026-11-01" }),
    todo("Future timestamp", { priority: "urgent", updatedAt: stamp(18) }),
    todo("No explicit priority", { updatedAt: stamp(1) }),
    todo("Closed", { priority: "urgent", updatedAt: stamp(1), status: "Done" }),
    todo("Soon", { priority: "urgent", updatedAt: stamp(1), dueDate: "2026-11-19" }),
  ];
  const { candidates } = summarize({ todos });
  assert.deepEqual(candidates.filter(item => item.kind === "staleTodo").map(item => item.title), ["Old update", "Boundary"]);
  assert.equal(candidates.filter(item => item.title === "Soon").length, 1);
  assert.equal(candidates.find(item => item.title === "Soon").kind, "dueSoon");
});

test("idea follow-up distinguishes missing progress, recorded updates, and a missing next step", () => {
  const ideas = [
    idea("Planned", { nextStep: "Talk to the team" }),
    idea("Linked action"),
    idea("No next step"),
    idea("Stale", { nextStep: "Collect feedback", progressUpdatedAt: stamp(1), updatedAt: stamp(2) }),
    idea("Recently edited", { nextStep: "Collect feedback", progressUpdatedAt: stamp(1), updatedAt: stamp(5) }),
    idea("Malformed date", { nextStep: "Collect feedback", progressUpdatedAt: "unknown" }),
    idea("Closed idea", { nextStep: "Follow up", status: "Done" }),
    idea("Calendar alone"),
  ];
  const events = [event("Idea event", "2026-11-18", null, { origin: "calendar", todoId: "cal" })];
  const todos = [todo("Linked", { ideaId: "Linked action" }), todo("cal", { ideaId: "Calendar alone", dueDate: "2026-11-18" })];
  const kinds = Object.fromEntries(summarize({ ideas, todos, events }).followUps.map(item => [item.title, item.kind]));
  assert.deepEqual(kinds, {
    "Linked action": "ideaPlanNoProgress", Planned: "ideaPlanNoProgress", Stale: "staleIdea",
    "Calendar alone": "missingNextStep", "No next step": "missingNextStep",
  });
});

test("a reply survives refresh, stays local, and prevents repeating the question", () => {
  const sources = fixture({ events: [event("Appointment", "2026-11-16", "09:00")] });
  const original = [sources.getItem("aiask-planner"), sources.getItem("aiask-idea-box")];
  const briefing = buildDailyCheckIn(readWorkspaceRecords(sources), now);
  const state = advanceDailyState(emptyDailyState(true), briefing.candidates, briefing.today, +now);
  const candidate = activeQuestion(state, briefing.candidates);
  assert.equal(candidate.kind, "calendarFollowUp");
  assert.equal(saveDailyAnswer(state, candidate, "  ", +now), state);
  assert.equal(saveDailyAnswer({ ...state, enabled: false }, candidate, "A note", +now).questions[candidate.key].status, "pending");
  const answered = saveDailyAnswer(state, candidate, "  Record the agreed next step.  ", +now);
  const reloaded = decodeDailyState(JSON.stringify(answered), true);
  assert.equal(reloaded.questions[candidate.key].status, "answered");
  assert.deepEqual(recordedDailyAnswers(reloaded), [{ key: candidate.key, kind: candidate.kind, at: +now, text: "Record the agreed next step." }]);
  assert.equal(saveDailyAnswer(reloaded, candidate, "Do not overwrite", +now), reloaded);
  assert.equal(advanceDailyState(reloaded, briefing.candidates, "2026-11-18", +now), reloaded);
  assert.deepEqual([sources.getItem("aiask-planner"), sources.getItem("aiask-idea-box")], original);
});

test("old question state remains compatible; snooze, dismissal, and mute still apply", () => {
  const briefing = summarize({ todos: [todo("Soon", { dueDate: "2026-11-17" })] });
  const [item] = briefing.candidates;
  const old = {
    ...emptyDailyState(true), lastNewDay: briefing.today,
    questions: { [item.key]: { status: "snoozed", snoozedUntil: +now + 1000 } },
  };
  const state = decodeDailyState(JSON.stringify(old), true);
  assert.equal(advanceDailyState(state, briefing.candidates, briefing.today, +now), state);
  assert.equal(activeQuestion(advanceDailyState(state, briefing.candidates, briefing.today, +now + 1000), briefing.candidates).key, item.key);
  const muted = { ...state, muted: ["deadline"] };
  assert.equal(advanceDailyState(muted, briefing.candidates, briefing.today, +now + 1000), muted);
  const dismissed = { ...state, questions: { [item.key]: { status: "dismissed" } } };
  assert.equal(advanceDailyState(dismissed, briefing.candidates, "2026-11-18", +now + 1000), dismissed);
});

test("manual status changes timestamp only the changed task and preserve existing fields", () => {
  const storage = fixture({
    todos: [todo("Task", { remindAt: stamp(25), extra: { keep: true } }), todo("Untouched")],
    events: [event("Calendar", "2026-11-17", "12:00")],
  });
  const before = JSON.parse(storage.getItem("aiask-planner"));
  assert.equal(toggleStoredTodo(storage, "Task"), true);
  const after = JSON.parse(storage.getItem("aiask-planner"));
  assert.equal(after.todos[0].status, "Done");
  assert.equal(after.todos[0].updatedAt, after.todos[0].completedAt);
  assert.deepEqual(after, {
    ...before, todos: [{ ...before.todos[0], status: "Done", updatedAt: after.todos[0].updatedAt, completedAt: after.todos[0].completedAt }, before.todos[1]],
  });
  assert.equal(toggleStoredTodo(storage, "Task"), true);
  const reopened = JSON.parse(storage.getItem("aiask-planner")).todos[0];
  assert.equal(reopened.status, "Open");
  assert.equal(reopened.completedAt, undefined);
  assert.ok(reopened.updatedAt);
});
