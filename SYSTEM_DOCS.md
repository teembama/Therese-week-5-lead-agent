# Koya Lead Studio — System Documentation

## What It Does

Koya Lead Studio is an AI-powered lead research and outreach agent. A user enters a description of the companies they want to find, and the system:

1. Validates the input for meaningfulness (Claude Haiku + structural checks)
2. Refines the objective into structured ICP qualification criteria
3. Searches for candidate companies via Apify Google Search
4. Scrapes each candidate's website via Firecrawl for evidence
5. Qualifies or rejects each company based on real evidence
6. Drafts personalized cold outreach for qualified leads
7. Stores everything in Supabase for review

The output is a qualified lead list with 3-step email sequences and LinkedIn messages — all draft-only, for human review.

---

## Architecture

```
User (Browser)
    │
    ├─ POST /api/validate  →  Claude Haiku validates input meaningfulness
    │                          ✗ → error shown on home page, nothing saved
    │                          ✓ → proceed
    │
    ├─ POST /api/runs       →  Creates run record in Supabase
    │                          Starts agent in background
    │                          Returns run_id immediately
    │
    └─ GET /api/runs/[id]   →  Frontend polls every 3s while running
                                Shows progress tracker + live results
```

**Agent loop (runs server-side in src/lib/agent.ts):**
```
Claude Agent SDK (query())
    │
    ├─ System prompt + 5 skills (loaded from .claude/skills/)
    │
    └─ 5 custom tools:
        ├─ update_run         →  Supabase (lead_runs table)
        ├─ discover_companies →  Apify Google Search API
        ├─ scrape_company     →  Firecrawl API
        ├─ save_lead          →  Supabase (leads, lead_sources, outreach_drafts)
        └─ log_tool_call      →  Supabase (agent_tool_calls)
```

---

## Stack

| Component | Technology | Purpose |
|---|---|---|
| Frontend | Next.js (TypeScript), Tailwind CSS | UI for submitting objectives and viewing results |
| Agent runtime | Claude Agent SDK | Orchestrates the research workflow autonomously |
| Company discovery | Apify (apidojo/google-search-scraper) | Finds candidate companies via Google Search |
| Website scraping | Firecrawl API | Extracts website content as markdown |
| Database | Supabase (PostgreSQL) | Stores runs, leads, sources, outreach, tool logs |
| Input validation | Claude Haiku (via Anthropic SDK) | Validates objective meaningfulness before running |
| Deployment | Railway (`next start`, Node >=20.9 <23 via package.json `engines`) | Hosts the web application and runs the agent in-process |

---

## Database Schema (5 tables)

**lead_runs** — One record per research run
- id, user_id, objective, refined_icp (JSON), lead_limit, candidate_limit, scrape_limit, agent_turn_limit, status (running/completed/failed/cancelled — see supabase/migrations/20260924230000_add_cancelled_run_status.sql), error, estimated_cost, actual_cost, created_at, updated_at

**leads** — One record per evaluated company
- id, run_id (FK), company_name, company_domain, qualification_status (qualified/not_qualified/needs_review), confidence (0-1), fit_reasons (JSON array), concerns (JSON array), source_urls (JSON array), source_summary, created_at, updated_at

**lead_sources** — Evidence backing each lead's qualification
- id, lead_id (FK), url, source_type, title, summary, relevant_evidence, retrieved_at

**outreach_drafts** — Email sequences and LinkedIn messages per lead
- id, lead_id (FK), email_1/2/3 subject + body + personalization, linkedin_message, status (draft/reviewed/approved), created_at

**agent_tool_calls** — Audit log of every tool invocation
- id, run_id (FK), tool_name, purpose, input_summary, result_summary, status (success/error), error_message, duration_ms, created_at

All tables have RLS enabled. Server-side access uses the Supabase service role key.

---

## Agent Tools (5 in src/lib/agent.ts)

### How the tools are bound and limited
- `runAgent(runId)` loads the run record and builds a **per-run context** (`createRunContext`). The five tools are created per run (`createRunTools(ctx)`) with a fresh MCP server, so every write targets `ctx.runId`. **No tool accepts a `run_id` argument**; the model cannot address another run. Nothing is module-global, so concurrent runs cannot share state.
- Limits come from the `lead_runs` record (`lead_limit`, `candidate_limit`, `scrape_limit`, `agent_turn_limit`), clamped to hard maximums in `src/lib/limits.ts` (10 leads, 40 candidates, 40 scrapes, 50 turns, 120 tool calls). The model's numbers are only requests.
- Budgets are **reserved synchronously before any await**, so parallel tool calls in one turn cannot both pass a check. This is atomic within the Node process running the run; there is no database-level constraint (see Known Issues).
- Every `update_run`, `discover_companies`, `scrape_company` and `save_lead` call is **logged by the application** to `agent_tool_calls` (tool name, safe input summary, result summary, success/error, error category, duration). The model cannot skip or alter these rows. API keys, query strings and page content are never logged.

### update_run
Saves the refined ICP, the final status (`completed`/`failed` only) and a user-facing message. Writes only while the run is still `running`, so a cancelled run is never revived. Cost is recorded by the runtime from the SDK result, not by the model.

### discover_companies
Calls the Apify LinkedIn company search actor `harvestapi/linkedin-company-search` (token in the `Authorization` header), using only the terms and filters of the run's saved search plan. Enforces the **total candidate budget**: each call is granted `min(requested, 20, remaining budget)`, results actually returned count against the budget (unreturned and failed requests are refunded), and calls are rejected once it is used. Drops denylisted non-company domains (social, job boards, directories/review sites, contact-data vendors, gov/edu) and domains already returned in the run.

**Search strategy:** the system prompt directs the agent to run several short, focused queries (2–4 ICP terms each, e.g. industry + geography) instead of one query containing every criterion, to change angle when a query returns mostly junk, and to verify criteria search engines can't filter (e.g. headcount) during research.

**Candidate budget:** `candidate_limit = lead_limit × 4` (target 5 → 20; max 10 → 40), set in `POST /api/runs`, which rejects lead targets that are not whole numbers from 1 to 10.

### scrape_company
Calls the Firecrawl scrape endpoint; truncates content to 4000 chars. **Only scrapes companies discovered in this run**: their website domain (any page or subdomain) or their exact LinkedIn page; any other URL is rejected before budget is used, so a page cannot steer the agent to another site. Enforces the **scrape limit**: every attempt counts, each URL may be scraped once (one retry after a failure), and calls past the limit are rejected.

### save_lead
Enforces the **qualified-lead limit** (counting leads already saved for the run) and rejects **duplicate companies** (same normalized domain, or same name if no domain). Rejects `not_qualified` leads (they are skipped, not stored). Inserts the lead, its sources and its outreach (qualified leads only). **Retries are safe**: before inserting, it looks up the run's existing lead for the same domain (or name); if an earlier save stopped part-way, a retry adds only the missing sources/outreach instead of a second lead, and a complete lead is rejected as a duplicate. A failed lead insert releases the qualified-lead reservation.

### log_tool_call
Optional agent narrative. Stored with `tool_name = "agent_note"`, so it can never be mistaken for, or impersonate, an application-logged tool call.

### Agent runtime configuration (`buildQueryOptions`)
- `tools: ["Skill"]`: the only built-in tool is Skill. Bash, Read, Write, Edit, WebFetch, WebSearch, Task etc. are not available. Verified against the CLI's `system/init` message: the agent sees `Skill` plus the five `mcp__lead-tools__*` tools.
- `skills`: the five project skills only; `permissionMode: "dontAsk"` denies anything not pre-approved; `strictMcpConfig: true`.
- `settingSources: ["project"]`: project skills load, but machine-level user settings do not (previously `~/.claude/settings.json` could change the model). `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` keeps the repo's developer notes (CLAUDE.md/AGENTS.md) out of the agent's context.
- `model: "claude-sonnet-5"`: pinned so local and Railway behave the same. Earlier runs used the CLI default, Opus 5 ($5/$25 per MTok); Sonnet 5 ($2/$10) was chosen to cut per-run cost.
- `maxTurns` from the run record; `maxBudgetUsd: 5`. The SDK checks the budget between turns, so a run can overshoot by up to one turn. Cost is the SDK's own calculation, not a provider invoice. Hitting either limit marks the run `failed` with a plain-language message.

---

## Agent Skills (5 in .claude/skills/)

| Skill | When Used |
|---|---|
| icp-refinement | Refining objective into structured ICP criteria |
| lead-qualification | Evaluating each company against ICP |
| outbound-copywriting | Drafting email sequences and LinkedIn messages |
| lead-list-quality | Final quality check before marking run complete |
| outreach-safety | Persistent safety guardrails (always active) |

---

## Input Validation (src/app/api/validate/route.ts)

Three layers:
1. **Structural** — not empty, under 1000 chars, at least 3 words
2. **Semantic** — Claude Haiku checks if the text is a meaningful company search objective. User input wrapped in `<objective>` tags to prevent prompt injection. Response shape validated.
3. **Lead count** — extracts requested count, enforces max 10, validates integer

If Claude validation API fails: returns 503 "temporarily unavailable" (never silently approves).

---

## UI (src/app/)

### Home Page (page.tsx)
- Textarea for qualification objective
- "Start Research" button with phases: idle → Validating → Starting
- Cancel button during validation/starting
- Validation errors shown inline
- Past runs list with status badges

### Run Detail Page (runs/[id]/page.tsx)
- Run status badge (running / completed / failed / cancelled) + cancel button (while running; shown to the run's owner and admins)
- User-facing error messages (concise, non-technical)
- 4-step progress tracker: Refine ICP → Discover → Research → Outreach
- Contextual status messages under tracker
- Collapsible "Research Criteria" showing objective + refined ICP
- Tabs: Leads / Tool Calls
- Leads: expandable cards with fit reasons, concerns, source summary, outreach drafts
- Tool Calls: chronological log with human-readable labels (Apify Search, Firecrawl Scrape, etc.)
- Polls every 3 seconds while running

### Lead Filtering
- Not-qualified: never shown to users
- Needs-review: shown only when qualified count < target
- Qualified: always shown with full detail

---

## API Routes

- POST /api/validate — input validation (separate from run creation)
- POST /api/runs — create run + start agent in background
- GET /api/runs — list all runs
- GET /api/runs/[id] — run detail with leads and tool calls
- PATCH /api/runs/[id] — cancel a run (`{ "status": "cancelled" }`). Owner or admin only. Sets `cancelled` only while the run is `running`, so a finished run is never overwritten; repeating it is a no-op (200); cancelling a finished run returns 409. Logged as `manual_cancel`. Cancellation is cooperative: every tool rejects work once the run is not `running`, so the agent stops at its next tool call and the run's cost is still recorded. Until the migration is applied, the database rejects `cancelled`; the endpoint then stores `failed` with the cancellation message so the run still stops.

---

## Safety & Security

- Scraped website content treated as data, never instructions
- System prompt has explicit prompt injection defense
- Validation wraps user input in `<objective>` tags with untrusted-data instruction
- All API keys server-side only (env vars)
- RLS enabled on all Supabase tables
- .env.local in .gitignore
- Candidate, scrape, qualified-lead, duplicate, tool-call, turn and USD limits enforced in code (see Agent Tools)
- Agent tool surface restricted by SDK configuration, not by prompt
- Agent cannot send outreach (no tool exists); not finding/validating emails is enforced by the prompt plus the absence of any email tool

---

## Deployment (Railway)

- **Build / start:** Railway detects Next.js and runs `npm run build` then `npm start` (`next start`, which listens on the `PORT` Railway provides). No `railway.json`, Dockerfile or Nixpacks file is needed.
- **Node:** `package.json` `engines.node` = `>=20.9.0 <23` (Next 16 needs 20.9+). This is the only Node-version setting.
- **Database migration:** apply `supabase/migrations/20260924230000_add_cancelled_run_status.sql` before relying on the `cancelled` status.
- **Stale-run recovery:** a run whose process dies (crash, redeploy) is marked `failed` with an "unexpected stop" message once it has had no heartbeat for 35 minutes. Live runs refresh `updated_at` every 60 s. The check runs at server start (`src/instrumentation.ts`), when the run list loads, and when a run page loads; it never touches completed, failed or cancelled runs.

**Environment variables** (set in Railway; never committed):

| Variable | Used by |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase client (server-side) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase client (server-side only) |
| `ANTHROPIC_API_KEY` | Objective validator (Anthropic SDK) and the Claude Agent SDK (read implicitly) |
| `APIFY_API_TOKEN` | `discover_companies` (LinkedIn company search actor) |
| `FIRECRAWL_API_KEY` | `scrape_company` |
| `SESSION_SECRET` | Session cookie signing; at least 32 characters, or sign-in is refused |

`NODE_ENV`, `NEXT_RUNTIME`, `NEXT_PHASE` and `PORT` are set by Next.js / Railway.

---

## Current Limitations & Known Issues

1. Limits are enforced in the process running the agent, not by database constraints. Recommended (not applied) migration for defence in depth: `create unique index leads_run_domain_uniq on leads (run_id, lower(company_domain)) where company_domain is not null;`
2. No authentication — single-user system, no ownership checks on run access
3. save_lead is not atomic — partial failures (lead saved but outreach fails) are reported but not rolled back
4. No rate limiting on API endpoints
5. A run interrupted by a crash or restart is not resumed: after 35 minutes without a heartbeat it is marked failed (leads it saved are kept) and must be started again
6. Candidate discovery returns irrelevant results (job boards, social media, government sites) — needs domain denylist filtering
7. 4000-char Firecrawl truncation can miss important evidence later on the page
8. Cancellation is cooperative: the model turn in progress when the user cancels still completes (and is billed) before the next tool call stops it
9. No idempotency protection on POST /api/runs — double-click could create duplicate runs
10. Zero qualified leads marks run as "failed" even when the workflow completed successfully (should be "completed" with shortfall message)
