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
| Deployment | Vercel | Hosts the web application |

---

## Database Schema (5 tables)

**lead_runs** — One record per research run
- id, user_id, objective, refined_icp (JSON), lead_limit, candidate_limit, scrape_limit, agent_turn_limit, status (running/completed/failed), error, estimated_cost, actual_cost, created_at, updated_at

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

### update_run
Updates the run record: saves refined ICP, changes status, records cost, records user-facing error messages.

### discover_companies
Calls Apify Google Search actor via REST API. Hard cap enforced server-side: `Math.min(args.max_results, 20)`. Returns titles + URLs + snippets.

### scrape_company
Calls Firecrawl scrape endpoint. Extracts markdown + metadata, truncates to 4000 chars. Uses `onlyMainContent: true`.

### save_lead
Validates required fields. Inserts lead record, source evidence records (lead_sources), and outreach drafts (outreach_drafts, only for qualified leads).

### log_tool_call
Writes audit record for every tool invocation. Agent is instructed to call after every other tool use.

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
- Run status badge + cancel button (while running)
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
- PATCH /api/runs/[id] — cancel a run

---

## Safety & Security

- Scraped website content treated as data, never instructions
- System prompt has explicit prompt injection defense
- Validation wraps user input in `<objective>` tags with untrusted-data instruction
- All API keys server-side only (env vars)
- RLS enabled on all Supabase tables
- .env.local in .gitignore
- Apify results hard-capped at 20 (tool handler enforced)
- Agent turns capped at 25
- Agent cannot find/validate emails or send outreach

---

## Current Limitations & Known Issues

1. Tool logging relies on the agent calling log_tool_call rather than application-controlled wrapping
2. No authentication — single-user system, no ownership checks on run access
3. save_lead is not atomic — partial failures (lead saved but outreach fails) are reported but not rolled back
4. No rate limiting on API endpoints
5. No stale-run detection — if server crashes during a run, status stays "running" indefinitely
6. Candidate discovery returns irrelevant results (job boards, social media, government sites) — needs domain denylist filtering
7. 4000-char Firecrawl truncation can miss important evidence later on the page
8. Cancellation sets DB status to failed but does not cooperatively stop the running agent
9. No idempotency protection on POST /api/runs — double-click could create duplicate runs
10. Zero qualified leads marks run as "failed" even when the workflow completed successfully (should be "completed" with shortfall message)
