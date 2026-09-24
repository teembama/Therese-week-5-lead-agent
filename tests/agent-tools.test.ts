// Exercises the real tool handlers against an in-memory store and a fake fetch (no network, no cost).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import {
  createRunContext,
  createRunTools,
  buildQueryOptions,
  AGENT_MODEL,
  AGENT_SKILLS,
  LEAD_TOOL_NAMES,
  MAX_DISCOVERY_CALLS_PER_RUN,
  buildRunPrompt,
  perCallCapFor,
  type RunContext,
  type RunRecord,
  type RunStore,
  type ToolCallRow,
} from "../src/lib/agent";
import { parseLeadTarget, candidateLimitFor, MAX_CANDIDATES } from "../src/lib/limits";

const APIFY_SECRET = "apify-SECRET-token-123";
const FIRECRAWL_SECRET = "fc-SECRET-key-456";
process.env.APIFY_API_TOKEN = APIFY_SECRET;
process.env.FIRECRAWL_API_KEY = FIRECRAWL_SECRET;

// --- Fakes ---

type Row = Record<string, unknown>;

class MemoryStore implements RunStore {
  runs = new Map<string, RunRecord>();
  leads: Row[] = [];
  sources: Row[] = [];
  outreach: Row[] = [];
  toolCalls: ToolCallRow[] = [];
  costs = new Map<string, number>();
  private nextId = 1;

  addRun(id: string, overrides: Partial<RunRecord> = {}) {
    this.runs.set(id, {
      id,
      objective: "Find US B2B SaaS companies",
      status: "running",
      lead_limit: 5,
      candidate_limit: 20,
      scrape_limit: 20,
      agent_turn_limit: 25,
      ...overrides,
    });
  }
  async getRun(id: string) {
    return this.runs.get(id) ?? null;
  }
  async getRunStatus(id: string) {
    return this.runs.get(id)?.status ?? null;
  }
  async listLeads(runId: string) {
    return this.leads
      .filter((l) => l.run_id === runId)
      .map((l) => ({
        company_name: String(l.company_name),
        company_domain: (l.company_domain as string) ?? null,
        qualification_status: String(l.qualification_status),
      }));
  }
  async updateRunIfRunning(id: string, updates: Row) {
    const run = this.runs.get(id);
    if (!run || run.status !== "running") return "not_running" as const;
    Object.assign(run, updates);
    return "updated" as const;
  }
  async recordCost(id: string, cost: number) {
    this.costs.set(id, cost);
  }
  async insertLead(row: Row) {
    await new Promise((r) => setTimeout(r, 5)); // real inserts are async; lets parallel calls interleave
    const id = `lead-${this.nextId++}`;
    this.leads.push({ id, ...row });
    return id;
  }
  async insertSources(rows: Row[]) {
    this.sources.push(...rows);
  }
  async insertOutreach(row: Row) {
    this.outreach.push(row);
  }
  async insertToolCall(row: ToolCallRow) {
    this.toolCalls.push(row);
  }
}

interface FetchCall {
  url: string;
  body: Row;
  headers: Record<string, string>;
}

// Apify returns `returnCount(requested)` unique LinkedIn company profiles; Firecrawl returns a small page
function makeFetch(opts: {
  apifyStatus?: number;
  apifyThrows?: boolean;
  returnCount?: (requested: number) => number;
  extraResults?: Row[];
  firecrawlStatus?: (call: number) => number;
  totalMatches?: number;
} = {}) {
  const calls: FetchCall[] = [];
  let company = 0;
  let firecrawlCalls = 0;
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url: String(url), body, headers: (init?.headers ?? {}) as Record<string, string> });
    if (String(url).includes("apify.com")) {
      if (opts.apifyThrows) throw new Error("socket hang up");
      if (opts.apifyStatus && opts.apifyStatus !== 200) {
        return new Response(`{"error":"boom ${APIFY_SECRET}"}`, { status: opts.apifyStatus });
      }
      const n = opts.returnCount ? opts.returnCount(body.maxItems) : body.maxItems;
      const items: Row[] = [...(opts.extraResults ?? [])];
      for (let i = 0; i < n; i++) {
        company++;
        // Shape observed from harvestapi/linkedin-company-search
        items.push({
          name: `Company ${company}`,
          website: `https://www.company${company}.com/`,
          linkedinUrl: `https://www.linkedin.com/company/company${company}`,
          employeeCount: 30,
          employeeCountRange: { start: 11, end: 50 },
          pageType: "COMPANY",
        });
      }
      // The actor attaches LinkedIn's pagination metadata (total matches) to each item
      for (const it of items) it._meta = { pagination: { totalResultCount: opts.totalMatches ?? 100 } };
      return new Response(JSON.stringify(items), { status: 200 });
    }
    firecrawlCalls++;
    const status = opts.firecrawlStatus ? opts.firecrawlStatus(firecrawlCalls) : 200;
    if (status !== 200) return new Response("blocked", { status });
    return new Response(
      JSON.stringify({ data: { markdown: "We build B2B software. Contact jane.doe@example.com", metadata: { title: "Acme" } } }),
      { status: 200 }
    );
  }) as typeof fetch;
  return { impl, calls, apifyCalls: () => calls.filter((c) => c.url.includes("apify")) };
}

function terms(...words: string[]) {
  return words.map((term) => ({ term, reason: `Test term ${term} for the objective` }));
}

function plan(overrides: { filters?: Row; names_company_type?: boolean; search_terms?: Row[] } = {}): Row {
  return {
    filters: {},
    names_company_type: false,
    search_terms: terms("q", "q1", "q2", "q3", "q4", "q5"),
    ...overrides,
  };
}

// Creates the run's tools. Unless `searchPlan` is false, a search plan is saved first through
// update_run (as the agent must), then that setup call is cleared from the log and counters.
async function setup(store: MemoryStore, runId: string, fetchImpl: typeof fetch, opts: { searchPlan?: Row | false } = {}) {
  const ctx = (await createRunContext(runId, store, fetchImpl)) as RunContext;
  assert.ok(ctx, "context should be created for a running run");
  const tools = createRunTools(ctx);
  const call = async (name: string, args: Row) => {
    const t = tools.find((x) => x.name === name);
    assert.ok(t, `tool ${name} exists`);
    // Handlers are called directly, bypassing the zod schema, to prove the handler itself enforces limits
    const res = await t.handler(args as never, {});
    return { isError: !!res.isError, text: (res.content[0] as { text: string }).text };
  };
  if (opts.searchPlan !== false) {
    const saved = await call("update_run", { refined_icp: { industries: ["test"] }, search_plan: opts.searchPlan ?? plan() });
    assert.equal(saved.isError, false, `setup plan should be valid: ${saved.text}`);
    store.toolCalls = store.toolCalls.filter((c) => c.run_id !== runId);
    ctx.usage.toolCalls = 0;
  }
  return { ctx, tools, call };
}

const OUTREACH = {
  email_1_subject: "s1", email_1_body: "b1", email_1_personalization: "p1",
  email_2_subject: "s2", email_2_body: "b2", email_2_personalization: "p2",
  email_3_subject: "s3", email_3_body: "b3", email_3_personalization: "p3",
  linkedin_message: "Short LinkedIn note",
};

function lead(name: string, domain: string, status = "qualified"): Row {
  return {
    company_name: name,
    company_domain: domain,
    qualification_status: status,
    confidence: 0.8,
    fit_reasons: ["fits"],
    concerns: [],
    source_urls: [`https://${domain}`],
    source_summary: "summary",
    sources: [{ url: `https://${domain}`, source_type: "website", relevant_evidence: "What the company does" }],
    outreach: OUTREACH,
  };
}

let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore();
});

// --- Run creation bounds ---

test("lead target must be an integer from 1 to 10", () => {
  for (const bad of [0, -1, 11, 50, 5.5, NaN, Infinity, "5", null, undefined, {}]) {
    assert.equal(parseLeadTarget(bad), null, `rejects ${String(bad)}`);
  }
  for (const ok of [1, 5, 10]) assert.equal(parseLeadTarget(ok), ok);
  assert.equal(candidateLimitFor(5), 20);
});

test("limits are read from the run record and clamped to hard maximums", async () => {
  store.addRun("A", { lead_limit: 500, candidate_limit: 9999, scrape_limit: -3, agent_turn_limit: 1000 });
  const ctx = await createRunContext("A", store, makeFetch().impl);
  assert.ok(ctx);
  assert.equal(ctx.limits.leadLimit, 10);
  assert.equal(ctx.limits.candidateLimit, MAX_CANDIDATES);
  assert.equal(ctx.limits.scrapeLimit, 0);
  assert.equal(ctx.limits.agentTurnLimit, 50);
});

test("no context (and so no agent) for a run that is not running", async () => {
  store.addRun("A", { status: "failed" });
  assert.equal(await createRunContext("A", store, makeFetch().impl), null);
});

// --- Candidate budget ---

test("discovery enforces the total candidate budget across calls", async () => {
  store.addRun("A", { candidate_limit: 20 });
  const f = makeFetch();
  const { call } = await setup(store, "A", f.impl);

  assert.equal((await call("discover_companies", { search_query: "q1", max_results: 15 })).isError, false);
  assert.equal((await call("discover_companies", { search_query: "q2", max_results: 15 })).isError, false);
  const third = await call("discover_companies", { search_query: "q3", max_results: 15 });

  assert.equal(third.isError, true);
  assert.match(third.text, /Candidate budget exhausted \(20\/20\)/);
  assert.deepEqual(f.apifyCalls().map((c) => c.body.maxItems), [10, 10], "each call capped at half the budget");
  assert.equal(f.apifyCalls().length, 2, "no Apify request once the budget is used");
});

test("model cannot raise the per-call cap by passing a larger max_results", async () => {
  store.addRun("A", { candidate_limit: 40 });
  const f = makeFetch();
  const { call } = await setup(store, "A", f.impl);
  await call("discover_companies", { search_query: "q", max_results: 1000 });
  assert.equal(f.apifyCalls()[0].body.maxItems, 20);
});

test("unreturned results are refunded; failed requests cost nothing", async () => {
  store.addRun("A", { candidate_limit: 20 });
  const f = makeFetch({ returnCount: () => 3 });
  const { ctx, call } = await setup(store, "A", f.impl);
  const res = await call("discover_companies", { search_query: "q", max_results: 10 });
  assert.equal(JSON.parse(res.text).candidate_budget_used, "3/20");
  assert.equal(ctx.usage.candidates, 3);

  store.addRun("B", { candidate_limit: 20 });
  const failing = await setup(store, "B", makeFetch({ apifyStatus: 500 }).impl);
  await failing.call("discover_companies", { search_query: "q", max_results: 10 });
  assert.equal(failing.ctx.usage.candidates, 0);
});

test("parallel discovery calls cannot overspend the budget", async () => {
  store.addRun("A", { candidate_limit: 20 });
  const f = makeFetch();
  const { ctx, call } = await setup(store, "A", f.impl);
  await Promise.all([1, 2, 3].map((i) => call("discover_companies", { search_query: `q${i}`, max_results: 10 })));
  const requested = f.apifyCalls().reduce((n, c) => n + Number(c.body.maxItems), 0);
  assert.equal(requested, 20);
  assert.equal(ctx.usage.candidates, 20);
});

test("denylisted and repeated domains are dropped from discovery results", async () => {
  store.addRun("A", { candidate_limit: 40 });
  const f = makeFetch({
    returnCount: () => 1,
    extraResults: [
      { name: "NoSite Co", linkedinUrl: "https://www.linkedin.com/company/nosite" },
      { name: "Glassdoor", website: "https://www.glassdoor.com/x" },
      { name: "Acme", website: "https://acme.com/a" },
      { name: "Acme Inc", website: "https://www.acme.com/b" },
    ],
  });
  const { call } = await setup(store, "A", f.impl);
  const out = JSON.parse((await call("discover_companies", { search_query: "q", max_results: 20 })).text);
  const domains = out.companies.map((c: Row) => c.domain);
  assert.ok(!domains.includes("glassdoor.com"));
  assert.equal(domains.filter((d: string) => d === "acme.com").length, 1);
  assert.equal(out.duplicates_removed, 1);
  assert.ok(out.companies.some((c: Row) => c.name === "NoSite Co" && c.domain === null), "profile without a website is kept");
  assert.ok(out.companies.every((c: Row) => "employeeCountRange" in c && "linkedinUrl" in c));
});

// --- LinkedIn actor input ---

test("actor receives its real input field names; filters are omitted when not given", async () => {
  store.addRun("A", { candidate_limit: 8 });
  const f = makeFetch();
  const { call } = await setup(store, "A", f.impl, {
    searchPlan: plan({ filters: { location: "United States" }, search_terms: terms("hr tech", "payroll", "recruiting") }),
  });
  await call("discover_companies", { search_query: "hr tech", location: "United States", max_results: 20 });
  const c = f.apifyCalls()[0];
  assert.match(c.url, /harvestapi~linkedin-company-search/);
  assert.deepEqual(c.body, { searchQuery: "hr tech", locations: ["United States"], maxItems: 4, scraperMode: "full" });
});

test("size and industry filters pass through, with industry names resolved to LinkedIn IDs", async () => {
  store.addRun("A", { candidate_limit: 12 });
  const f = makeFetch();
  const { call } = await setup(store, "A", f.impl, {
    searchPlan: plan({
      filters: {
        location: "United States",
        employee_range: { min: 10, max: 100 },
        company_sizes: ["11-50", "51-200"],
        industries: ["Software Development", "IT Services and IT Consulting"],
      },
      names_company_type: true,
      search_terms: terms("workflow automation", "logistics", "payroll"),
    }),
  });
  await call("discover_companies", {
    search_query: "workflow automation",
    location: "United States",
    company_sizes: ["11-50", "51-200"],
    industries: ["Software Development", "it services and it consulting"],
    max_results: 5,
  });
  const body = f.apifyCalls()[0].body;
  assert.deepEqual(body.companySize, ["11-50", "51-200"]);
  assert.deepEqual(body.industryIds, ["4", "96"]);
  assert.equal(body.searchQuery, "workflow automation");

  const log = store.toolCalls[0];
  assert.match(log.input_summary, /company_sizes=\[11-50,51-200\]/);
  assert.match(log.result_summary, /sent: locations=\[United States\] companySize=\[11-50,51-200\] industryIds=\[4,96\]/);
});

test("industries that differ from the plan (including unknown names) are rejected before any Apify call", async () => {
  store.addRun("A", { candidate_limit: 12 });
  const f = makeFetch();
  const { ctx, call } = await setup(store, "A", f.impl);
  const res = await call("discover_companies", { search_query: "q", industries: ["Computer Software"], max_results: 5 });
  assert.equal(res.isError, true);
  assert.match(res.text, /Filters differ from the saved search plan \(industries\)/);
  assert.equal(f.apifyCalls().length, 0);
  assert.equal(ctx.usage.candidates, 0);
});

test("a single discovery call is capped at half the run budget", async () => {
  store.addRun("A", { candidate_limit: 12 });
  const f = makeFetch();
  const { call } = await setup(store, "A", f.impl);
  const out = JSON.parse((await call("discover_companies", { search_query: "q", max_results: 20 })).text);
  assert.equal(f.apifyCalls()[0].body.maxItems, 6);
  assert.equal(out.granted, 6);
  assert.equal(out.per_call_cap, 6);
  assert.equal(out.candidate_budget_remaining, 6);
});

test("the run budget holds across two capped calls and rejects a third", async () => {
  store.addRun("A", { candidate_limit: 12 });
  const f = makeFetch();
  const { ctx, call } = await setup(store, "A", f.impl);
  await call("discover_companies", { search_query: "q1", max_results: 20 });
  const second = JSON.parse((await call("discover_companies", { search_query: "q2", max_results: 20 })).text);
  const third = await call("discover_companies", { search_query: "q3", max_results: 20 });
  assert.equal(second.candidate_budget_remaining, 0);
  assert.equal(third.isError, true);
  assert.deepEqual(f.apifyCalls().map((c) => c.body.maxItems), [6, 6]);
  assert.equal(ctx.usage.candidates, 12);
});

test("a one-result budget still allows one call (per-call cap floor of 1)", async () => {
  store.addRun("A", { candidate_limit: 1 });
  const f = makeFetch();
  const { call } = await setup(store, "A", f.impl);
  assert.equal((await call("discover_companies", { search_query: "q", max_results: 5 })).isError, false);
  assert.equal(f.apifyCalls()[0].body.maxItems, 1);
});

// --- Scrape limit ---

test("scrape limit is enforced and each URL is scraped once", async () => {
  store.addRun("A", { scrape_limit: 2 });
  const f = makeFetch();
  const { call } = await setup(store, "A", f.impl);

  assert.equal((await call("scrape_company", { url: "https://a.com" })).isError, false);
  const dup = await call("scrape_company", { url: "https://www.a.com/" });
  assert.equal(dup.isError, true);
  assert.match(dup.text, /already scraped/);
  assert.equal((await call("scrape_company", { url: "https://b.com/about" })).isError, false);
  const over = await call("scrape_company", { url: "https://c.com" });
  assert.equal(over.isError, true);
  assert.match(over.text, /Scrape limit reached \(2\/2\)/);
  assert.equal(f.calls.filter((c) => c.url.includes("firecrawl")).length, 2);
});

test("a failed scrape may be retried once, and every attempt counts", async () => {
  store.addRun("A", { scrape_limit: 10 });
  const f = makeFetch({ firecrawlStatus: () => 403 });
  const { ctx, call } = await setup(store, "A", f.impl);
  assert.equal((await call("scrape_company", { url: "https://a.com" })).isError, true);
  assert.equal((await call("scrape_company", { url: "https://a.com" })).isError, true);
  const third = await call("scrape_company", { url: "https://a.com" });
  assert.match(third.text, /Retry limit reached/);
  assert.equal(ctx.usage.scrapes, 2);
});

// --- Qualified lead limit and duplicates ---

test("qualified lead limit holds under parallel saves", async () => {
  store.addRun("A", { lead_limit: 2 });
  const { call } = await setup(store, "A", makeFetch().impl);
  const results = await Promise.all(
    ["a", "b", "c", "d"].map((d) => call("save_lead", lead(d.toUpperCase(), `${d}.com`)))
  );
  assert.equal(results.filter((r) => !r.isError).length, 2);
  assert.equal(store.leads.filter((l) => l.qualification_status === "qualified").length, 2);
  assert.ok(results.some((r) => /Qualified lead limit reached \(2\/2\)/.test(r.text)));

  // needs_review leads are not capped by the qualified limit
  assert.equal((await call("save_lead", lead("E", "e.com", "needs_review"))).isError, false);
});

test("the qualified limit counts leads already saved for the run", async () => {
  store.addRun("A", { lead_limit: 1 });
  store.leads.push({ id: "x", run_id: "A", company_name: "Old", company_domain: "old.com", qualification_status: "qualified" });
  const { call } = await setup(store, "A", makeFetch().impl);
  const res = await call("save_lead", lead("New", "new.com"));
  assert.equal(res.isError, true);
});

test("duplicate company saves are rejected (same normalized domain)", async () => {
  store.addRun("A");
  const { call } = await setup(store, "A", makeFetch().impl);
  assert.equal((await call("save_lead", lead("Acme", "https://www.acme.com/about"))).isError, false);
  const again = await call("save_lead", lead("Acme Inc", "acme.com", "needs_review"));
  assert.equal(again.isError, true);
  assert.match(again.text, /already saved/);
  const parallel = await Promise.all([call("save_lead", lead("Beta", "beta.io")), call("save_lead", lead("Beta", "BETA.io"))]);
  assert.equal(parallel.filter((r) => !r.isError).length, 1);
  assert.equal(store.leads.length, 2);
});

// --- Run binding ---

test("tools take no run_id, and a model-supplied run_id cannot redirect writes", async () => {
  store.addRun("A");
  store.addRun("B");
  const { tools, call } = await setup(store, "A", makeFetch().impl);

  for (const t of tools) {
    assert.ok(!("run_id" in t.inputSchema), `${t.name} must not accept run_id`);
  }

  await call("save_lead", { ...lead("Acme", "acme.com"), run_id: "B" });
  await call("update_run", { status: "completed", run_id: "B" });
  await call("log_tool_call", { about: "x", note: "y", run_id: "B" });

  assert.deepEqual(store.leads.map((l) => l.run_id), ["A"]);
  assert.equal(store.runs.get("A")?.status, "completed");
  assert.equal(store.runs.get("B")?.status, "running", "run B untouched");
  assert.ok(store.toolCalls.every((c) => c.run_id === "A"));
});

test("concurrent runs keep separate contexts and budgets", async () => {
  store.addRun("A", { lead_limit: 1, candidate_limit: 10 });
  store.addRun("B", { lead_limit: 1, candidate_limit: 10 });
  const fa = makeFetch();
  const fb = makeFetch();
  const a = await setup(store, "A", fa.impl, { searchPlan: plan({ search_terms: terms("qa", "qa2", "qa3") }) });
  const b = await setup(store, "B", fb.impl, { searchPlan: plan({ search_terms: terms("qb", "qb2", "qb3") }) });

  // Same company in both runs is fine; each run's own limit applies independently
  const res = await Promise.all([
    a.call("save_lead", lead("Acme", "acme.com")),
    b.call("save_lead", lead("Acme", "acme.com")),
    a.call("discover_companies", { search_query: "qa", max_results: 10 }),
    b.call("discover_companies", { search_query: "qb", max_results: 10 }),
  ]);
  assert.ok(res.every((r) => !r.isError));
  assert.deepEqual(store.leads.map((l) => l.run_id).sort(), ["A", "B"]);
  assert.equal(a.ctx.usage.candidates, 5, "per-call cap is half of run A's budget");
  assert.equal(b.ctx.usage.candidates, 5);
  assert.notEqual(a.ctx, b.ctx);
});

// --- Cancellation ---

test("every tool stops, does no work, and logs 'cancelled' once the user cancels the run", async () => {
  store.addRun("A");
  const f = makeFetch();
  const { call } = await setup(store, "A", f.impl);
  store.runs.get("A")!.status = "cancelled";

  const calls: Array<[string, Row]> = [
    ["discover_companies", { search_query: "q", max_results: 5 }],
    ["scrape_company", { url: "https://acme.com" }],
    ["save_lead", lead("Acme", "acme.com")],
    ["update_run", { status: "completed", error: "done" }],
  ];
  for (const [name, args] of calls) {
    const res = await call(name, args);
    assert.equal(res.isError, true, name);
    assert.match(res.text, /The user cancelled this run\. Stop now/, name);
    assert.match(store.toolCalls.at(-1)?.error_message ?? "", /^cancelled:/, name);
  }
  assert.equal(f.calls.length, 0, "no Apify or Firecrawl request");
  assert.equal(store.leads.length, 0, "nothing saved");
  assert.equal(store.runs.get("A")?.status, "cancelled", "the agent cannot revive or overwrite a cancelled run");
});

test("tools stop with a 'stopped' reason when the run finished rather than being cancelled", async () => {
  store.addRun("A");
  const f = makeFetch();
  const { call } = await setup(store, "A", f.impl);
  store.runs.get("A")!.status = "completed";
  const res = await call("discover_companies", { search_query: "q", max_results: 5 });
  assert.equal(res.isError, true);
  assert.match(res.text, /no longer running \(completed\)/);
  assert.match(store.toolCalls.at(-1)?.error_message ?? "", /^stopped:/);
  assert.equal(f.calls.length, 0);
});

// --- Tool-call cap ---

test("overall tool-call cap rejects further calls", async () => {
  store.addRun("A");
  const { ctx, call } = await setup(store, "A", makeFetch().impl);
  ctx.limits.maxToolCalls = 2;
  await call("log_tool_call", { about: "a", note: "b" });
  await call("scrape_company", { url: "https://a.com" });
  const third = await call("scrape_company", { url: "https://b.com" });
  assert.equal(third.isError, true);
  assert.match(third.text, /Tool-call limit reached/);
});

// --- Application-side logging ---

test("successful tool calls are logged by the application with safe summaries", async () => {
  store.addRun("A");
  const { call } = await setup(store, "A", makeFetch().impl);
  await call("discover_companies", { search_query: "q1", max_results: 5 });
  await call("scrape_company", { url: "https://acme.com/about?token=abc&email=jane@example.com" });

  const [disc, scrape] = store.toolCalls;
  assert.equal(disc.tool_name, "discover_companies");
  assert.equal(disc.status, "success");
  assert.equal(typeof disc.duration_ms, "number");
  assert.match(disc.input_summary, /query="q1" location="" company_sizes=\[\] industries=\[\] requested=5 per_call_cap=10 budget_before=0\/20/);
  assert.match(disc.result_summary, /granted=5 returned=5 kept=5/);

  assert.equal(scrape.tool_name, "scrape_company");
  assert.equal(scrape.status, "success");
  assert.match(scrape.input_summary, /url=https:\/\/acme\.com\/about attempt=1/);
  assert.doesNotMatch(JSON.stringify(scrape), /token=abc|jane@example\.com|jane\.doe@example\.com/, "no query string or page content logged");
});

test("failed tool calls are logged with an error category and no secrets", async () => {
  store.addRun("A");
  const http = await setup(store, "A", makeFetch({ apifyStatus: 502 }).impl);
  await http.call("discover_companies", { search_query: "q", max_results: 5 });

  store.addRun("B");
  const net = await setup(store, "B", makeFetch({ apifyThrows: true }).impl);
  await net.call("discover_companies", { search_query: "q", max_results: 5 });

  const [a, b] = store.toolCalls;
  assert.equal(a.status, "error");
  assert.match(a.error_message ?? "", /^upstream: .*HTTP 502/);
  assert.equal(b.status, "error");
  assert.match(b.error_message ?? "", /^network:/);

  const all = JSON.stringify(store.toolCalls);
  assert.doesNotMatch(all, /SECRET/, "API keys and upstream bodies are never logged");
});

test("secrets go in headers, not URLs", async () => {
  store.addRun("A");
  const f = makeFetch();
  const { call } = await setup(store, "A", f.impl);
  await call("discover_companies", { search_query: "q", max_results: 1 });
  const apify = f.apifyCalls()[0];
  assert.ok(!apify.url.includes(APIFY_SECRET));
  assert.equal(apify.headers.Authorization, `Bearer ${APIFY_SECRET}`);
});

test("agent notes are stored as agent_note and cannot impersonate a tool", async () => {
  store.addRun("A");
  const { call } = await setup(store, "A", makeFetch().impl);
  await call("log_tool_call", { about: "discover_companies", note: "Skipped agencies", tool_name: "discover_companies" });
  assert.equal(store.toolCalls[0].tool_name, "agent_note");
});

test("a lead insert failure releases the reservation so a retry can succeed", async () => {
  store.addRun("A", { lead_limit: 1 });
  const { call } = await setup(store, "A", makeFetch().impl);
  const original = store.insertLead.bind(store);
  store.insertLead = async () => {
    throw new Error("connection reset");
  };
  const failed = await call("save_lead", lead("Acme", "acme.com"));
  assert.equal(failed.isError, true);
  assert.match(store.toolCalls.at(-1)?.error_message ?? "", /^database:/);
  store.insertLead = original;
  assert.equal((await call("save_lead", lead("Acme", "acme.com"))).isError, false);
});

// --- Restricted tool surface ---

test("SDK options restrict the agent to the five lead tools plus project skills", async () => {
  store.addRun("A", { agent_turn_limit: 25 });
  const ctx = (await createRunContext("A", store, makeFetch().impl))!;
  const tools = createRunTools(ctx);
  assert.deepEqual(
    tools.map((t) => `mcp__lead-tools__${t.name}`).sort(),
    [...LEAD_TOOL_NAMES].sort()
  );

  const server = createSdkMcpServer({ name: "lead-tools", version: "1.0.0", tools });
  const opts = buildQueryOptions(ctx, server);
  assert.deepEqual(opts.tools, ["Skill"], "no built-in tools except Skill");
  assert.deepEqual(opts.allowedTools, LEAD_TOOL_NAMES);
  assert.deepEqual(opts.skills, AGENT_SKILLS);
  assert.equal(opts.permissionMode, "dontAsk");
  assert.deepEqual(opts.settingSources, ["project"]);
  assert.equal(opts.strictMcpConfig, true);
  assert.equal(opts.env?.CLAUDE_CODE_DISABLE_CLAUDE_MDS, "1");
  assert.equal(opts.model, AGENT_MODEL);
  assert.equal(opts.maxTurns, 25);
  assert.ok((opts.maxBudgetUsd ?? 0) > 0);
  assert.deepEqual(Object.keys(opts.mcpServers ?? {}), ["lead-tools"]);
});

// --- Search plan (saved with the refined ICP) ---

async function savePlanResult(p: Row) {
  store.addRun("P");
  const { call } = await setup(store, "P", makeFetch().impl, { searchPlan: false });
  return call("update_run", { refined_icp: { target_company_type: "B2B SaaS" }, search_plan: p });
}

test("a valid search plan is saved inside refined_icp, alongside the ICP", async () => {
  const p = plan({
    filters: { location: "United States", employee_range: { min: 10, max: 100 }, company_sizes: ["11-50", "51-200"], industries: ["Software Development"] },
    names_company_type: true,
    search_terms: terms("logistics", "field service", "payroll"),
  });
  const res = await savePlanResult(p);
  assert.equal(res.isError, false, res.text);
  const icp = (store.runs.get("P") as Row | undefined)?.refined_icp as Row;
  assert.equal(icp.target_company_type, "B2B SaaS");
  assert.deepEqual((icp.search_plan as Row).search_terms, p.search_terms);
});

test("search plans are rejected for each rule violation, with a clear reason", async () => {
  const cases: Array<[string, Row, RegExp]> = [
    ["too few terms", plan({ search_terms: terms("a1", "a2") }), /3-6 terms/],
    ["too many terms", plan({ search_terms: terms("a1", "a2", "a3", "a4", "a5", "a6", "a7") }), /3-6 terms/],
    ["3-word term", plan({ search_terms: terms("field service ops", "b", "c") }), /"field service ops" must be 1-2 words/],
    ["filler word", plan({ search_terms: terms("saas", "logistics", "payroll") }), /filler word\(s\) \(saas\)/],
    ["filler in 2 words", plan({ search_terms: terms("logistics platform", "b", "c") }), /filler word\(s\) \(platform\)/],
    ["missing reason", plan({ search_terms: [{ term: "a", reason: "" }, ...terms("b", "c")] }), /"a" needs a short reason/],
    ["repeated term", plan({ search_terms: terms("logistics", "Logistics", "c") }), /repeated/],
    ["company type named, no industries", plan({ names_company_type: true }), /filters\.industries is required/],
    ["unknown industry", plan({ filters: { industries: ["Computer Software"] } }), /Unknown LinkedIn industry "Computer Software"/],
    ["band outside range", plan({ filters: { employee_range: { min: 10, max: 100 }, company_sizes: ["11-50", "201-500"] } }), /201-500 does not overlap/],
    ["sizes without range", plan({ filters: { company_sizes: ["11-50"] } }), /company_sizes requires employee_range/],
    ["range without sizes", plan({ filters: { employee_range: { min: 10, max: 100 } } }), /company_sizes is required/],
  ];
  for (const [label, p, expected] of cases) {
    store = new MemoryStore();
    const res = await savePlanResult(p);
    assert.equal(res.isError, true, `${label} should be rejected`);
    assert.match(res.text, expected, label);
    assert.equal((store.runs.get("P") as Row | undefined)?.refined_icp, undefined, `${label}: nothing saved`);
  }
});

test("discovery is rejected before a search plan is saved", async () => {
  store.addRun("A");
  const f = makeFetch();
  const { call } = await setup(store, "A", f.impl, { searchPlan: false });
  const res = await call("discover_companies", { search_query: "q", max_results: 5 });
  assert.equal(res.isError, true);
  assert.match(res.text, /No search plan saved/);
  assert.equal(f.apifyCalls().length, 0);
  assert.match(store.toolCalls.at(-1)?.error_message ?? "", /^plan:/);
});

test("discovery rejects a search term that is not in the saved plan", async () => {
  store.addRun("A");
  const f = makeFetch();
  const { call } = await setup(store, "A", f.impl);
  const res = await call("discover_companies", { search_query: "B2B SaaS startup", max_results: 5 });
  assert.equal(res.isError, true);
  assert.match(res.text, /"B2B SaaS startup" is not in the saved search plan\. Use one of: "q", "q1"/);
  assert.equal(f.apifyCalls().length, 0);
});

test("discovery rejects filters that differ from the saved plan", async () => {
  store.addRun("A");
  const f = makeFetch();
  const { call } = await setup(store, "A", f.impl, {
    searchPlan: plan({
      filters: { location: "United States", employee_range: { min: 10, max: 100 }, company_sizes: ["11-50", "51-200"], industries: ["Software Development"] },
      names_company_type: true,
      search_terms: terms("logistics", "payroll", "field service"),
    }),
  });
  const base = { search_query: "logistics", location: "United States", company_sizes: ["11-50", "51-200"], industries: ["Software Development"], max_results: 5 };
  const cases: Array<[string, Row, string]> = [
    ["location", { location: "Canada" }, "location"],
    ["no location", { location: undefined }, "location"],
    ["sizes", { company_sizes: ["11-50"] }, "company_sizes"],
    ["industries", { industries: ["IT Services and IT Consulting"] }, "industries"],
    ["no industries", { industries: undefined }, "industries"],
  ];
  for (const [label, override, field] of cases) {
    const res = await call("discover_companies", { ...base, ...override });
    assert.equal(res.isError, true, label);
    assert.match(res.text, new RegExp(`Filters differ from the saved search plan \\(${field}\\)`), label);
  }
  assert.equal(f.apifyCalls().length, 0);
  // The exact plan filters, in any order and letter case, are accepted
  const ok = await call("discover_companies", { ...base, location: "united states", company_sizes: ["51-200", "11-50"] });
  assert.equal(ok.isError, false, ok.text);
});

test("the same term cannot be searched twice", async () => {
  store.addRun("A", { candidate_limit: 40 });
  const f = makeFetch();
  const { call } = await setup(store, "A", f.impl);
  assert.equal((await call("discover_companies", { search_query: "q1", max_results: 2 })).isError, false);
  const again = await call("discover_companies", { search_query: " Q1 ", max_results: 2 });
  assert.equal(again.isError, true);
  assert.match(again.text, /already searched/);
  assert.equal(f.apifyCalls().length, 1);
});

test(`at most ${MAX_DISCOVERY_CALLS_PER_RUN} discovery calls per run`, async () => {
  store.addRun("A", { candidate_limit: 40 });
  const f = makeFetch();
  const { call } = await setup(store, "A", f.impl);
  for (const t of ["q", "q1", "q2", "q3"]) {
    assert.equal((await call("discover_companies", { search_query: t, max_results: 1 })).isError, false, t);
  }
  const fifth = await call("discover_companies", { search_query: "q4", max_results: 1 });
  assert.equal(fifth.isError, true);
  assert.match(fifth.text, /Discovery call limit reached \(4 per run\)/);
  assert.equal(f.apifyCalls().length, 4);
});

test("a failed request frees its term for a retry but still counts toward the call limit", async () => {
  store.addRun("A", { candidate_limit: 40 });
  const { ctx, call } = await setup(store, "A", makeFetch({ apifyStatus: 503 }).impl);
  await call("discover_companies", { search_query: "q", max_results: 1 });
  assert.equal(ctx.usage.discoveryCalls, 1);
  assert.equal(ctx.searchedTerms.has("q"), false);
});

test("the LinkedIn total match count is returned to the agent and logged", async () => {
  store.addRun("A", { candidate_limit: 20 });
  const { call } = await setup(store, "A", makeFetch({ totalMatches: 1160 }).impl);
  const out = JSON.parse((await call("discover_companies", { search_query: "q", max_results: 3 })).text);
  assert.equal(out.linkedin_total_matches, 1160);
  assert.match(store.toolCalls.at(-1)?.result_summary ?? "", /^linkedin_total_matches=1160 granted=3/);

  store.addRun("B", { candidate_limit: 20 });
  const empty = await setup(store, "B", makeFetch({ returnCount: () => 0 }).impl);
  const none = JSON.parse((await empty.call("discover_companies", { search_query: "q", max_results: 3 })).text);
  assert.equal(none.linkedin_total_matches, 0);
});

test("the search plan is fixed once discovery starts; later ICP saves keep it", async () => {
  store.addRun("A", { candidate_limit: 20 });
  const { call } = await setup(store, "A", makeFetch().impl);
  const before = await call("update_run", { refined_icp: { industries: ["updated"] } });
  assert.equal(before.isError, false);
  assert.ok((((store.runs.get("A") as Row | undefined)?.refined_icp as Row).search_plan as Row).search_terms, "an ICP re-save keeps the plan");

  await call("discover_companies", { search_query: "q", max_results: 1 });
  const change = await call("update_run", { search_plan: plan({ search_terms: terms("x1", "x2", "x3") }) });
  assert.equal(change.isError, true);
  assert.match(change.text, /fixed once discovery has started/);
});

// --- save_lead: size band and outreach ---

async function setupWithBands() {
  store.addRun("A", { candidate_limit: 20, lead_limit: 3 });
  const f = makeFetch({
    returnCount: () => 0,
    extraResults: [
      { name: "Straddle Co", website: "https://straddle.io", linkedinUrl: "https://www.linkedin.com/company/straddle", employeeCountRange: { start: 51, end: 200 } },
      { name: "Fits Co", website: "https://fits.io", linkedinUrl: "https://www.linkedin.com/company/fits", employeeCountRange: { start: 11, end: 50 } },
      { name: "Tiny Co", website: "https://tiny.io", employeeCountRange: { start: 2, end: 10 } },
    ],
  });
  const s = await setup(store, "A", f.impl, {
    searchPlan: plan({
      filters: { location: "United States", employee_range: { min: 10, max: 100 }, company_sizes: ["1-10", "11-50", "51-200"], industries: ["Software Development"] },
      names_company_type: true,
      search_terms: terms("logistics", "payroll", "field service"),
    }),
  });
  const res = await s.call("discover_companies", {
    search_query: "logistics",
    location: "United States",
    company_sizes: ["1-10", "11-50", "51-200"],
    industries: ["Software Development"],
    max_results: 10,
  });
  assert.equal(res.isError, false, res.text);
  return s;
}

test("a qualified lead whose size band extends beyond the employee range is saved as needs_review", async () => {
  const { ctx, call } = await setupWithBands();
  const res = await call("save_lead", lead("Straddle Co", "straddle.io"));
  assert.equal(res.isError, false, res.text);
  assert.match(res.text, /Saved as needs_review instead of qualified: LinkedIn size band 51-200 extends beyond the objective's 10-100 employee range/);

  const saved = store.leads.find((l) => l.company_domain === "straddle.io")!;
  assert.equal(saved.qualification_status, "needs_review");
  assert.match(String((saved.concerns as string[])[0]), /51-200 extends beyond/);
  assert.equal(store.outreach.length, 0, "needs_review leads store no outreach");
  assert.equal(ctx.usage.qualified, 0, "does not count toward the qualified target");
  assert.match(store.toolCalls.at(-1)?.result_summary ?? "", /downgraded from qualified: size band/);

  // A band below the range is also beyond it
  assert.match((await call("save_lead", lead("Tiny Co", "tiny.io"))).text, /2-10 extends beyond/);
});

test("the size band is also found through the lead's LinkedIn URL", async () => {
  const { call } = await setupWithBands();
  const res = await call("save_lead", {
    ...lead("Straddle Co", "straddle-other-domain.io"),
    source_urls: ["https://www.linkedin.com/company/straddle"],
  });
  assert.match(res.text, /51-200 extends beyond/);
});

test("a qualified lead whose size band is within the range stays qualified", async () => {
  const { ctx, call } = await setupWithBands();
  const res = await call("save_lead", lead("Fits Co", "fits.io"));
  assert.equal(res.isError, false, res.text);
  assert.equal(store.leads.find((l) => l.company_domain === "fits.io")?.qualification_status, "qualified");
  assert.equal(ctx.usage.qualified, 1);
  assert.equal(store.outreach.length, 1);
});

test("a qualified lead without a LinkedIn message is rejected; the corrected retry saves exactly one lead", async () => {
  store.addRun("A");
  const { call } = await setup(store, "A", makeFetch().impl);
  const noLinkedin: Row = { ...OUTREACH };
  delete noLinkedin.linkedin_message;

  const missing = await call("save_lead", { ...lead("Acme", "acme.com"), outreach: noLinkedin });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /outreach\.linkedin_message are required\. Nothing was saved/);
  const blank = await call("save_lead", { ...lead("Acme", "acme.com"), outreach: { ...OUTREACH, linkedin_message: "   " } });
  assert.equal(blank.isError, true);
  const noOutreach = await call("save_lead", { ...lead("Acme", "acme.com"), outreach: undefined });
  assert.equal(noOutreach.isError, true);
  assert.equal(store.leads.length, 0);

  const retry = await call("save_lead", lead("Acme", "acme.com"));
  assert.equal(retry.isError, false, retry.text);
  assert.equal(store.leads.length, 1);
  assert.equal(store.outreach[0].linkedin_message, "Short LinkedIn note");
});

test("needs_review leads do not need outreach", async () => {
  store.addRun("A");
  const { call } = await setup(store, "A", makeFetch().impl);
  const res = await call("save_lead", { ...lead("Maybe Co", "maybe.io", "needs_review"), outreach: undefined });
  assert.equal(res.isError, false, res.text);
});

// --- Search-term guidance, full per-call requests, and source-backed outreach ---

async function systemPrompt(): Promise<string> {
  store.addRun("S");
  const ctx = (await createRunContext("S", store, makeFetch().impl))!;
  const server = createSdkMcpServer({ name: "lead-tools", version: "1.0.0", tools: createRunTools(ctx) });
  return String(buildQueryOptions(ctx, server).systemPrompt);
}

test("the system prompt tells the agent to pick product niches, not broad technology categories", async () => {
  const prompt = await systemPrompt();
  assert.match(prompt, /Choose specific product niches \(e\.g\. scheduling, invoicing, onboarding, helpdesk, payroll\), not broad technology categories \(e\.g\. cloud services, data analytics, business intelligence\)/);
  assert.match(prompt, /Broad categories match companies named after the category, which are usually consultancies and resellers, not SaaS product companies\./);
});

test("the system prompt tells the agent to always request the per-call cap", async () => {
  const prompt = await systemPrompt();
  assert.match(prompt, /Always request the per-call cap \(per_call_cap, given in the run limits\) as max_results, never less\. It is a cap, not a target/);
  assert.match(prompt, /You can stop researching early once you have enough qualified leads\./);
});

test("the system prompt requires every outreach claim to appear in the source evidence", async () => {
  const prompt = await systemPrompt();
  assert.ok(
    prompt.includes(
      "Every factual claim in outreach must appear in the lead's source evidence. Do not infer, extrapolate, or guess details about what a company does beyond what was retrieved."
    )
  );
});

test("the run prompt gives the exact per-call cap, matching what the tool enforces", async () => {
  for (const [candidateLimit, cap] of [[12, 6], [20, 10], [40, 20], [1, 1]] as const) {
    store = new MemoryStore();
    store.addRun("A", { candidate_limit: candidateLimit });
    const f = makeFetch();
    const { ctx, call } = await setup(store, "A", f.impl);
    assert.equal(perCallCapFor(candidateLimit), cap);
    assert.match(buildRunPrompt(ctx), new RegExp(`Per-call cap \\(per_call_cap\\): ${cap} — request exactly this as max_results`));
    const out = JSON.parse((await call("discover_companies", { search_query: "q", max_results: 20 })).text);
    assert.equal(out.per_call_cap, cap, `tool reports the same cap for budget ${candidateLimit}`);
    assert.equal(f.apifyCalls()[0].body.maxItems, cap);
  }
});

test("a qualified lead with no source records is rejected; the corrected retry saves exactly one lead", async () => {
  store.addRun("A");
  const { ctx, call } = await setup(store, "A", makeFetch().impl);
  for (const [label, sources] of [
    ["missing", undefined],
    ["empty", []],
    ["blank url", [{ url: "   ", relevant_evidence: "x" }]],
  ] as const) {
    const res = await call("save_lead", { ...lead("Acme", "acme.com"), sources });
    assert.equal(res.isError, true, label);
    assert.match(res.text, /qualified but has no source records\. Every claim in its outreach must trace to retrieved evidence/, label);
    assert.match(store.toolCalls.at(-1)?.error_message ?? "", /^validation:/, label);
  }
  assert.equal(store.leads.length, 0, "nothing was saved");
  assert.equal(ctx.usage.qualified, 0, "no qualified slot was reserved");

  const retry = await call("save_lead", lead("Acme", "acme.com"));
  assert.equal(retry.isError, false, retry.text);
  assert.equal(store.leads.length, 1);
  assert.equal(store.sources.length, 1);
});

test("needs_review leads (including size-band downgrades) do not need source records", async () => {
  store.addRun("A");
  const { call } = await setup(store, "A", makeFetch().impl);
  const res = await call("save_lead", { ...lead("Maybe Co", "maybe.io", "needs_review"), sources: undefined, outreach: undefined });
  assert.equal(res.isError, false, res.text);

  const bands = await setupWithBands();
  const downgraded = await bands.call("save_lead", { ...lead("Straddle Co", "straddle.io"), sources: [] });
  assert.equal(downgraded.isError, false, downgraded.text);
  assert.match(downgraded.text, /Saved as needs_review instead of qualified/);
});
