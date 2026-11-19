const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const ts = require("typescript");
const previousLoader = require.extensions[".ts"];
require.extensions[".ts"] = (module, path) => module._compile(ts.transpileModule(readFileSync(path, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, path);
const { parseAIASKRunRequest, validatePlannerChange } = require("../src/lib/ai/contracts.ts");
const {
  applyPlannerChange,
  buildCalendarPlannerContext,
  buildTodoPlannerContext,
} = require("../src/lib/planner/ai-planner.ts");
if (previousLoader) require.extensions[".ts"] = previousLoader;
else delete require.extensions[".ts"];

const initialPlanner = {
  events: [
    { id: "event-today", todoId: "task-linked", ideaId: "idea-a", title: "Design review", scheduledDate: "2026-04-04", scheduledTime: "10:00", description: "Design review", createdAt: "2026-04-01T10:00:00Z", origin: "calendar" },
    { id: "event-other", todoId: null, ideaId: null, title: "Other day", scheduledDate: "2026-04-05", scheduledTime: null, description: "Other day", createdAt: "2026-04-01T10:00:00Z" },
  ],
  todos: [
    { id: "task-linked", eventId: "event-today", ideaId: "idea-a", title: "Prepare review", dueDate: "2026-04-04", status: "Open", priority: "urgent", createdAt: "2026-04-01T10:00:00Z", remindAt: "2026-04-04T09:00:00Z", ownerId: "private-owner" },
    { id: "task-other", eventId: null, ideaId: "idea-b", title: "Finish draft", dueDate: "2026-04-05", status: "Done", priority: "onTrack", createdAt: "2026-04-01T10:00:00Z" },
  ],
};

function plannerChange(action, properties = {}) {
  return {
    action, targetId: null, fields: [], title: null, dueDate: null, scheduledDate: null,
    scheduledTime: null, status: null, priority: null, ideaId: null, ...properties,
  };
}

test("calendar context includes only the selected date, linked tasks, and their related ideas", () => {
  const context = buildCalendarPlannerContext("2026-04-04", initialPlanner.events, initialPlanner.todos, [
    { id: "idea-a", text: "Build a portfolio" }, { id: "idea-b", text: "Unrelated thought" },
  ]);
  assert.deepEqual(context.relevantCalendarItems.map(item => JSON.parse(item).id), ["event-today"]);
  assert.deepEqual(context.relevantTasks.map(item => JSON.parse(item).id), ["task-linked"]);
  assert.deepEqual(context.relevantNotes.map(item => JSON.parse(item).id), ["idea-a"]);
  assert.equal(context.relevantTasks[0].includes("private-owner"), false);
  assert.equal(context.relevantTasks[0].includes("remindAt"), false);
});

test("to-do context includes saved task state and linked idea but omits reminder and owner data", () => {
  const context = buildTodoPlannerContext(initialPlanner.todos, initialPlanner.events, [
    { id: "idea-a", text: "Build a portfolio" }, { id: "idea-b", text: "Unrelated thought" },
  ]);
  assert.deepEqual(context.relevantTasks.map(item => JSON.parse(item).id), ["task-linked", "task-other"]);
  assert.deepEqual(context.relevantNotes.map(item => JSON.parse(item).id), ["idea-a", "idea-b"]);
  assert.equal(context.relevantTasks.join(" ").includes("private-owner"), false);
  assert.equal(context.relevantTasks.join(" ").includes("remindAt"), false);
});

test("confirmed task creation creates one linked deadline mirror and carries proactive origin", () => {
  const change = plannerChange("create_task", { title: "Send proposal", dueDate: "2026-04-06", priority: "attention" });
  const applied = applyPlannerChange(initialPlanner, change, {
    now: "2026-04-04T12:00:00Z", ownerId: "user-a", conversationId: "conversation-a",
    createId: (() => { let id = 0; return () => `new-${++id}`; })(),
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.planner.todos[0].originConversationId, "conversation-a");
  assert.equal(applied.planner.todos[0].eventId, applied.planner.events.at(-1).id);
  assert.equal(applied.planner.events.at(-1).origin, "task-deadline");
  assert.equal(initialPlanner.todos.length, 2);
});

test("calendar event creation follows existing linked-task behavior and duplicate creates are rejected", () => {
  const change = plannerChange("create_calendar_event", {
    title: "Design review", scheduledDate: "2026-04-04", scheduledTime: "10:00",
  });
  const duplicate = applyPlannerChange(initialPlanner, change, {
    now: "2026-04-04T12:00:00Z", conversationId: "conversation-a", createId: () => "unused",
  });
  assert.equal(duplicate.ok, false);

  const nextChange = plannerChange("create_calendar_event", {
    title: "Client call", scheduledDate: "2026-04-04", scheduledTime: "13:30",
  });
  const created = applyPlannerChange(initialPlanner, nextChange, {
    now: "2026-04-04T12:00:00Z", conversationId: "conversation-a",
    createId: (() => { let id = 0; return () => `meeting-${++id}`; })(),
  });
  assert.equal(created.ok, true);
  assert.equal(created.planner.events.at(-1).todoId, created.planner.todos[0].id);
  assert.equal(created.planner.todos[0].eventId, created.planner.events.at(-1).id);
});

test("task update synchronizes its linked event and deletion removes the linked pair", () => {
  const update = plannerChange("update_task", {
    targetId: "task-linked", fields: ["dueDate", "title"], dueDate: "2026-04-07", title: "Prepare final review",
  });
  const changed = applyPlannerChange(initialPlanner, update, {
    now: "2026-04-04T12:00:00Z", conversationId: "conversation-a", createId: () => "unused",
  });
  assert.equal(changed.ok, true);
  assert.equal(changed.planner.events.find(event => event.id === "event-today").scheduledDate, "2026-04-07");
  assert.equal(changed.planner.events.find(event => event.id === "event-today").title, "Prepare final review");

  const deleted = applyPlannerChange(initialPlanner, plannerChange("delete_task", { targetId: "task-linked" }), {
    now: "2026-04-04T12:00:00Z", conversationId: "conversation-a", createId: () => "unused",
  });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.planner.events.some(event => event.id === "event-today"), false);
  assert.equal(deleted.planner.todos.some(todo => todo.id === "task-linked"), false);
});

test("planner change contract rejects malformed proposals and requires the Planner follow-up role", () => {
  assert.equal(validatePlannerChange(plannerChange("delete_task", { targetId: "missing" })).action, "delete_task");
  assert.equal(validatePlannerChange(plannerChange("update_task", {
    targetId: "task-linked", fields: ["status"], status: null,
  })), null);
  assert.equal(validatePlannerChange(plannerChange("update_calendar_event", {
    targetId: "event-today", fields: ["scheduledDate"], scheduledDate: null,
  })), null);

  const request = parseAIASKRunRequest({
    mode: "follow_up", plannerChat: true, partnerRole: "guide", userMessage: "Move this",
    originalIdea: "Planner", perspectiveContext: "", history: [{ role: "user", content: "Move this" }],
  });
  assert.equal(request.success, false);
});
