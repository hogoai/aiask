# Proactive Workflow — Phase 1

Scope: English-only, local engine foundation, no live page integration. The approved isolation boundary deliberately excludes automatic reads of the shared `aiask-planner` and `aiask-idea-box` records. No remote database, authentication, RLS, existing conversation, URL, landing page, or business-record changes are made.

## Existing capabilities reused

- `workspace/browser-records.ts`: task, calendar and idea contracts; existing tolerant legacy reader used by compatibility tests.
- `ai/contracts.ts`: the six official Partner IDs and existing AI context conventions.
- `workspace/daily-question.ts`: existing deadline-to-Partner assignment.
- `i18n/config.ts`: the current English locale. No translation files or language switch changes.
- Existing `node:test` + TypeScript transpilation approach. No dependencies added.

The current Daily Check-in remains separate and unchanged. Its Snooze/Dismiss UI and storage are not imported or migrated. The Landing Page's `ProactiveWorkflow.tsx` remains a demonstration component. The new engine is in `src/lib/proactive/`.

## Contracts and ownership

`WorkflowState` is versioned and has one `ownerId`, settings, and a Case array. `ProactiveCase` holds a UUID, original source type/ID, a minimal source snapshot/revision, assigned official role, workflow status, trigger ledger, question, confirmed blocker, follow-up instant, conversation reference (initially null), timestamps and memory. Workflow status is independent from `PlannerTodo.status`.

Original source IDs are retained; generated entity IDs use `crypto.randomUUID()`. Persisted instants are canonical UTC ISO strings. Original due dates remain date-only strings. An IANA time zone is stored in workflow settings, independently of next-intl's translation time zone.

`OwnedSourceObservation` is a TRUSTED CALLER contract. `ownership: "verified_owner"` is a required assertion, not proof of ownership or a new authentication mechanism. A future caller must obtain the record from a verified owner-specific source or an explicit, reviewed ownership process. It must never attach the currently signed-in user's ID to shared legacy records automatically. Wrong-owner, unverified and duplicate observations are rejected. `taskCreated` must describe an actual creation event, not the first observation of old data.

There is no legacy auto-reader, source-claiming UI, or implicit demo fallback. The approved Phase 1 end-to-end scenario uses owned fixtures. Real application tasks will not start following up until a safe source adapter is supplied in a later approved phase.

## State machine

| Current state | Allowed different next states |
| --- | --- |
| pending | waiting_for_answer, snoozed, dismissed, resolved |
| waiting_for_answer | pending, answered, snoozed, dismissed, resolved |
| answered | pending, waiting_for_followup, snoozed, dismissed, resolved |
| waiting_for_followup | pending, snoozed, dismissed, resolved |
| snoozed | pending, dismissed, resolved |
| dismissed | none |
| resolved | none |

Same-state history events record explicit confirmation, rejection, resnoozing and source revisions during a scheduled pause. Answers require the current question ID. Scheduling an agreed follow-up requires an answer and a future instant. Source updates invalidate obsolete questions and unconfirmed interpretations. They preserve a future snooze/follow-up time. Completed tasks resolve active Cases even while prompts are off. Dismissed/resolved Cases are not automatically reopened; completion of a Case never completes its task.

## Trigger rules

| Trigger | Rule | Official role |
| --- | --- | --- |
| task_needs_clarification | Actual new task, with a missing deadline or English `quote`/`quotation` wording | guide |
| task_deadline_near | Open task due within three calendar days in the selected time zone, including overdue | action_partner |
| blocker_followup | A confirmed blocker has a user-selected follow-up instant that is now due | action_partner |
| followup_due | A user-selected follow-up or snooze instant is now due | action_partner |
| source_updated | Relevant source fields differ from the stored revision | evaluator |

Task priority, title, due date and status form the task revision. The detector ignores metadata-only timestamp changes. Calendar/Idea source types are accepted, but their initial trigger rules are reserved for later work. Missing observations are not treated as deletions.

One Case is retained per source type/ID within an owner. Trigger keys and source revision counters suppress duplicate events, including repeated creation signals and refreshes. An unchanged deadline is asked about once, and deadline prompts after other questions have a 24-hour cooldown. Default visible question limit is one; supported range is one to three. Pending Cases queue behind current questions. Disabling proactive prompts hides questions and stops new prompts, while still reconciling supplied source changes and completion.

Run `advanceWorkflows` on return/open or a future integration's focus/timer event, supplying current owned observations and a clock. This package does not install browser timers, background jobs or notifications. A pending Case needs a current source observation before it can ask a new question.

## Memory and AI boundaries

Memory retains raw answers (including original whitespace), questions, confirmed facts, unconfirmed/rejected/superseded interpretations and state history. A small English rule recognizes a possible missing-drawings blocker. It is an unconfirmed proposal until `confirm_inference`; the blocker field remains null until then. It is not general language understanding.

`buildWorkflowContext` separates confirmed facts from unconfirmed interpretations and selects only the linked Case's context. `AIQuestionGenerator` and `UserAnswerProcessor` define future async model boundaries. Model wording must match Case ID, trigger key, source revision, English locale and assigned role before acceptance. There are no model calls in Phase 1. Persisted rule questions survive reload; refreshing never calls six models or creates conversations.

`selectProactiveInsights` returns question, source link fields, role, reason and latest answer for a future panel. `buildWorkspaceCoachHandoff` returns a context contract only. Neither function navigates, writes conversation history, or modifies the Workspace Coach. `workflowSuggestion` returns an optional English suggestion after blocker confirmation.

## Local persistence and account lifecycle

Namespace: `aiask-proactive-workflows:v1:user:<encoded user ID>`. The store has no demo namespace and retains no Case cache. It reads/writes only that owner's workflow envelope. It does not inspect legacy business keys.

Use `createWorkflowSession` with a `getItem`/`setItem` storage object and an IANA time zone. A future UI must feed `setAccount` from verified account state, such as the existing `useWorkspaceAccount`:

1. On identity changes, supply loading immediately and discard the previous UI state.
2. After account verification, supply ready with the verified user ID.
3. Read the snapshot and retain its generation token for mutations.
4. Use `update(token, reducer)` for all changes. Old tokens are invalid after A → B → A switches as well as sign-out.

`update` acquires an account-specific Web Lock, re-reads the latest envelope, applies a synchronous reducer and validates the result before writing. It checks the account generation again after the reducer. This prevents stale model callbacks and overlapping tabs from overwriting each other's answers. Browsers without Web Locks are read-only (`locking_unavailable`); there is no unsafe write fallback.

Invalid JSON, invalid nested records, owner mismatches and unsupported future schema versions return an unavailable snapshot and preserve existing bytes. Corrupt storage is not automatically reset. Read/write/quota failures are explicit results; no optimistic saved state is returned. No sensitive record data is logged. There is no pruning or migration of existing user data.

## Validation

- `npm run test:proactive`: quotation scenario, state transitions, raw vs confirmed memory, deduplication, Snooze/Dismiss, completion, source edits, time zones/DST, visible limits, legacy compatibility, isolation, stale callbacks, cross-tab updates and storage failures.
- `npm run test:workspace`: existing regression tests.
- `npx tsc --noEmit --incremental false`: strict TypeScript check.
- `npm run build`: existing Next.js production build.

Tests use fixtures and stub storage/locks. They do not call real AI providers, change Supabase, or modify user data. The English workflow does not reject non-English user-authored record text, but it provides English system wording only. Its keyword rule is intentionally limited to English.

### Verification record — 2026-11-18

- Proactive workflow tests: 32 passed, zero failures.
- Existing Workspace tests: 14 passed, zero failures.
- Standalone strict TypeScript check: passed.
- Production build: NOT fully passed in this managed Windows session. Compilation and the build's TypeScript checks passed. Static generation attempts encountered `EPERM` creating generated segment directories for `/workspace` or `/about`. An earlier attempt generated all pages, then stopped on the installed Next.js dependency's security upgrade reminder. The reminder remains an outstanding dependency review item; no upgrade was performed.
- Initial SWC native cache loading was resolved for the build process by setting `SWC_NATIVE_BINDING_CACHE` to an absolute path under the ignored `artifacts/swc-native-cache` directory. No project configuration or dependency versions were changed for this workaround.
- Re-run the production build in an unrestricted local terminal before treating this snapshot as release-ready.

## Remaining work, subject to later approval

1. Establish source ownership before live integration; the existing shared-storage limitation remains outside this package.
2. Add a small Proactive Insights panel, account lifecycle binding and refresh/focus handling.
3. Connect the existing Coach using the handoff contract and explicit user action.
4. Add optional single-role model wording/answer extraction with persistent request claiming and stale-result checks; keep confirmation separate.
5. Add Calendar/Idea trigger policies and decide explicit behavior for deletion/reopening.

Phase 1 stops at this foundation. It introduces no executable Agent or external action tool.
