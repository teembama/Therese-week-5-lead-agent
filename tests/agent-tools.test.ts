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

async function setup(store: MemoryStore, runId: string, fetchImpl: typeof fetch) {
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
  return { ctx, tools, call };
}

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
  const { call } = await setup(store, "A", f.impl);
  await call("discover_companies", { search_query: "hr software", location: "United States", max_results: 20 });
  const c = f.apifyCalls()[0];
  assert.match(c.url, /harvestapi~linkedin-company-search/);
  assert.deepEqual(c.body, { searchQuery: "hr software", locations: ["United States"], maxItems: 4, scraperMode: "full" });
});

test("size and industry filters pass through, with industry names resolved to LinkedIn IDs", async () => {
  store.addRun("A", { candidate_limit: 12 });
  const f = makeFetch();
  const { call } = await setup(store, "A", f.impl);
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

test("unknown industry names are rejected before any Apify call or budget use", async () => {
  store.addRun("A", { candidate_limit: 12 });
  const f = makeFetch();
  const { ctx, call } = await setup(store, "A", f.impl);
  const res = await call("discover_companies", { search_query: "q", industries: ["Computer Software"], max_results: 5 });
  assert.equal(res.isError, true);
  assert.match(res.text, /Unknown LinkedIn industry name\(s\): "Computer Software"/);
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
  const a = await setup(store, "A", fa.impl);
  const b = await setup(store, "B", fb.impl);

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

test("tools stop and log when the run is no longer running", async () => {
  store.addRun("A");
  const f = makeFetch();
  const { call } = await setup(store, "A", f.impl);
  store.runs.get("A")!.status = "failed"; // cancelled by the user
  const res = await call("discover_companies", { search_query: "q", max_results: 5 });
  assert.equal(res.isError, true);
  assert.equal(f.calls.length, 0);
  assert.equal(store.toolCalls.at(-1)?.error_message?.startsWith("cancelled:"), true);
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
  await call("discover_companies", { search_query: "saas us", max_results: 5 });
  await call("scrape_company", { url: "https://acme.com/about?token=abc&email=jane@example.com" });

  const [disc, scrape] = store.toolCalls;
  assert.equal(disc.tool_name, "discover_companies");
  assert.equal(disc.status, "success");
  assert.equal(typeof disc.duration_ms, "number");
  assert.match(disc.input_summary, /query="saas us" location="" company_sizes=\[\] industries=\[\] requested=5 per_call_cap=10 budget_before=0\/20/);
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
