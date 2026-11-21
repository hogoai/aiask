const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const ts = require("typescript");

const previousLoader = require.extensions[".ts"];
require.extensions[".ts"] = (module, path) => module._compile(ts.transpileModule(readFileSync(path, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, path);
const { PARTNER_ROLE_IDS, parseAIASKRunRequest, validateNotesChatActions, verifiedNotesContextNoteIds } = require("../src/lib/ai/contracts.ts");
if (previousLoader) require.extensions[".ts"] = previousLoader;
else delete require.extensions[".ts"];

function request(overrides = {}) {
  return {
    mode: "follow_up",
    notesChat: true,
    partnerRole: "guide",
    userMessage: "Summarize the notes.",
    originalIdea: "Current Notes & Ideas view (2 records)",
    perspectiveContext: JSON.stringify({ scope: "Current View", recordCount: 2, records: [{ id: "note-a", text: "First note" }, { id: "note-b", text: "Second note" }] }),
    history: [{ role: "user", content: "Summarize the notes." }],
    notesContextKey: "current-view-2-abc123",
    ...overrides,
  };
}

test("Notes chat reuses the six registered AI Partner roles", () => {
  assert.deepEqual(PARTNER_ROLE_IDS, ["guide", "planner", "knowledge_partner", "evaluator", "advisor", "action_partner"]);
});

test("Notes chat accepts current-view and selected-note scopes but requires an explicit scope", () => {
  assert.equal(parseAIASKRunRequest(request()).success, true);
  assert.equal(parseAIASKRunRequest(request({ notesContextKey: "selected-note-note-a", context: { ideaId: "note-a" } })).success, true);
  assert.equal(parseAIASKRunRequest(request({ notesChat: true, workspaceNotesScope: true, notesContextKey: undefined })).success, true);
  assert.equal(parseAIASKRunRequest(request({ notesContextKey: undefined })).success, false);
  assert.equal(parseAIASKRunRequest(request({ notesChat: undefined, notesContextKey: undefined })).success, true);
  assert.equal(parseAIASKRunRequest(request({ notesContextKey: "other-scope" })).success, false);
  assert.equal(parseAIASKRunRequest(request({ notesContextKey: "selected-note-note-b", context: { ideaId: "note-a" } })).success, false);
  assert.equal(parseAIASKRunRequest(request({ workspaceNotesScope: true, notesContextKey: undefined, context: { ideaId: "note-a" } })).success, false);
});

test("suggested Notes actions require confirmation and references from the active context", () => {
  const action = { action: "create_todo", title: "Review supplier options", description: "Compare the two options recorded.", rationale: "Both appear in the supplied notes.", noteId: "note-a", dueDate: null, content: null, requiresConfirmation: true };
  assert.deepEqual(validateNotesChatActions([action], new Set(["note-a", "note-b"])), [action]);
  assert.equal(validateNotesChatActions([{ ...action, requiresConfirmation: false }], new Set(["note-a"])), null);
  assert.equal(validateNotesChatActions([{ ...action, noteId: "other-note" }], new Set(["note-a", "note-b"])), null);
  assert.equal(validateNotesChatActions([{ ...action, dueDate: "2026-02-31" }], new Set(["note-a"])), null);
  assert.equal(validateNotesChatActions([{ ...action, action: "set_follow_up", content: "Ask for the missing price.", noteId: null }], new Set(["note-a"])), null);
});

test("server context binding accepts only the exact selected note or current-view record IDs", () => {
  const records = [{ id: "note-a", text: "First note" }, { id: "note-b", text: "Second note" }];
  let hash = 2166136261;
  for (const character of records.map(record => record.id).sort().join("|")) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  const viewKey = `current-view-${records.length}-${(hash >>> 0).toString(36)}`;
  const currentView = JSON.stringify({ scope: "Current View", recordCount: records.length, records });
  assert.deepEqual(verifiedNotesContextNoteIds(currentView, viewKey), ["note-a", "note-b"]);
  assert.equal(verifiedNotesContextNoteIds(currentView, "current-view-2-different"), null);
  assert.equal(verifiedNotesContextNoteIds(JSON.stringify({ scope: "Current View", recordCount: 2, records: [records[0], records[0]] }), viewKey), null);
  const selected = JSON.stringify({ scope: "Selected Note", recordCount: 1, records: [records[0]] });
  assert.deepEqual(verifiedNotesContextNoteIds(selected, "selected-note-note-a"), ["note-a"]);
  assert.equal(verifiedNotesContextNoteIds(selected, "selected-note-note-b"), null);
});
