// Run creation rules for POST /api/runs (src/lib/create-run.ts)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRun, RUN_IN_PROGRESS_MESSAGE, type CreateRunDeps } from "../src/lib/create-run";
import { MAX_LEADS_MESSAGE } from "../src/lib/limits";

const OBJ = "Find 5 US B2B SaaS companies with 10 to 100 employees that may need AI automation";
const NOW = Date.parse("2026-09-25T12:00:00Z");

interface FakeRun {
  id: string;
  user_id: string;
  objective: string;
  status: string;
  created_at: string;
}

function fakeDb(runs: FakeRun[] = [], opts: { raceOnInsert?: boolean } = {}) {
  const inserted: Record<string, unknown>[] = [];
  const deps: CreateRunDeps = {
    async findRecentRun(userId, objective, since) {
      return (
        runs.find((r) => r.user_id === userId && r.objective === objective && r.status === "running" && r.created_at >= since)?.id ??
        null
      );
    },
    async findRunningRun(userId) {
      return runs.find((r) => r.user_id === userId && r.status === "running")?.id ?? null;
    },
    async insertRun(row) {
      if (opts.raceOnInsert) return "running_exists";
      inserted.push(row);
      const id = `run-${inserted.length}`;
      runs.push({ id, user_id: String(row.user_id), objective: String(row.objective), status: "running", created_at: new Date(NOW).toISOString() });
      return { id };
    },
  };
  return { deps, inserted };
}

const alice = { id: "user-alice" };

test("a valid request creates a run with limits derived from the lead target", async () => {
  const db = fakeDb();
  const res = await createRun(db.deps, alice, { objective: `  ${OBJ}  `, leadTarget: 5 }, NOW);
  assert.equal(res.httpStatus, 200);
  assert.equal(res.startRunId, "run-1");
  assert.deepEqual(db.inserted[0], {
    user_id: "user-alice",
    objective: OBJ,
    lead_limit: 5,
    candidate_limit: 20,
    scrape_limit: 20,
    agent_turn_limit: 25,
  });
});

test("structural checks run even when /api/validate was skipped", async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ objective: "" }, /required/],
    [{ objective: "x".repeat(1001) }, /too long/],
    [{ objective: "SaaS pls" }, /complete description/],
    [{ objective: "Find 50 US SaaS companies that need automation" }, new RegExp(MAX_LEADS_MESSAGE)],
    [{ objective: OBJ, leadTarget: 50 }, new RegExp(MAX_LEADS_MESSAGE)],
    [{ objective: OBJ, leadTarget: 0 }, /whole number between 1 and 10/],
  ];
  for (const [body, error] of cases) {
    const db = fakeDb();
    const res = await createRun(db.deps, alice, body, NOW);
    assert.equal(res.httpStatus, 400, JSON.stringify(body).slice(0, 60));
    assert.match(String(res.body.error), error);
    assert.equal(db.inserted.length, 0, "no run is created");
  }
});

test("a user with a run in progress gets 409 with a clear message; nothing is created", async () => {
  const db = fakeDb([{ id: "run-old", user_id: "user-alice", objective: "Other objective here", status: "running", created_at: "2026-09-25T11:00:00Z" }]);
  const res = await createRun(db.deps, alice, { objective: OBJ, leadTarget: 5 }, NOW);
  assert.equal(res.httpStatus, 409);
  assert.equal(res.body.error, "You already have a run in progress. Please wait for it to complete or cancel it.");
  assert.equal(res.body.error, RUN_IN_PROGRESS_MESSAGE);
  assert.equal(res.startRunId, undefined, "no agent is started");
  assert.equal(db.inserted.length, 0);
});

test("finished runs and other users' running runs do not block a new run", async () => {
  const db = fakeDb([
    { id: "r1", user_id: "user-alice", objective: "a b c", status: "completed", created_at: "2026-09-25T11:00:00Z" },
    { id: "r2", user_id: "user-alice", objective: "a b c", status: "cancelled", created_at: "2026-09-25T11:00:00Z" },
    { id: "r3", user_id: "user-bob", objective: "a b c", status: "running", created_at: "2026-09-25T11:00:00Z" },
  ]);
  const res = await createRun(db.deps, alice, { objective: OBJ, leadTarget: 5 }, NOW);
  assert.equal(res.httpStatus, 200);
  assert.ok(res.startRunId);
});

test("a double click (same objective within 30 s) returns the run already started, not a 409", async () => {
  const db = fakeDb();
  const first = await createRun(db.deps, alice, { objective: OBJ, leadTarget: 5 }, NOW);
  const second = await createRun(db.deps, alice, { objective: OBJ, leadTarget: 5 }, NOW + 5_000);
  assert.equal(second.httpStatus, 200);
  assert.equal(second.body.run_id, first.startRunId);
  assert.equal(second.startRunId, undefined, "the agent is not started twice");
  assert.equal(db.inserted.length, 1);
  // A different objective while that run is going is a 409
  const other = await createRun(db.deps, alice, { objective: "Find 3 US logistics firms that need route planning", leadTarget: 3 }, NOW + 6_000);
  assert.equal(other.httpStatus, 409);
});

test("if the database's one-running-run index rejects a concurrent insert, the result is the same 409", async () => {
  const db = fakeDb([], { raceOnInsert: true });
  const res = await createRun(db.deps, alice, { objective: OBJ, leadTarget: 5 }, NOW);
  assert.equal(res.httpStatus, 409);
  assert.equal(res.body.error, RUN_IN_PROGRESS_MESSAGE);
  assert.equal(res.startRunId, undefined);
});

test("the route delegates to createRun, recovers stale runs first, and maps the unique violation", () => {
  const route = readFileSync("src/app/api/runs/route.ts", "utf8");
  assert.match(route, /await createRun\(/);
  assert.match(route, /error\?\.code === "23505"\) return "running_exists"/);
  assert.match(route, /recoverStaleRuns\(supabase\)[\s\S]*createRun\(/, "stale runs are recovered before the in-progress check");
});
