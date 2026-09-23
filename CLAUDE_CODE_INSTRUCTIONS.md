# Claude Code — Week 5 Implementation Instructions

Read the full repository first, then read SYSTEM_DOCS.md and the PRD.md. Use SYSTEM_DOCS.md as the current state of the implementation. Use the PRD as the requirements. These instructions describe the remaining changes to make.

## CRITICAL RULES

1. **Do NOT break anything that already works.** The agent loop, Apify discovery, Firecrawl scraping, Supabase writes, input validation, progress tracker, cancel functionality — all working. Test after every change.
2. **Do NOT modify the system prompt** unless explicitly told to below. The current system prompt in agent.ts is production-grade and should not be rewritten.
3. **Do NOT add new dependencies** without stating why.
4. **Do NOT remove existing files or features.**
5. **Make small, testable changes.** Commit after each working change.

---

## Changes to Make (in priority order)

### 1. Lead storage — only save full details for qualified leads

**Current behavior:** The agent saves all evaluated companies to the `leads` table including needs_review leads with full source evidence.

**Required behavior:**
- **Qualified leads:** Save to `leads` table with full details (company info, fit_reasons, concerns, source_urls, source_summary), save source evidence to `lead_sources`, save outreach drafts to `outreach_drafts`. This already works.
- **Needs-review leads:** Save to `leads` table with basic info only (company_name, company_domain, qualification_status, confidence, concerns, source_urls). Do NOT save to `lead_sources` or `outreach_drafts` yet. These records exist so a human reviewer can see them and decide.
- **Not-qualified leads:** Do NOT save at all. The agent already skips these. No change needed.

**When a human promotes a needs-review lead to qualified:**
- The reviewer provides a written reason (required).
- The system updates the lead's qualification_status to "qualified".
- The system logs the promotion to `agent_tool_calls` with tool_name "manual_review" for auditability.
- Outreach is NOT auto-generated on promotion (the reviewer can request it separately or the system can note that outreach is pending).

**Implementation:**
- In `src/lib/agent.ts`, modify the `save_lead` tool: when `qualification_status` is "needs_review", skip the `lead_sources` and `outreach_drafts` inserts. Only insert the lead record with basic fields.
- Create `src/app/api/leads/[id]/route.ts` with a PATCH endpoint that:
  - Accepts `{ qualification_status: "qualified", review_reason: string }`
  - Validates the lead exists and is currently "needs_review"
  - Validates review_reason is non-empty
  - Updates the lead's qualification_status to "qualified"
  - Logs to agent_tool_calls: tool_name="manual_review", purpose="Human reviewer promoted [company_name] to qualified", result_summary="Reason: [review_reason]"
  - Returns the updated lead
- In the run detail page (`src/app/runs/[id]/page.tsx`), add a "Mark as Qualified" button on needs-review leads that opens a modal requiring a written reason. On submit, call PATCH /api/leads/[id]. Show the agent's concerns in the modal so the reviewer can address them. Refresh the page data after promotion.

### 2. Cooperative cancellation

**Current behavior:** Cancel sets the DB status to "failed" but the agent loop keeps running.

**Required behavior:** Each tool should check if the run is still "running" before doing expensive work. If cancelled, the tool returns an error and the agent stops.

**Implementation:**
- In `src/lib/agent.ts`, add a helper function:
```typescript
async function isRunCancelled(runId: string): Promise<boolean> {
  const { data } = await supabase
    .from("lead_runs")
    .select("status")
    .eq("id", runId)
    .single();
  return data?.status !== "running";
}
```
- At the start of `discover_companies`, `scrape_company`, and `save_lead` handlers (after `const startTime = Date.now()`), add:
```typescript
if (await isRunCancelled(args.run_id)) {
  return {
    content: [{ type: "text" as const, text: "Run was cancelled. Stopping." }],
    isError: true,
  };
}
```

### 3. Idempotency protection on POST /api/runs

**Current behavior:** Double-clicking "Start Research" could create duplicate runs.

**Required behavior:** If a run with the same objective is already running (created within the last 30 seconds), return the existing run instead of creating a new one.

**Implementation:**
- In `src/app/api/runs/route.ts`, before the Supabase insert, add:
```typescript
const { data: recent } = await supabase
  .from("lead_runs")
  .select("id")
  .eq("objective", objective.trim())
  .eq("status", "running")
  .gte("created_at", new Date(Date.now() - 30000).toISOString())
  .limit(1);

if (recent && recent.length > 0) {
  return NextResponse.json({ run_id: recent[0].id, status: "running" });
}
```

### 4. Fix run-state semantics

**Current behavior:** If the agent completes but finds zero qualified leads, the run is marked "failed".

**Required behavior:** A legitimate zero-result search is "completed", not "failed". "Failed" means the system broke. The shortfall is communicated via the error/message field.

**Implementation:**
- In `src/lib/agent.ts`, in the `runAgent` function, find any logic that overrides the agent's status to "failed" when qualified count is zero. Remove it. Let the agent's own status stand. The agent already writes a concise user-facing message explaining the shortfall.

### 5. User-facing error messages

**Current behavior:** The agent writes very long technical diagnostic messages into the run's error field.

**Required behavior:** Error messages shown to users should be 1-2 sentences, non-technical, stating what happened and what to do next.

**Implementation:**
- In `src/lib/agent.ts`, add this to the SYSTEM_PROMPT, at the end of step 7 (COMPLETE OR FAIL THE RUN), before step 8:

```
   User-Facing Run Status Rule

   When recording a user-facing run status message via the update_run error field, write it for a non-technical user.

   The message must:
   - Be 1-2 short sentences.
   - Clearly say what happened.
   - Tell the user what they can do next, when a useful next step exists.
   - Use plain, non-technical language.

   Do NOT include internal tool names, candidate counts, domain lists, internal reasoning, remediation plans, debugging information, or safety posture statements.

   Examples:
   - "Found 1 of 5 requested leads. The search didn't return enough matching companies — try a broader industry or different location."
   - "The research service is temporarily unavailable. Please try again shortly."

   Detailed diagnostics belong in log_tool_call records, not in the user-facing message.
```

### 6. ICP display as collapsible section

**Current behavior:** The refined ICP is shown as raw JSON on the run detail page.

**Required behavior:** A collapsible "Research Criteria" section that shows the original objective and the refined ICP fields in a readable format (not raw JSON). Collapsed by default.

**Implementation:**
- In `src/app/runs/[id]/page.tsx`, replace the raw JSON ICP display with a collapsible component that:
  - Has a clickable "Research Criteria" header with a toggle arrow
  - Shows the original objective as "Your Objective"
  - Shows ICP fields with human-readable labels (e.g. "Company Type", "Industries", "Geography", "Company Size", "Buyer Persona", "Business Problem", "Hard Filters", "Soft Preferences", "Disqualifiers")
  - Arrays display as comma-separated values, not JSON

### 7. Tool call labels

**Current behavior:** Tool calls show raw names like `discover_companies`, `scrape_company`.

**Required behavior:** Show human-readable labels: "Apify Search", "Firecrawl Scrape", "Save Lead", "Update Run", "Log", "Human Review".

**Implementation:**
- In `src/app/runs/[id]/page.tsx`, add a label mapping and use it in the tool call display.

### 8. Candidate source filtering

**Current behavior:** Apify returns irrelevant results (job boards, social media, government sites) that waste Firecrawl credits.

**Required behavior:** Filter out obvious non-company domains from discovery results before returning them to the agent.

**Implementation:**
- In `src/lib/agent.ts`, in the `discover_companies` tool, after extracting the companies array from Apify results, filter out URLs matching a denylist:
```typescript
const DOMAIN_DENYLIST = [
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com',
  'youtube.com', 'tiktok.com', 'reddit.com', 'pinterest.com',
  'indeed.com', 'glassdoor.com', 'ziprecruiter.com', 'monster.com',
  'craigslist.org', 'yelp.com', 'bbb.org',
  'wikipedia.org', 'amazon.com', 'ebay.com',
  'gov', 'edu'
];

const filtered = companies.filter(c => {
  try {
    const domain = new URL(c.url).hostname.toLowerCase();
    return !DOMAIN_DENYLIST.some(blocked =>
      domain === blocked || domain.endsWith('.' + blocked)
    );
  } catch { return true; }
});
```

---

## DO NOT CHANGE

- The system prompt content (except adding the user-facing error rule in item 5)
- The 5 skills files in .claude/skills/
- The validation endpoint logic (src/app/api/validate/route.ts)
- The Supabase schema (no table modifications)
- The environment variable structure
- The progress tracker steps (Refine ICP → Discover → Research → Outreach)

## TESTING

After implementing, verify:
1. Submit a valid objective — agent runs, leads appear, outreach saved for qualified leads only
2. Submit gibberish — validation rejects it on the home page
3. Needs-review lead shows "Mark as Qualified" button, modal works, promotion is logged
4. Cancel button actually stops tool execution on next tool call
5. Double-click "Start Research" — only one run created
6. Run with zero qualified leads shows "completed" not "failed"
7. Error messages are short and user-facing
8. ICP displays in readable format, not JSON
9. Tool calls show human-readable labels
10. Discovery results don't include job boards or social media
