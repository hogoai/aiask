# Proactive Workflow — Phase 2

English-only task integration on top of the Phase 1 engine. This phase adds the Workspace interface, an explicit source-ownership boundary and user-initiated Coach handoff. It does not introduce an execution Agent.

## Product behavior

Proactive Insights is the single active question/follow-up entry in My Workspace. The old standalone Proactive Question card, its second enable switch and its AI-rephrasing button are retired. Daily Briefing still displays dates, upcoming items and items to revisit. Earlier check-in replies are available as read-only history; their storage is neither deleted nor promoted into workflow facts or AI context.

Only a previous global opt-out is carried from the same account's legacy check-in preferences when the new workflow envelope does not yet exist. An existing Proactive Insights preference always takes precedence. Topic muting, old pending questions, snoozes and replies are not silently converted into new Cases.

### Existing tasks

1. Open My Workspace → Proactive Insights → Connect a task.
2. Acknowledge that this browser's old business records may be shared across accounts.
3. Explicitly show browser tasks, choose a task and inspect the selected snapshot's title, due date, status and priority.
4. Confirm that this task belongs to you. The exact snapshot is stored only in your account's workflow envelope.
5. The AI Team asks one question. Answer, confirm/reject candidate interpretations, select a follow-up time, snooze, dismiss or discuss with the Coach.

The approval is a user attestation about this snapshot, not a claim that the shared planner has acquired server-enforced ownership. No shared legacy task is automatically assigned to the signed-in account.

### Newly created tasks

The existing To-do save flow is preserved. A local creation event is published only after `persistPlanner` succeeds. The creation bridge, mounted only in the To-do view, re-verifies the creator with the existing Supabase client. A generation token prevents a late result from being attached to a different account.

A fresh, matching creation event can capture an owner-specific snapshot with `user_created` provenance. It does not mark old rows as new or scan them on startup. Repeated events are idempotent and cannot approve later edits. Old or changed creation events are rejected. If identity/storage verification fails, the original task stays saved and can be connected manually later. Demo/unsigned-in sessions do not capture tasks.

The existing detector handles new quotation tasks or tasks without recorded deadlines. Other captured tasks wait until a useful deadline trigger. Disabled proactive questions remain disabled; a captured creation event can resume only after the user enables questions.

### Source changes and completion

- Title/deadline/priority changes require a fresh review. Old questions are invalidated/held and unreviewed text is excluded from Insights and Coach context.
- A completed linked task can stop follow-up immediately. Only the completion signal is observed; other unreviewed changed fields are not imported.
- Missing or unreadable sources pause questioning without inferring deletion or discarding memory.
- Reviewing changes preserves a future agreed follow-up/snooze time. A due follow-up is checked on reopen, focus, visibility return and a lightweight active-page timer.
- A dismissed/resolved Case stays closed unless the user explicitly reviews the task and confirms a restart. This reuses the original Case and retains its history.

### Coach

Discuss with Coach prepares an editable draft and shares only the selected workflow's reviewed task, dated confirmed facts, labelled unconfirmed proposals and original answers. No model call or conversation creation occurs until the user sends the question.

The assigned Partner uses its existing official role ID. A linked conversation can be loaded and continued for the same role. If the assigned role has changed, a new discussion is used rather than changing the old conversation's identity. Failed history loading requires an explicit choice to start a new discussion. The returned conversation ID is linked back to the local Case.

Account changes unmount/abort the old client discussion. User-initiated Coach calls include an expected account ID; the existing AI API rejects mismatches before model calls or conversation writes. No authentication provider, RLS or SQL changes are made.

## Files

| Area | New files |
| --- | --- |
| Source approvals and UI transactions | `src/lib/proactive/sources.ts`, `controller.ts` |
| Creator verification | `src/lib/proactive/creation.ts`, `src/app/workspace/TaskCreationBridge.tsx` |
| Coach context and time zones | `src/lib/proactive/coach.ts`, `time.ts` |
| Insights UI | `src/app/workspace/ProactiveInsights.tsx`, `useProactiveController.ts`, `proactive-insights.css` |
| Summary and legacy replies | `src/app/workspace/DailyBriefing.tsx`, `useDailyCheckInStore.ts` |
| Tests | `tests/proactive-integration.test.cjs`, `proactive-api.test.cjs` |

Modified: Phase 1 contracts/rules/engine/interfaces/validation; `src/app/page.tsx` (post-save event and To-do-only bridge); `src/app/workspace/page.tsx`; `WorkspaceCoach.tsx`; `DailyCheckIn.tsx` (compatibility alias); `src/app/api/ai/run/route.ts`; `package.json` (test command). Landing Page markup, the business storage format, Calendar/Idea Box write logic, authentication setup and remote database are unchanged.

## Persistence and compatibility

An optional `taskSources` array extends the existing version-1, per-account workflow envelope. Approvals and Cases are committed together under the same Web Lock; quota errors cannot leave a partially connected source. Phase 1 envelopes without this array remain valid. Corrupt/future-schema envelopes are preserved and blocked from writes.

Each approved snapshot records owner, original task ID, normalized task fields, revision, approval ID/time and reviewed/created provenance. The source adapter never writes `aiask-planner` or `aiask-idea-box`. Unsent answers remain local to the mounted account; if the question changes, using an earlier draft requires explicit review.

Web Locks remain required for safe writes. The new UI does not introduce a demo namespace or fall back to another user's data. These are browser-local workflows, not cloud-synced records. The pre-existing shared storage of the rest of the business application is not globally migrated or repaired by this feature.

## Validation and practical limits

Use `npm run test:proactive`, `npm run test:workspace`, `npx tsc --noEmit --incremental false` and `npm run build`. No test framework/dependency was added. Integration tests cover reviewed/created ownership, atomic saves, stale events, account switches, changed/completed/missing sources, scheduled follow-up, confirmation, Coach handoff, legacy opt-out/replies, DST and English server-rendered controls. API tests stub authentication and reject stale accounts before database/model work.

Browser automation could not connect during this session. Controller flows and server-rendered UI are tested, but an authenticated browser click-through and a real model reply are still needed for live acceptance. No real private task or AI request was used for test setup.

The installed Next.js build tool has reported a dependency security upgrade reminder. This work does not upgrade dependencies. Build results are recorded separately in the final delivery report.

### Verification record — 2026-11-18

- `npm run test:proactive`: 59 passed, zero failures (Phase 1 engine, Phase 2 integration, legacy retirement and API account guard).
- `npm run test:workspace`: 14 passed, zero failures.
- `npx tsc --noEmit --incremental false`: passed.
- `npm run build`: passed with exit code 0 after retrying the unchanged command following the Next.js security reminder. All 10 static pages were generated. The reminder remains a dependency review item; no upgrade was performed.
- The build process used an absolute `SWC_NATIVE_BINDING_CACHE` path under ignored `artifacts/swc-native-cache` to avoid the session's native cache permission issue. The project build configuration and dependency versions were not changed.
- Browser connection: timed out. Component/server-rendered UI and controller/API fixtures passed, but an authenticated browser click-through and a real provider response were not claimed as verified.
- Original business storage and old check-in reply bytes were preserved in the integration tests. No remote database or AI provider was used by the tests.

Remaining optional work: single-role AI question refinement/answer extraction with persistent request claiming; initial Calendar/Idea trigger policies; server-backed source ownership and cloud sync; browser/OS background notifications. No automatic external execution, deployment or GitHub push is included in this phase.
