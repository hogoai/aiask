const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const ts = require("typescript");

process.env.TZ = "Europe/Berlin";
const originalLoader = require.extensions[".ts"];
require.extensions[".ts"] = (module, path) => module._compile(ts.transpileModule(readFileSync(path, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, path);
const { readWorkspaceRecords } = require("../src/lib/workspace/browser-records.ts");
const { buildWeeklyReview, weeklyReviewRange } = require("../src/lib/workspace/weekly-review.ts");
const { parseWeeklyCoachFacts } = require("../src/lib/workspace/weekly-coach.ts");

let verifiedUser = { id: "weekly-test-user" };
const authPath = require.resolve("../src/lib/supabase/server.ts");
require.cache[authPath] = {
  id: authPath, loaded: true,
  exports: { createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: verifiedUser } }) },
    from: () => assert.fail("Weekly review must not query or modify the database"),
  }) },
};
const { POST } = require("../src/app/api/ai/run/route.ts");
if (originalLoader) require.extensions[".ts"] = originalLoader;
else delete require.extensions[".ts"];

const now = new Date(2026, 10, 18, 11, 30);
const timestamp = (day, hours = 11) => new Date(2026, 10, day, hours).toISOString();
const todo = (id, fields = {}) => ({ id, title: id, status: "Open", dueDate: "", ...fields });
const appointment = (id, day, fields = {}) => ({ id, title: id, scheduledDate: "2026-11-" + day, scheduledTime: "10:30", ...fields });
const idea = (id, fields = {}) => ({ id, text: id, createdAt: timestamp(1), status: "In progress", ...fields });
function fixture({ todos = [], events = [], ideas = [] } = {}) {
  const data = { "aiask-planner": JSON.stringify({ todos, events }), "aiask-idea-box": JSON.stringify(ideas) };
  return { getItem: key => data[key] ?? null };
}
function report(rows, period = "current", clock = now) {
  return buildWeeklyReview(readWorkspaceRecords(fixture(rows)), clock, period);
}
function titles(items) {
  return items.map(item => item.title);
}

test("weekly ranges use local Monday through Sunday, including DST and year changes", () => {
  const afterDst = weeklyReviewRange(new Date(2026, 9, 26, 0, 5), "previous");
  assert.deepEqual(afterDst.week, { start: "2026-10-19", last: "2026-10-25", endExclusive: "2026-10-26" });
  assert.deepEqual(afterDst.following, { start: "2026-10-26", last: "2026-11-01", endExclusive: "2026-11-02" });
  assert.deepEqual(weeklyReviewRange(new Date(2027, 0, 3, 23, 55), "current").week,
    { start: "2026-12-28", last: "2027-01-03", endExclusive: "2027-01-04" });
});

test("completion dates are converted to local days and never inferred from deadlines or future timestamps", () => {
  const rows = { todos: [
    todo("Late Sunday UTC, Monday here", { status: "Done", completedAt: "2026-11-15T23:05:00.000Z" }),
    todo("Earlier Sunday local", { status: "Done", completedAt: "2026-11-15T22:55:00.000Z" }),
    todo("Missing", { status: "Done", dueDate: "2026-11-17" }),
    todo("Bad timestamp", { status: "Done", completedAt: "unknown" }),
    todo("Future completion", { status: "Done", completedAt: timestamp(19) }),
    todo("Reopened", { status: "Open", completedAt: timestamp(17), dueDate: "2026-11-17" }),
    todo("Undated open"),
  ] };
  const current = report(rows);
  assert.deepEqual(titles(current.groups.completed), ["Late Sunday UTC, Monday here"]);
  assert.equal(current.summaryFacts.counts.undatedCompletions, 3);
  assert.deepEqual(titles(current.groups.openDue), ["Reopened", "Undated open"]);
  assert.equal(current.summaryFacts.counts.openDue, 1);
  assert.equal(current.summaryFacts.counts.openUndated, 1);
  assert.deepEqual(titles(report(rows, "previous").groups.completed), ["Earlier Sunday local"]);
});

test("calendar review counts only scheduled records, merging duplicates and excluding task mirrors", () => {
  const rows = {
    events: [
      appointment("Appointment", "17", { origin: "calendar", todoId: "linked-calendar-task" }),
      appointment("Duplicate", "17", { origin: "calendar", todoId: "linked-calendar-task" }),
      appointment("All day", "18", { origin: "calendar", scheduledTime: null }),
      appointment("Deadline mirror", "19", { origin: "task-deadline", todoId: "work" }),
      appointment("Following Monday", "23", { origin: "calendar" }),
    ],
    todos: [
      todo("linked-calendar-task", { status: "Done", completedAt: timestamp(17) }),
      todo("work", { dueDate: "2026-11-19" }),
    ],
  };
  const review = report(rows);
  assert.deepEqual(titles(review.groups.scheduled), ["Appointment", "All day"]);
  assert.deepEqual(titles(review.groups.openDue), ["work"]);
  assert.equal(review.summaryFacts.counts.completed, 0);
});

test("idea progress, attention and following-week priorities use the recorded dates and explicit priority", () => {
  const rows = {
    ideas: [
      idea("Latest this week", { status: "Done", progressUpdatedAt: timestamp(17), nextStep: "An existing note" }),
      idea("Previous update", { progressUpdatedAt: timestamp(12), updatedAt: timestamp(17), nextStep: "Draft" }),
      idea("Stale idea", { progressUpdatedAt: timestamp(1), nextStep: "Outline" }),
      idea("Plan without progress", { nextStep: "Research" }),
      idea("Invalid progress", { progressUpdatedAt: "unknown", nextStep: "Existing plan" }),
    ],
    todos: [
      todo("Urgent carryover", { dueDate: "2026-11-16", priority: "urgent" }),
      todo("Following deadline", { dueDate: "2026-11-23" }),
      todo("Last day of following week", { dueDate: "2026-11-29", priority: "attention" }),
      todo("Too far", { dueDate: "2026-11-30", priority: "urgent" }),
      todo("Old actual update", { priority: "urgent", updatedAt: timestamp(1) }),
      todo("Creation isn’t an update", { priority: "urgent", createdAt: timestamp(1) }),
    ],
    events: [
      appointment("Important plan", "24", { priority: "urgent" }),
      appointment("No elevated priority", "24"),
    ],
  };
  const current = report(rows);
  assert.deepEqual(titles(current.groups.ideaProgress), ["Latest this week"]);
  assert.equal(current.groups.ideaProgress[0].nextStep, "An existing note");
  assert.deepEqual(titles(report(rows, "previous").groups.ideaProgress), ["Previous update"]);
  assert.deepEqual(titles(current.groups.needsFollowUp).sort(), ["Old actual update", "Plan without progress", "Stale idea"]);
  assert.deepEqual(titles(current.groups.nextFocus), ["Urgent carryover", "Important plan", "Last day of following week", "Following deadline"]);
  assert.equal(current.summaryFacts.counts.nextUrgent, 2);
});

test("unreadable records are flagged without discarding usable data, and review has no business writes", () => {
  const storage = fixture({ ideas: [idea("Usable check-in", { progressUpdatedAt: timestamp(17) })] });
  const data = readWorkspaceRecords({ getItem: key => key === "aiask-planner" ? "not JSON" : storage.getItem(key) });
  const result = buildWeeklyReview(data, now, "current");
  assert.equal(result.summaryFacts.partial, true);
  assert.deepEqual(titles(result.groups.ideaProgress), ["Usable check-in"]);
  assert.deepEqual(result.groups.completed, []);
  assert.equal(result.summaryFacts.counts.completed, 0);
});

test("Coach accepts only aggregate review facts and rejects invalid dates, counts and added record text", () => {
  const { summaryFacts: facts } = report({ todos: [todo("Title stays local", { dueDate: "2026-11-17" })] });
  assert.deepEqual(parseWeeklyCoachFacts(facts), facts);
  assert.ok(!JSON.stringify(facts).includes("Title stays local"));
  assert.equal(parseWeeklyCoachFacts({ ...facts, weekStart: "2026-11-17" }), null);
  assert.equal(parseWeeklyCoachFacts({ ...facts, weekStart: "2026-02-30" }), null);
  assert.equal(parseWeeklyCoachFacts({ ...facts, asOf: "2026-11-30" }), null);
  assert.equal(parseWeeklyCoachFacts({ ...facts, title: "Title" }), null);
  assert.equal(parseWeeklyCoachFacts({ ...facts, counts: { ...facts.counts, openDue: -1 } }), null);
  assert.equal(parseWeeklyCoachFacts({ ...facts, counts: { ...facts.counts, nextUrgent: 9 } }), null);
});

test("Coach endpoint verifies the account and sends only counts to the provider without touching history", async t => {
  const values = {
    NEXT_PUBLIC_SUPABASE_URL: "http://localhost", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "fake",
    DEEPSEEK_API_KEY: "test-key", DEEPSEEK_BASE_URL: "http://localhost",
  };
  const environment = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, values);
  const { summaryFacts: facts } = report({ todos: [todo("Private title", { dueDate: "2026-11-17" })] });
  const summary = { reflection: "可以先看看仍标为待办的事项。", nextStep: "选一项确认下一步。" };
  let calls = 0;
  let reply = summary;
  global.fetch = async (url, options) => {
    assert.equal(url, "http://localhost/responses");
    const body = JSON.parse(options.body);
    assert.equal(body.store, false);
    assert.deepEqual(JSON.parse(body.input[0].content), facts);
    assert.ok(body.instructions.includes("Simplified Chinese"));
    calls++;
    return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(reply) }] }] });
  };
  const run = overrides => POST(new Request("http://localhost/api/ai/run", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "weekly_review", locale: "zh-CN", facts, expectedUserId: "weekly-test-user", ...overrides }),
  }));
  assert.equal((await run({ expectedUserId: "other" })).status, 409);
  assert.equal((await run({ title: "Private title" })).status, 400);
  assert.equal(calls, 0);
  const success = await run({});
  assert.equal(success.status, 200);
  assert.deepEqual(await success.json(), { summary });
  reply = { reflection: "" };
  assert.equal((await run({})).status, 502);
  verifiedUser = null;
  assert.equal((await run({})).status, 401);
  assert.equal(calls, 2);
});
