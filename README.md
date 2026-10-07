# Lead Studio

An AI research agent that finds companies matching a sales brief, cites evidence for each one, and drafts outreach for a reviewer to approve. Nothing is sent automatically.

<!-- SCREENSHOT + DEMO VIDEO: added in the second pass -->

**Stack:** Claude Agent SDK · Apify · Firecrawl · Zod · Supabase · Next.js · **Live demo:** available on request

## The problem

Turning a sales brief into a list of qualified companies means hours of searching, reading company websites and writing first-touch emails. An agent can do that work, but an agent running unsupervised can cite pages it never read, email people nobody approved, or spend without limit. Sales teams want the research without giving up control of what goes out or what it costs.

## Results

- **Evidence-cited leads:** every URL a qualified lead cites must be a page of that company that the run actually scraped. The code checks this before saving, not just the prompt.
- **Hard per-run limits the model can't raise:** 10 leads, 40 website scrapes, 120 tool calls and $5 of model spend. Budgets are reserved before parallel tool calls run, so they can't overspend.
- **A 3-email sequence and a LinkedIn message** drafted for each qualified lead, all waiting for a reviewer to approve, reject or have regenerated.
- **Every tool call logged** to an audit trail, along with every human action (promote, approve, reject, regenerate, cancel).
- **162 tests**, all passing (`npm test`). They use fakes, so they touch no real database or API.

## What it does

1. **Sign in.** Roles are researcher, reviewer and admin.
2. **Describe the companies you want and why**, for example *"Find 5 US B2B SaaS companies with 10 to 100 employees that may need AI automation to streamline their operations"*. The brief is checked for structure, then by Claude Haiku, before a run starts.
3. **The agent runs.** You watch progress live, with every tool call shown. It:
   1. turns the brief into an ideal-customer profile and a search plan;
   2. discovers companies through LinkedIn company search (Apify);
   3. reads their websites with Firecrawl;
   4. qualifies each against the profile;
   5. saves qualified and needs-review leads with their evidence;
   6. drafts outreach for the qualified ones.
4. **Review.**
   - A reviewer can promote a needs-review lead with a reason; outreach is then drafted for it.
   - A reviewer approves or rejects each draft; a rejection needs a reason.
   - A researcher can regenerate a rejected draft once, with a direction.
   - Approved drafts have copy buttons for each email and the LinkedIn message.
5. **Export** a run's qualified leads and their outreach as a Markdown file.

Personal email addresses are never looked up, and no tool can send email or LinkedIn messages: approved outreach is only marked approved.

## How it works

```
Browser (Next.js pages)
  ├─ POST /api/validate        structural checks + Claude Haiku → lead target, or the reason it's refused
  ├─ POST /api/runs            checks again; one running run per user → lead_runs row → runAgent() in the server process
  ├─ GET  /api/runs/[id]       run + leads + sources + outreach + tool calls (the page polls every 3 s)
  └─ PATCH /api/leads/[id], /api/outreach/[id]/…   promote, approve, reject, regenerate

runAgent(runId)
  ├─ loads the brief and limits from the run record, clamped to hard maximums
  ├─ builds a fresh tool server bound to this run (no tool takes a run ID)
  ├─ Claude Agent SDK: 5 project skills, 5 custom tools
  │    update_run · discover_companies (Apify) · scrape_company (Firecrawl) · save_lead · log_tool_call
  ├─ heartbeat every 60 s while alive
  └─ records the reported cost and the final status
```

| Part | Where | What it does |
| --- | --- | --- |
| Pages | `src/app/` | Brief form and run history (`/`), run detail and review (`/runs/[id]`), sign-in (`/login`) |
| Agent and tools | `src/lib/agent.ts` | The agent run, its 5 tools and their rules (search plan, scrape scope, save rules, evidence provenance) |
| Limits | `src/lib/limits.ts` | The hard per-run maximums |
| Skills | `.claude/skills/` | Profile refinement, lead qualification, outbound copywriting, list quality and outreach safety |
| Review flows | `src/lib/promoted-outreach.ts`, `src/lib/outreach-review.ts` | Promotion, rejection and regeneration |
| Auth | `src/lib/auth.ts`, `src/proxy.ts` | Username and password sign-in, signed session cookie, role checks |
| Database | `supabase/` | Schema and migrations |
| Tests | `tests/` | Agent tools against fakes, cancellation, run creation, stale-run recovery, validation, notifications and export |

Full architecture, every limit, tool rules and failure handling: **[SYSTEM_DOCS.md](SYSTEM_DOCS.md)**.

## Design decisions

- **The model asks; the code decides.** Every limit is read from the run record and clamped to the maximums in code, so neither the browser nor the model can raise one. Budgets are reserved synchronously before a tool call starts, so tools running in parallel can't overspend.
- **Provenance is checked before saving.** A lead must have been discovered in this run. Every page a qualified lead cites must be one this run scraped successfully for that company. Failed scrapes, other companies' pages and URLs never fetched are rejected.
- **A fixed search plan.** The agent commits to its search terms and filters before discovery starts, and discovery accepts only those, each once. The search can't drift mid-run.
- **Tools are bound to one run.** Each run gets its own tool server, so a tool can't write to another run, and every tool refuses work once the run stops (which is how cancelling works).
- **People make the calls that matter.** Nothing is sent. Promotions, rejections and regeneration directions are checked by Claude Haiku for being specific (not "looks good"), and a person confirms each one.
- **Failures are visible, not silent.** Upstream errors are logged by category, failed discovery requests refund their budget, and a run with no heartbeat for 35 minutes is marked failed with its saved leads kept.

## Limitations

- **Evidence is verified per page, not per claim.** Every cited page must be one the run retrieved, but whether each sentence of the outreach appears on those pages is a prompt rule.
- **The server process runs the agent.** A run continues in the background after the request that started it returns. It needs a long-lived Node server: on a serverless platform the run can be stopped when the request ends.
- **Interrupted runs aren't resumed.** They're marked failed after 35 minutes without a heartbeat.
- **Cost shown is partial:** Claude's cost plus an estimated Apify cost. Firecrawl usage isn't tracked.
- **Shared workspace:** every signed-in user can see every run. There are no rate limits on sign-in or validation.
- **Cancelling is cooperative.** The model step in progress finishes, and is billed, before the next tool call stops it.
- **Firecrawl pages are cut at 4,000 characters**, which can miss evidence further down a page.

## Run it locally

**Prerequisites:**
- Node.js 20.9 to 22.x (see `engines` in `package.json`).
- A Supabase project.
- API keys for Anthropic, Apify (with access to `harvestapi/linkedin-company-search`) and Firecrawl.

1. **Install:**
   ```bash
   npm install
   ```
2. **Environment.** Create `.env.local` in the project root. It's gitignored; never commit it.
   ```bash
   NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<service-role key>
   ANTHROPIC_API_KEY=<key>
   APIFY_API_TOKEN=<token>
   FIRECRAWL_API_KEY=<key>
   SESSION_SECRET=<random string, at least 32 characters>

   # Optional: Discord notices when a run completes, a lead is promoted or outreach is approved
   DISCORD_WEBHOOK_URL=<Discord webhook URL>
   # Optional: public address used for run links in those notices
   APP_URL=https://<your app domain>
   ```
   To generate a session secret: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
3. **Database.** `supabase/schema.sql` describes the tables (`lead_runs`, `leads`, `lead_sources`, `outreach_drafts`, `agent_tool_calls`, `users`). Then apply the migrations in `supabase/migrations/` in order, in the Supabase SQL Editor or with `supabase db push`:
   1. `20260924230000_add_cancelled_run_status.sql`: lets a run be stored as `cancelled`.
   2. `20260925120000_leads_unique_run_domain.sql`: one lead per company domain per run.
   3. `20260925120100_one_running_run_per_user.sql`: at most one running run per user.
   4. `20260925130000_outreach_rejection_regeneration.sql`: rejection and regeneration of drafts.

   Run the duplicate checks in each file's header first. Rejection and regeneration return a clear 503 until the last one is applied.
4. **Users.** Add rows to the `users` table: `username`, a bcrypt `password_hash`, `role` (`researcher`, `reviewer` or `admin`) and `display_name`. Use strong, unique passwords.
5. **Run:**
   ```bash
   npm run dev                  # http://localhost:3000
   npm test                     # unit tests (no network, no cost)
   npx tsc --noEmit             # typecheck
   npm run lint
   npm run build && npm start   # production build
   ```

   Local runs use real Apify, Firecrawl and Claude credits. A 3-lead run typically costs well under $1 of model usage, plus a few cents of Apify.

## Deploy

Deploy it as a long-running Node server, because runs execute in the server process (see Limitations). Railway works with no extra configuration:

1. Create a Railway service from this repository. Railway detects Next.js and runs `npm run build` and `npm start`.
2. Set the six required environment variables in the service's **Variables** tab, plus `DISCORD_WEBHOOK_URL` for notices. Run links use Railway's public domain unless `APP_URL` is set. `NEXT_PUBLIC_SUPABASE_URL` must be set before the build, because Next.js inlines it at build time.
3. Apply the migrations (step 3 above) to the production Supabase project.
4. Deploy. On each start, the app marks runs left orphaned by the previous process as failed once they've had no heartbeat for 35 minutes.

## Roles

| Action | researcher | reviewer | admin |
| --- | :---: | :---: | :---: |
| Start runs | ✓ | | ✓ |
| View runs, leads, evidence and activity | ✓ | ✓ | ✓ |
| Cancel a run | own runs | | any |
| Promote a needs-review lead (with a reason) | | ✓ | ✓ |
| Approve or reject outreach | | ✓ | ✓ |
| Regenerate rejected outreach (once per lead) | ✓ | | ✓ |
