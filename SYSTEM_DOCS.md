# Koya Lead Studio — System Documentation

## What it does

Koya Lead Studio is an AI lead-research and outreach-drafting agent for Koya Talent. A user describes the companies they want and why (for example *"Find 5 US B2B SaaS companies with 10 to 100 employees that may need AI automation to streamline their operations"*). The system:

1. Validates the objective (structural checks + a Claude Haiku check).
2. Refines it into an ICP and a **search plan** (terms and filters taken from the objective).
3. Discovers candidate companies with **LinkedIn company search** (Apify).
4. Researches the companies' own websites / LinkedIn pages (Firecrawl).
5. Qualifies each company against the ICP using retrieved evidence.
6. Saves qualified and needs-review leads with their evidence (Supabase).
7. Drafts a 3-email sequence and a LinkedIn message for each qualified lead.
8. Leaves everything for human review. **Nothing is ever sent**, and personal email addresses are never searched for or validated.

---

## Architecture

```
Browser (Next.js pages)
  ├─ POST /api/validate      Claude Haiku + structural checks → leadTarget, or a 400 with the reason
  ├─ POST /api/runs          structural checks again, one running run per user (409) → lead_runs row → runAgent(runId) in-process
  ├─ GET  /api/runs          run list (runs stale-run recovery first)
  ├─ GET  /api/runs/[id]     run + leads + sources + outreach + tool calls; UI polls every 3 s
  ├─ PATCH /api/leads/[id]   promote a needs_review lead (reason checked by Claude Haiku), then draft its outreach
  ├─ POST /api/leads/[id]/outreach   retry outreach drafting for a qualified lead with no drafts
  ├─ POST /api/outreach/[id]/reject  reviewer rejects a draft (reason checked by Claude Haiku)
  └─ POST /api/outreach/[id]/regenerate  researcher regenerates rejected outreach once per lead (direction checked by Haiku)

runAgent(runId)  (src/lib/agent.ts, runs inside the Next.js server process)
  ├─ loads objective + limits from the run record (clamped to hard maximums)
  ├─ builds a per-run context and a fresh MCP tool server bound to that run
  ├─ Claude Agent SDK query(): model claude-sonnet-5, 5 project skills, 5 custom tools
  ├─ heartbeat: refreshes lead_runs.updated_at every 60 s while alive
  └─ records the SDK-reported cost and the final status (never overwriting a cancelled run)
```

### Stack

| Component | Technology | Purpose |
|---|---|---|
| Frontend | Next.js 16 (App Router), React 19, Tailwind CSS 4 | Objective form, run history, run detail and review |
| Agent runtime | Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), model `claude-sonnet-5` | Runs the research workflow with the lead tools |
| Objective validation | Anthropic SDK, `claude-haiku-4-5-20251001` | Checks the objective describes companies and a need |
| Company discovery | Apify actor `harvestapi/linkedin-company-search` | LinkedIn company profiles with size bands, location, industries |
| Website research | Firecrawl scrape API | Page content as markdown (truncated to 4,000 characters) |
| Database | Supabase (Postgres), service-role key on the server | Runs, leads, sources, outreach, tool-call audit, users |
| Deployment | Railway (`next start`) | Hosts the app; the agent runs in the same process |

---

## Search plan and discovery

When the agent saves the refined ICP (`update_run`) it must also save a **search plan**, validated in code:

- **Filters** from the objective: `location`, `employee_range` (e.g. 10–100) with the LinkedIn `company_sizes` bands that overlap it, and `industries` as exact LinkedIn labels (resolved server-side to LinkedIn industry IDs from the published v2 list; unknown labels are rejected). If the objective names a type of company (`names_company_type`), industries are required.
- **Search terms**: 3–6 terms of 1–2 words, each with a reason. Filler words (B2B, SaaS, startup, company, platform, software) are rejected. The prompt asks for specific product niches (scheduling, invoicing, helpdesk…) rather than broad categories, and says terms never add requirements.
- The plan is stored inside `refined_icp.search_plan`, shown on the run page, and **fixed once discovery starts**.

`discover_companies` then accepts **only** a term from the plan, **exactly** the plan's filters, and each term once. It returns LinkedIn profiles (name, domain, LinkedIn URL, size band, location, industries, description) plus **LinkedIn's total match count**, which is also logged.

---

## Limits enforced in code

All limits are read from the run record and clamped to the maximums in `src/lib/limits.ts`; the model's numbers are only requests. Budgets are reserved synchronously before any `await`, so parallel tool calls cannot overspend.

| Limit | Value |
|---|---|
| Lead target | whole number 1–10 (checked in `/api/validate` **and** `POST /api/runs`) |
| Objective length | ≤ 1,000 characters (both endpoints) |
| Candidate budget | lead target × 4 (max 40) results across all discovery calls; unreturned results are refunded |
| Results per discovery call | ≤ half the candidate budget, and ≤ 20 |
| Discovery calls per run | 4, each with a different plan term |
| Website scrapes | = candidate budget (max 40); every attempt counts; each URL once, plus one retry after a failure |
| Scrape targets | only the website (any page or subdomain) or exact LinkedIn page of a company discovered in this run |
| Qualified leads | ≤ lead target (counts leads already saved) |
| Agent turns | from the run record (default 25, max 50) |
| Custom tool calls | 120 per run |
| Model spend | `maxBudgetUsd` = $5 per run (checked by the SDK between turns) |

---

## Agent tools (`src/lib/agent.ts`)

No tool accepts a `run_id`: tools are created per run and write only to that run. Every call to `update_run`, `discover_companies`, `scrape_company` and `save_lead` is **logged by the application** to `agent_tool_calls` (tool name, safe input summary, result summary, success/error, error category, duration). API keys, URL query strings and page content are never logged.

| Tool | What it does |
|---|---|
| `update_run` | Saves the refined ICP and its search plan (validated), the final status (`completed`/`failed`) and a short user-facing message. Writes only while the run is `running`. |
| `discover_companies` | LinkedIn company search using the saved plan's term and filters; enforces the candidate budget, per-call cap and 4-call limit; drops non-company website domains and repeats. |
| `scrape_company` | Firecrawl scrape of a discovered company's page; enforces scrape scope, scrape limit and per-URL attempts. |
| `save_lead` | Saves a lead with evidence and outreach (rules below). |
| `log_tool_call` | Optional agent note, stored as `agent_note` so it cannot impersonate a real tool call. |

### `save_lead` rules

- `not_qualified` leads are rejected (skipped, not stored).
- **Provenance** (qualified leads, checked before anything is written): the company must have been returned by `discover_companies` in this run (matched by domain, or by its LinkedIn page for a company without a website), and every URL in `sources` and `source_urls` must be a page of **that** company that this run scraped successfully, or the company's LinkedIn page from discovery. Failed scrapes, other companies' pages and URLs never retrieved are rejected. needs_review leads skip this check (they store no sources).
- A **qualified** lead needs at least one source record and the full outreach (3 emails **and** a LinkedIn message); otherwise nothing is saved.
- A qualified lead whose LinkedIn size band extends beyond the objective's employee range (e.g. 51–200 vs 10–100) is saved as **needs_review** with a concern explaining why.
- needs_review leads store basic information only (no sources or outreach) until a reviewer promotes them.
- **Retry-safe**: before inserting, it looks up the run's existing lead for the same domain (or name). A save that stopped part-way is completed by adding only the missing sources/outreach; a complete lead is rejected as a duplicate. Once `20260925120000_leads_unique_run_domain.sql` is applied, the database also rejects a second lead with the same domain in a run (a concurrent save), and the tool reports it as a duplicate. The lead, its sources and its outreach are still separate inserts (not one transaction).

### Agent runtime configuration

- Built-in tools: only `Skill`; the five `mcp__lead-tools__*` tools are pre-approved and everything else is denied (`permissionMode: "dontAsk"`, `strictMcpConfig`).
- `settingSources: ["project"]` loads the five project skills; machine-level user settings are ignored. `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` keeps repository developer notes out of the agent's context.

## Agent skills (`.claude/skills/`)

| Skill | Used for |
|---|---|
| `icp-refinement` | Objective → ICP; never asks clarification questions (headless run); unstated fields are "Not specified by user" |
| `lead-qualification` | qualified / not_qualified / needs_review from evidence |
| `outbound-copywriting` | 3-email sequence + LinkedIn message; every angle must come from retrieved evidence |
| `lead-list-quality` | Final check against the run's lead target |
| `outreach-safety` | Scope boundaries and untrusted-content rules |

---

## Run statuses and failure handling

| Status | Meaning |
|---|---|
| `running` | The agent is working (the only non-terminal state) |
| `completed` | The workflow finished; a shortfall is explained in the run's message |
| `failed` | A system failure, a hard stop (turn or budget limit) or an interrupted run |
| `cancelled` | Cancelled by the run's owner or an admin |

- **Cancellation** (`PATCH /api/runs/[id]` with `{ "status": "cancelled" }`): owner or admin only; only a `running` run changes, so a finished run is never overwritten (409); repeating is a no-op; logged as `manual_cancel`. It is cooperative: every tool refuses work once the run is not `running`, so the agent stops at its next tool call and its cost is still recorded.
- **Turn / budget limits**: the run is marked `failed` with a plain-language message; saved leads are kept.
- **Apify / Firecrawl errors**: logged with a category (`upstream`, `network`, `malformed`); failed discovery requests refund their budget.
- **Crash or restart**: a run with no heartbeat for 35 minutes is marked `failed` ("stopped unexpectedly"); saved leads are kept; the run is not resumed. Recovery runs at server start (`src/instrumentation.ts`), when the run list loads and when a run page loads, and never touches completed, failed or cancelled runs.
- **User-facing messages** are short and plain; diagnostics go to the server log and the audit trail.

---

## Database (Supabase)

| Table | Contents |
|---|---|
| `lead_runs` | objective, `refined_icp` (incl. `search_plan`), limits, status, message (`error`), `actual_cost`, timestamps, `user_id` |
| `leads` | company, domain, status, confidence, fit reasons, concerns, source URLs, source summary |
| `lead_sources` | per-lead evidence: URL, type, title, summary, relevant evidence |
| `outreach_drafts` | 3 emails (subject, body, personalization), LinkedIn message, status (`draft`/`approved`/`rejected`); rejection reason, who and when; `regenerated_from` and `regeneration_direction` for a regenerated draft |
| `agent_tool_calls` | application-written audit of tool calls, agent notes, and human actions (`manual_review`, `manual_approval`, `manual_cancel`), outreach drafted for promoted leads (`manual_outreach`), rejections (`manual_rejection`) and regenerations (`manual_regeneration`) |
| `users` | username, bcrypt password hash, role, display name |

- `lead_runs.status` has a check constraint. **Apply `supabase/migrations/20260924230000_add_cancelled_run_status.sql`** so it accepts `cancelled`; until then, cancelled runs are stored as `failed` with the cancellation message.
- All server access uses the service-role key, which bypasses Row Level Security; access control is enforced in the API routes, not by RLS. (Whether RLS policies exist on the tables is not verified from this repository.)
- **Schema**: `supabase/schema.sql` is reconstructed from the live database's REST metadata (columns, types, nullability, defaults, primary and foreign keys verified; RLS, other constraints and indexes not exposed). It says how to replace it with a `pg_dump`. `lead_runs.user_id` has no foreign key to `users`.
- **Pending migrations** (apply manually, after the duplicate checks in each file's header):
  - `20260925120000_leads_unique_run_domain.sql`: unique `(run_id, lower(company_domain))` for non-null, non-empty domains.
  - `20260925120100_one_running_run_per_user.sql`: at most one `running` run per user (closes the race in the 409 check).
  - `20260925130000_outreach_rejection_regeneration.sql`: rejection and regeneration columns on `outreach_drafts`, status check allowing `rejected`, and at most one regenerated draft per lead. Rejection and regeneration return a clear 503 until it is applied.

---

## Authentication and roles

- Username/password sign-in (bcrypt); an HMAC-SHA256-signed session cookie (httpOnly, 24 h). Sign-in is refused if `SESSION_SECRET` is missing or shorter than 32 characters.
- `src/proxy.ts` redirects to `/login` without a session cookie; every API route re-verifies the session.

| Action | researcher | reviewer | admin |
|---|---|---|---|
| Start runs | ✓ | | ✓ |
| View runs, leads, evidence, activity | ✓ | ✓ | ✓ |
| Cancel a run | own runs | | any |
| Promote needs_review → qualified (with a reason checked by Claude Haiku) | | ✓ | ✓ |
| Approve outreach | | ✓ | ✓ |
| Reject outreach (with a reason checked by Claude Haiku) | | ✓ | ✓ |
| Regenerate rejected outreach (once per lead, with a direction checked by Haiku) | ✓ | | ✓ |

All signed-in users see all runs (a shared team workspace).

**Promotion reasons** (`src/lib/promotion-validation.ts`): Claude Haiku checks that the reason explains why the company fits despite the flagged concerns, is specific to the company or concern, and is not gibberish, a joke or filler ("looks good"). The reason is wrapped in `<reason>` tags and treated as untrusted data. A rejected reason returns Haiku's explanation; if Haiku is unavailable the promotion is refused ("Validation temporarily unavailable…"), with no structural fallback. The UI validates first (`validate_only`), asks the reviewer to confirm, then sends a short-lived signed token bound to the lead, reviewer and exact reason so the confirmed request needs no second model call; without a valid token the route validates again.

---

## Safety

- No tool can send email or LinkedIn messages; approved outreach is only marked approved.
- No tool searches for or validates personal email addresses.
- Scraped content is treated as untrusted data (system prompt), and `scrape_company` can only reach discovered companies, so a page cannot redirect the agent to another site.
- The objective is passed to the validator inside `<objective>` delimiters as untrusted data.
- Outreach must be grounded in the lead's source evidence (prompt rule; a qualified lead must have source records).
- Source links in the UI are rendered only for `http(s)` URLs.

---

## Deployment (Railway)

- **Build / start:** Railway detects Next.js and runs `npm run build` then `npm start` (`next start`, listening on Railway's `PORT`). No `railway.json`, Dockerfile or Nixpacks file is needed.
- **Node:** `package.json` `engines.node` = `>=20.9.0 <23` (Next 16 needs 20.9+).
- **Database migration:** apply the cancelled-status migration (above).

**Environment variables** (set in Railway; never committed):

| Variable | Used by |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase client (server-side; inlined at build time) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase client (server-side only) |
| `ANTHROPIC_API_KEY` | Objective validator and the Claude Agent SDK (read implicitly) |
| `APIFY_API_TOKEN` | `discover_companies` |
| `FIRECRAWL_API_KEY` | `scrape_company` |
| `SESSION_SECRET` | Session signing; at least 32 characters |
| `DISCORD_WEBHOOK_URL` | *Optional.* Discord webhook for notifications (run completed, lead promoted). Unset: no notifications |
| `APP_URL` | *Optional.* Public address used for run links in notifications (e.g. `https://leads.example.com`). Unset: Railway's `RAILWAY_PUBLIC_DOMAIN` |

`NODE_ENV`, `NEXT_RUNTIME`, `NEXT_PHASE` and `PORT` are set by Next.js / Railway.

---

## Tests

`npm test` runs the `node:test` suites with `tsx`: agent tools against an in-memory store and fake Apify/Firecrawl (limits, run binding, logging, search plan, scrape scope, save rules and evidence provenance), cancellation rules, run creation (structural checks, one running run per user), stale-run recovery, migrations and schema file, objective and promotion-reason validation, Discord notices and the sample pack. All use fakes; none touch a real database or API. The two pending migrations were also checked on a local Postgres 17 (PGlite) before being committed.

---

## Known limitations

1. **Shared visibility**: every signed-in user can read every run; there is no per-user data isolation for reads.
2. **One running run per user, but no rate limits**: POST /api/runs returns 409 while the user has a run in progress (a double click with the same objective returns that run); sign-in and validation are not rate-limited.
3. **Semantic validation is not repeated on run creation**: POST /api/runs re-runs the structural checks only; the Haiku check happens in /api/validate.
4. **Most limits are enforced in the server process**; the database adds a unique lead domain per run and one running run per user once the two pending migrations are applied.
5. **Evidence is verified per page, not per claim**: every cited source must be a page this run retrieved for that company, but whether each outreach claim appears on those pages is a prompt rule.
6. **Outreach for promoted leads** (`src/lib/promoted-outreach.ts`): needs_review leads are stored without sources, so after a promotion up to two pages of the company's own website (its LinkedIn page if it has no website) are scraped, saved as `lead_sources`, and used by the agent's model (`claude-sonnet-5`) under the agent's own outreach rules and skills to write the drafts. The drafts cite only those pages, but claim-level grounding is still a prompt rule. If drafting fails, the lead stays qualified; the lead card shows "Outreach generation failed" and a **Generate outreach** button. The promote request waits for the drafts (about 15-30 s). Each attempt is logged as `manual_outreach` and costs up to 2 Firecrawl scrapes and one Sonnet call; that cost is not added to the run's `actual_cost`.
7. **Rejection and regeneration** (`src/lib/outreach-review.ts`): a reviewer rejects a draft with a reason; a researcher can then regenerate it once, with a direction. Both texts are checked by Claude Haiku first (no structural fallback), then confirmed. Regeneration uses the lead's stored sources, the run's objective and ICP, the rejected drafts, the reason and the direction, under the same outreach rules as the agent; the direction can change focus and tone, not the grounding rules. It is saved as a new draft (the rejected one is kept and shown as an earlier draft). Stored sources hold the agent's evidence notes, not full page text, so regenerated drafts work from that evidence. The sample-pack export uses the latest draft that is not rejected.
7. **Cancellation is cooperative**: the model step in progress when a user cancels completes (and is billed) before the next tool call stops it.
8. **Interrupted runs are not resumed**; they are marked failed after 35 minutes without a heartbeat.
9. **Cost shown is Claude only**; Apify and Firecrawl usage is not tracked.
10. **Search quality**: LinkedIn ranks companies named after the search term first, which can surface consultancies and resellers self-tagged as software companies; the agent filters these during qualification.
11. **Firecrawl truncation** at 4,000 characters can miss evidence further down a page.
12. **Demo accounts**: change the seeded account passwords before any shared deployment.
