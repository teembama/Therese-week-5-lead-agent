// Batch 1: stale-run recovery, heartbeat, run-request checks, cancelled migration, Node config.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recoverStaleRuns, heartbeatRun, STALE_RUN_MESSAGE } from "../src/lib/stale-runs";
import { parseRunRequest, STALE_RUN_MS, HEARTBEAT_INTERVAL_MS, MAX_OBJECTIVE_LENGTH } from "../src/lib/limits";

// --- A minimal fake of the Supabase query builder used by stale-runs.ts. It applies the same
// filters the real query sends (.eq / .lt) to in-memory rows, so the tests check the actual
// conditions in the code rather than a re-implementation of them.

type Row = { id: string; status: string; updated_at: string; error?: string | null; leads?: number };

function fakeClient(rows: Row[]) {
  const updates: Array<{ filters: string[]; payload: Record<string, unknown> }> = [];
  const client = {
    from(table: string) {
      assert.equal(table, "lead_runs");
      const filters: Array<[string, (r: Row) => boolean]> = [];
      let payload: Record<string, unknown> = {};
      const builder = {
        update(p: Record<string, unknown>) {
          payload = p;
          return builder;
        },
        eq(col: keyof Row, val: unknown) {
          filters.push([`${String(col)}=${String(val)}`, (r) => r[col] === val]);
          return builder;
        },
        lt(col: keyof Row, val: string) {
          filters.push([`${String(col)}<${val}`, (r) => new Date(String(r[col])).getTime() < new Date(val).getTime()]);
          return builder;
        },
        select() {
          return builder;
        },
        then(resolve: (v: { data: { id: string }[]; error: null }) => unknown) {
          const matched = rows.filter((r) => filters.every(([, f]) => f(r)));
          for (const r of matched) Object.assign(r, payload);
          updates.push({ filters: filters.map(([d]) => d), payload });
          return Promise.resolve({ data: matched.map((r) => ({ id: r.id })), error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, updates };
}

const NOW = Date.parse("2026-09-25T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function sampleRows(): Row[] {
  return [
    { id: "stale-running", status: "running", updated_at: ago(STALE_RUN_MS + 60_000), leads: 2 },
    { id: "fresh-running", status: "running", updated_at: ago(5 * 60_000) },
    { id: "old-completed", status: "completed", updated_at: ago(3 * 86_400_000), error: null },
    { id: "old-failed", status: "failed", updated_at: ago(3 * 86_400_000), error: "boom" },
    { id: "old-cancelled", status: "cancelled", updated_at: ago(3 * 86_400_000), error: "Cancelled by user." },
  ];
}

// --- Stale-run recovery ---

test("a stale running run is marked failed with an unexpected-stop message; its saved leads are untouched", async () => {
  const rows = sampleRows();
  const { client, updates } = fakeClient(rows);
  const recovered = await recoverStaleRuns(client, { now: NOW });
  assert.deepEqual(recovered, ["stale-running"]);
  const run = rows.find((r) => r.id === "stale-running")!;
  assert.equal(run.status, "failed");
  assert.equal(run.error, STALE_RUN_MESSAGE);
  assert.match(STALE_RUN_MESSAGE, /stopped unexpectedly/);
  assert.equal(run.leads, 2, "recovery only changes the run row, not its leads");
  // The update is conditional on the run still being running AND stale at write time
  assert.deepEqual(updates[0].filters, ["status=running", `updated_at<${ago(STALE_RUN_MS)}`]);
});

test("a running run with a recent heartbeat is not failed", async () => {
  const rows = sampleRows();
  await recoverStaleRuns(fakeClient(rows).client, { now: NOW });
  assert.equal(rows.find((r) => r.id === "fresh-running")!.status, "running");
});

test("completed, failed and cancelled runs are never changed, however old", async () => {
  const rows = sampleRows();
  const before = JSON.parse(JSON.stringify(rows.filter((r) => r.status !== "running")));
  await recoverStaleRuns(fakeClient(rows).client, { now: NOW });
  assert.deepEqual(rows.filter((r) => before.some((b: Row) => b.id === r.id)), before);
  assert.equal(rows.find((r) => r.id === "old-cancelled")!.status, "cancelled", "a cancelled run never becomes failed");
});

test("recovery is idempotent: a second pass changes nothing", async () => {
  const rows = sampleRows();
  const { client } = fakeClient(rows);
  assert.deepEqual(await recoverStaleRuns(client, { now: NOW }), ["stale-running"]);
  const snapshot = JSON.stringify(rows);
  assert.deepEqual(await recoverStaleRuns(client, { now: NOW + 1000 }), []);
  assert.equal(JSON.stringify(rows), snapshot);
});

test("scoped recovery only touches the given run", async () => {
  const rows = [...sampleRows(), { id: "other-stale", status: "running", updated_at: ago(STALE_RUN_MS * 2) }];
  const recovered = await recoverStaleRuns(fakeClient(rows).client, { now: NOW, runId: "other-stale" });
  assert.deepEqual(recovered, ["other-stale"]);
  assert.equal(rows.find((r) => r.id === "stale-running")!.status, "running");
});

test("a heartbeat keeps a long-running run from being recovered, and never revives a finished run", async () => {
  const rows: Row[] = [
    { id: "long-run", status: "running", updated_at: ago(STALE_RUN_MS + 60_000) },
    { id: "done", status: "cancelled", updated_at: ago(STALE_RUN_MS + 60_000) },
  ];
  const { client } = fakeClient(rows);
  await heartbeatRun(client, "long-run", NOW);
  await heartbeatRun(client, "done", NOW);
  assert.deepEqual(await recoverStaleRuns(client, { now: NOW }), [], "fresh heartbeat: not stale");
  assert.equal(rows[0].status, "running");
  assert.equal(rows[1].status, "cancelled");
  assert.equal(rows[1].updated_at, ago(STALE_RUN_MS + 60_000), "heartbeat did not touch the cancelled run");
  assert.ok(HEARTBEAT_INTERVAL_MS * 10 < STALE_RUN_MS, "many heartbeats fit inside the stale threshold");
});

// --- POST /api/runs structural checks ---

test("run requests: an empty or whitespace-only objective is rejected", () => {
  for (const objective of [undefined, "", "   ", 42]) {
    const r = parseRunRequest({ objective, leadTarget: 5 });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.error, "Objective is required.");
  }
});

test(`run requests: an objective over ${MAX_OBJECTIVE_LENGTH} characters is rejected; exactly ${MAX_OBJECTIVE_LENGTH} is allowed`, () => {
  const tooLong = parseRunRequest({ objective: "a".repeat(MAX_OBJECTIVE_LENGTH + 1), leadTarget: 5 });
  assert.equal(tooLong.ok, false);
  assert.match(!tooLong.ok ? tooLong.error : "", /too long/);
  assert.equal(parseRunRequest({ objective: "a".repeat(MAX_OBJECTIVE_LENGTH), leadTarget: 5 }).ok, true);
  // Surrounding whitespace does not count
  assert.equal(parseRunRequest({ objective: `  ${"a".repeat(MAX_OBJECTIVE_LENGTH)}  `, leadTarget: 5 }).ok, true);
});

test("run requests: more than 10 leads gets the specific maximum message", () => {
  for (const leadTarget of [11, 50, 1000]) {
    const r = parseRunRequest({ objective: "Find US SaaS companies", leadTarget });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.error, "You can request a maximum of 10 leads per run.");
  }
});

test("run requests: zero, negative, decimal or non-numeric lead targets are rejected", () => {
  for (const leadTarget of [0, -1, -10, 5.5, NaN, Infinity, "5", null, {}]) {
    const r = parseRunRequest({ objective: "Find US SaaS companies", leadTarget });
    assert.equal(r.ok, false, `rejects ${String(leadTarget)}`);
    assert.equal(!r.ok && r.error, "Lead target must be a whole number between 1 and 10.");
  }
});

test("run requests: valid requests pass, trimmed; a missing lead target defaults to 10", () => {
  assert.deepEqual(parseRunRequest({ objective: "  Find 3 US SaaS companies  ", leadTarget: 3 }), {
    ok: true,
    objective: "Find 3 US SaaS companies",
    leadTarget: 3,
  });
  const noTarget = parseRunRequest({ objective: "Find US SaaS companies" });
  assert.equal(noTarget.ok && noTarget.leadTarget, 10);
});

// --- Cancelled status in the database migration ---

test("the migration allows all four statuses, including cancelled, and changes no data", () => {
  const sql = readFileSync("supabase/migrations/20260924230000_add_cancelled_run_status.sql", "utf8");
  const active = sql
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .toLowerCase();
  assert.match(active, /drop constraint if exists lead_runs_status_check/);
  assert.match(active, /check \(status in \('running', 'completed', 'failed', 'cancelled'\)\)/);
  assert.doesNotMatch(active, /\b(update|delete|truncate|drop table|insert)\b/, "no data-changing statement outside comments");
  assert.doesNotMatch(active, /\bbegin\b|\bcommit\b/, "no explicit transaction (supabase db push adds its own)");
});

function activeSql(path: string): string {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .toLowerCase();
}

test("the leads migration adds a per-run unique domain index that allows null and empty domains", () => {
  const sql = activeSql("supabase/migrations/20260925120000_leads_unique_run_domain.sql");
  assert.match(sql, /create unique index if not exists leads_run_domain_unique/);
  assert.match(sql, /on public\.leads \(run_id, lower\(company_domain\)\)/);
  assert.match(sql, /where company_domain is not null and company_domain <> ''/);
  assert.doesNotMatch(sql, /\b(update|delete|truncate|drop|insert|alter)\b/, "adds an index only; changes no data");
  assert.doesNotMatch(sql, /\bbegin\b|\bcommit\b/);
});

test("the run migration allows one running run per user", () => {
  const sql = activeSql("supabase/migrations/20260925120100_one_running_run_per_user.sql");
  assert.match(sql, /create unique index if not exists lead_runs_one_running_per_user/);
  assert.match(sql, /on public\.lead_runs \(user_id\)\s+where status = 'running' and user_id is not null/);
  assert.doesNotMatch(sql, /\b(update|delete|truncate|drop|insert|alter)\b/);
});

test("the schema export covers every table the app uses", () => {
  const sql = readFileSync("supabase/schema.sql", "utf8");
  for (const table of ["users", "lead_runs", "leads", "lead_sources", "outreach_drafts", "agent_tool_calls"]) {
    assert.match(sql, new RegExp(`create table public\\.${table} \\(`), table);
  }
  assert.match(sql, /lead_runs_status_check check \(status in \('running', 'completed', 'failed', 'cancelled'\)\)/);
});

// --- Node / deployment configuration ---

test("package.json pins a Node range that satisfies Next.js and Supabase minimums", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const range: string = pkg.engines?.node ?? "";
  assert.equal(range, ">=20.9.0 <23");
  const next = JSON.parse(readFileSync("node_modules/next/package.json", "utf8")).engines.node as string;
  assert.equal(next, ">=20.9.0", "floor matches Next's own requirement");
  const [major, minor] = process.versions.node.split(".").map(Number);
  assert.ok(major > 20 || (major === 20 && minor >= 9), `test runtime ${process.version} is inside the range`);
  assert.ok(major < 23, `test runtime ${process.version} is inside the range`);
  assert.deepEqual([pkg.scripts.build, pkg.scripts.start], ["next build", "next start"]);
});

// --- Cost visibility ---

test("the Apify estimate is companies returned × $0.004", async () => {
  const { estimateApifyCost, APIFY_COST_PER_RESULT } = await import("../src/lib/limits");
  assert.equal(APIFY_COST_PER_RESULT, 0.004);
  assert.equal(estimateApifyCost(0), 0);
  assert.equal(estimateApifyCost(20), 0.08);
  assert.equal(estimateApifyCost(37), 0.148);
});

test("run completion saves the Claude cost and the Apify estimate from the companies returned", () => {
  const agent = readFileSync("src/lib/agent.ts", "utf8");
  assert.match(agent, /store\.recordCost\(runId, results\.cost, estimateApifyCost\(ctx\.usage\.candidates\)\)/);
  assert.match(agent, /update\(\{ actual_cost: cost, estimated_cost: apifyEstimate,/);
  const page = readFileSync("src/app/runs/[id]/page.tsx", "utf8");
  assert.match(page, /Claude cost: \$\{run\.actual_cost\.toFixed\(2\)\}/);
  assert.match(page, /Apify cost: ~\$\$\{run\.estimated_cost\.toFixed\(2\)\} \(estimated\)/);
  assert.match(page, /Firecrawl: free tier/);
});
