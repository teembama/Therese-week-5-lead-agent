// Cancellation rules (src/lib/cancel-run.ts) against an in-memory run table.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cancelRun, type CancelDeps, type CancelUser } from "../src/lib/cancel-run";
import { CANCEL_MESSAGE, RUN_STATUSES, isRunStatus, statusBadgeClass } from "../src/lib/run-status";

type Run = { status: string; user_id: string | null; error?: string };

// `allowCancelled: false` simulates the database before the migration (check constraint rejects it)
function fakeDb(runs: Record<string, Run>, opts: { allowCancelled?: boolean; beforeWrite?: () => void } = {}) {
  const writes: Array<{ id: string; status: string }> = [];
  const logs: string[] = [];
  const deps: CancelDeps = {
    async getRun(id) {
      const r = runs[id];
      return r ? { status: r.status, user_id: r.user_id } : null;
    },
    async setStatusIfRunning(id, status, message) {
      opts.beforeWrite?.();
      if (status === "cancelled" && opts.allowCancelled === false) return "constraint";
      const r = runs[id];
      if (!r || r.status !== "running") return "not_running";
      r.status = status;
      r.error = message;
      writes.push({ id, status });
      return "updated";
    },
    async logCancellation(id, detail) {
      logs.push(`${id}: ${detail}`);
    },
  };
  return { deps, writes, logs };
}

const owner: CancelUser = { id: "u-owner", username: "researcher", role: "researcher" };
const otherResearcher: CancelUser = { id: "u-other", username: "someone", role: "researcher" };
const reviewer: CancelUser = { id: "u-rev", username: "reviewer", role: "reviewer" };
const admin: CancelUser = { id: "u-admin", username: "admin", role: "admin" };

test("the run's owner can cancel it; it is stored as cancelled with a user-facing message, and logged", async () => {
  const runs = { r1: { status: "running", user_id: owner.id } };
  const { deps, writes, logs } = fakeDb(runs);
  const res = await cancelRun(deps, "r1", owner);
  assert.equal(res.httpStatus, 200);
  assert.deepEqual(res.body, { status: "cancelled", stored_as: "cancelled" });
  assert.equal(runs.r1.status, "cancelled");
  assert.equal((runs.r1 as Run).error, CANCEL_MESSAGE);
  assert.equal(writes.length, 1);
  assert.deepEqual(logs, ["r1: Run cancelled by researcher"]);
});

test("an admin can cancel anyone's run", async () => {
  const runs = { r1: { status: "running", user_id: owner.id } };
  const res = await cancelRun(fakeDb(runs).deps, "r1", admin);
  assert.equal(res.httpStatus, 200);
  assert.equal(runs.r1.status, "cancelled");
});

test("other users cannot cancel a run they did not start", async () => {
  for (const user of [otherResearcher, reviewer]) {
    const runs = { r1: { status: "running", user_id: owner.id } };
    const { deps, writes } = fakeDb(runs);
    const res = await cancelRun(deps, "r1", user);
    assert.equal(res.httpStatus, 403, user.username);
    assert.equal(runs.r1.status, "running");
    assert.equal(writes.length, 0);
  }
  // Legacy runs with no recorded owner can only be cancelled by an admin
  const legacy = { r2: { status: "running", user_id: null } };
  assert.equal((await cancelRun(fakeDb(legacy).deps, "r2", owner)).httpStatus, 403);
  assert.equal((await cancelRun(fakeDb(legacy).deps, "r2", admin)).httpStatus, 200);
});

test("repeating a cancellation is safe: 200, no second write, no second log", async () => {
  const runs = { r1: { status: "running", user_id: owner.id } };
  const { deps, writes, logs } = fakeDb(runs);
  await cancelRun(deps, "r1", owner);
  const again = await cancelRun(deps, "r1", owner);
  assert.equal(again.httpStatus, 200);
  assert.deepEqual(again.body, { status: "cancelled", already_cancelled: true });
  assert.equal(writes.length, 1);
  assert.equal(logs.length, 1);
});

test("a completed or failed run cannot be cancelled or overwritten", async () => {
  for (const status of ["completed", "failed"]) {
    const runs = { r1: { status, user_id: owner.id } };
    const { deps, writes } = fakeDb(runs);
    const res = await cancelRun(deps, "r1", owner);
    assert.equal(res.httpStatus, 409, status);
    assert.equal(res.body.status, status);
    assert.equal(runs.r1.status, status, `${status} run unchanged`);
    assert.equal(writes.length, 0);
  }
});

test("if the run completes between the check and the write, the completed status stands", async () => {
  const runs = { r1: { status: "running", user_id: owner.id } };
  const { deps, writes } = fakeDb(runs, { beforeWrite: () => { runs.r1.status = "completed"; } });
  const res = await cancelRun(deps, "r1", owner);
  assert.equal(res.httpStatus, 409);
  assert.equal(runs.r1.status, "completed");
  assert.equal(writes.length, 0);
});

test("unknown runs return 404", async () => {
  assert.equal((await cancelRun(fakeDb({}).deps, "missing", owner)).httpStatus, 404);
});

test("before the migration, cancelling still stops the run (stored as failed) and says so in the log", async () => {
  const runs = { r1: { status: "running", user_id: owner.id } };
  const { deps, logs } = fakeDb(runs, { allowCancelled: false });
  const res = await cancelRun(deps, "r1", owner);
  assert.equal(res.httpStatus, 200);
  assert.deepEqual(res.body, { status: "cancelled", stored_as: "failed" });
  assert.equal(runs.r1.status, "failed");
  assert.equal((runs.r1 as Run).error, CANCEL_MESSAGE);
  assert.match(logs[0], /migration not applied/);
});

test("run statuses include cancelled, with its own badge distinct from failed", () => {
  assert.deepEqual([...RUN_STATUSES], ["running", "completed", "failed", "cancelled"]);
  assert.ok(isRunStatus("cancelled"));
  assert.ok(!isRunStatus("canceled"));
  assert.notEqual(statusBadgeClass("cancelled"), statusBadgeClass("failed"));
});
