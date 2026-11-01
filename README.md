# AIASK V0.1

AIASK brings people and a coordinated AI team together. Its six coordinated AI roles help people capture ideas, plan, connect knowledge, evaluate outcomes, make decisions, and follow through. Idea capture is one convenient entry point into the wider workspace.

## Run locally

1. Install Node.js 20 or newer (npm is included).
2. Open this project folder in VS Code.
3. In VS Code, choose **Terminal → New Terminal**. Confirm the terminal path ends in `aiask`.
4. Run `npm install` once, then `npm run dev`.
5. Open [http://localhost:3000](http://localhost:3000). Stop the server with **Ctrl+C**.

## Configure account sign-in (Supabase)

The app uses Supabase Auth with passwordless email sign-in links. Google sign-in is optional. The browser uses only a Supabase project URL and publishable key; never put a service-role key in a `NEXT_PUBLIC_` variable or browser code.

1. Create a Supabase project at [supabase.com](https://supabase.com/).
2. In this project folder, copy `.env.example` to `.env.local`.
3. In Supabase **Project Settings → API**, copy the Project URL and publishable key into `.env.local`:

   ```env
   NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
   ```

4. In Supabase **SQL Editor**, run [`supabase/migrations/0001_personal_workspaces.sql`](supabase/migrations/0001_personal_workspaces.sql). It creates personal workspace, membership, idea, task, and calendar tables with row-level security. New accounts receive a personal workspace. Membership invites and team sharing are not implemented yet.
5. In the same SQL Editor, run [`supabase/migrations/0002_ai_pilot_conversations.sql`](supabase/migrations/0002_ai_pilot_conversations.sql). This adds private AI conversation and message tables with per-user row-level security. Do not enable AI conversation history until this migration succeeds.
6. In **Authentication → URL Configuration**, set the local Site URL to `http://localhost:3000` and add `http://localhost:3000/auth/callback` as a redirect URL. Add your production domain later when deploying.
7. AIASK uses Supabase's default sign-in link template, so you do not need to edit the email template for local testing. The default email service is for development only: it restricts recipients to authorized organization team email addresses and applies strict rate limits. Set up a custom SMTP provider before inviting other people or launching publicly.
8. To enable Google, configure its OAuth credentials under **Authentication → Providers → Google**. The Google button is shown but sign-in will fail until this is enabled.
9. Stop and restart `npm run dev` after editing `.env.local`.

Sign in at `/login`. `/workspace` and the Idea Box, To-do, and Calendar views require sign-in once Supabase credentials are configured. Without credentials, the existing local demonstration remains available.

## Live AI Team

All six AI Team roles can send a structured live request. Each role uses its own prompt and framework; follow-up questions use the selected AI Team role and current idea as context. The example perspectives on the cards are previews; open a role and select **Generate a live response** for a model-generated answer.

1. Copy `DEEPSEEK_BASE_URL`, `DEEPSEEK_API_KEY`, and `DEEPSEEK_MODEL` from `.env.example` into `.env.local`. Set `DEEPSEEK_API_KEY` to a key from DeepSeek; keep it server-only and never add a `NEXT_PUBLIC_` prefix. The default model is `deepseek-flash`.
2. Save `.env.local`, stop the development server with **Ctrl+C**, then run `npm run dev` again.
3. Sign in, open **AI Team**, enter an idea, choose any role, then select **Generate a live response**. The idea is sent only after this action. This first milestone does not send tasks, calendar items, saved notes, or other workspace context.

The Shared Perspective draft includes **Continue to execution**. It opens To-do with the chosen next step prefilled, where users can edit it and add a due date or reminder. The task is created only when the user submits the To-do form.

The server validates the request and structured result, requires an authenticated Supabase session, defaults to 60 calls per signed-in user per 15 minutes in the current server process (server-only AI_RATE_LIMIT_OVERRIDES can set a higher quota for selected account email addresses), and times out model calls after 60 seconds. `DEEPSEEK_API_KEY` is used only on the server. AI suggestions are not verified research and do not create tasks or calendar events. The response's token usage and model are shown in the page and request status is written to server logs; usage is not yet stored in a database or converted to an estimated cost. The in-process request limit is suitable only as a basic first milestone; a deployed multi-instance service needs shared rate limiting and persistent usage accounting.

## Proactive reminders (v0.1)

The To-do page lets users choose a reminder time for a task and respond with **Start now**, **Done**, **Snooze 15 min**, or **Change time**. Reminders are stored in this browser and checked while the AIASK main page is open. Users can optionally grant browser notification permission to receive a desktop notification while the page is in the background. Reminders are not guaranteed while the browser or page is closed; reliable background delivery needs a server-side scheduler and push service.

## Data and current implementation boundary

- Authentication uses Supabase SSR cookies and server-side session checks. The database migration defines private per-workspace records and RLS policies.
- The Idea Box, To-do, and Calendar still read/write browser `localStorage`; they are not private account records. AI Pilot conversation history is stored in Supabase after migration 0002 is applied. Conversation API requests derive the owner from the authenticated Supabase session and enforce row-level security; clients cannot choose a `userId`.
- My Workspace's **Conversations** view reads this private conversation history and supports AI Team role filtering, title/message search, and full transcript reading. Idea/project links remain nullable until those modules have database-backed IDs. Existing localStorage data is not uploaded.
- Existing localStorage records are not uploaded or migrated. A future migration needs an explicit preview, duplicate handling, and user confirmation.
- All six AI Team roles can generate a structured live response, and follow-up requests use a role-specific server-side model prompt. No service-role secret is used.
- The SQL file is a one-time migration; do not run it a second time without first checking its policies and trigger.

## Project map

- `src/app/page.tsx` — homepage and local demo interactions.
- `src/app/workspace/page.tsx` — My Workspace demonstration view.
- `src/app/partners/PartnersExperience.tsx` — AI Team perspectives and the draft-to-To-do continuation.
- `src/app/login/` — passwordless email-link and optional Google sign-in UI.
- `src/app/api/ai/run/route.ts` and `src/lib/ai/` — authenticated first AI endpoint, role registry, and OpenAI adapter.
- `src/app/api/ai/conversations/` and `src/lib/ai/conversations.ts` — authenticated conversation history API and message types.
- `src/proxy.ts` — route session check and cookie refresh.
- `src/lib/supabase/` — browser/server Supabase clients.
- `supabase/migrations/` — personal workspace schema and RLS foundation.
