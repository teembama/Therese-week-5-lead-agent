import { CANCEL_MESSAGE, type RunStatus } from "./run-status";

// Cancellation rules, kept separate from the route so they can be tested without a server.

export interface CancelUser {
  id: string;
  username: string;
  role: string;
}

export interface CancelDeps {
  getRun(runId: string): Promise<{ status: string; user_id: string | null } | null>;
  // Sets the status only while the run is still "running". "constraint" means the database
  // rejected the status value (the cancelled-status migration has not been applied yet).
  setStatusIfRunning(runId: string, status: RunStatus, message: string): Promise<"updated" | "not_running" | "constraint">;
  logCancellation(runId: string, detail: string): Promise<void>;
}

export interface CancelResult {
  httpStatus: number;
  body: Record<string, unknown>;
}

function finishedResult(status: string): CancelResult {
  return {
    httpStatus: 409,
    body: {
      error: `This run has already ${status === "completed" ? "completed" : "ended"} and can no longer be cancelled.`,
      status,
    },
  };
}

export async function cancelRun(deps: CancelDeps, runId: string, user: CancelUser): Promise<CancelResult> {
  const run = await deps.getRun(runId);
  if (!run) return { httpStatus: 404, body: { error: "Run not found." } };

  // Only the person who started the run, or an admin, may cancel it
  if (run.user_id !== user.id && user.role !== "admin") {
    return { httpStatus: 403, body: { error: "Only the person who started this run, or an admin, can cancel it." } };
  }

  // Repeating a cancellation is safe and changes nothing
  if (run.status === "cancelled") return { httpStatus: 200, body: { status: "cancelled", already_cancelled: true } };
  // A finished run is never overwritten
  if (run.status !== "running") return finishedResult(run.status);

  let storedAs: RunStatus = "cancelled";
  let result = await deps.setStatusIfRunning(runId, "cancelled", CANCEL_MESSAGE);
  if (result === "constraint") {
    // Until the database migration adds "cancelled", stopping the run still matters more than
    // the label: store the legacy value so the agent's tools stop, and flag it in the logs.
    console.warn(`cancelRun: database rejected status "cancelled" for run ${runId}; apply supabase/migrations/*_add_cancelled_run_status.sql. Storing "failed".`);
    storedAs = "failed";
    result = await deps.setStatusIfRunning(runId, "failed", CANCEL_MESSAGE);
  }

  if (result !== "updated") {
    // The run finished (or was cancelled) between the read and the write
    const now = await deps.getRun(runId);
    if (now?.status === "cancelled") return { httpStatus: 200, body: { status: "cancelled", already_cancelled: true } };
    return finishedResult(now?.status ?? "ended");
  }

  try {
    const legacy = storedAs === "failed" ? ' (stored as "failed": cancelled-status migration not applied)' : "";
    await deps.logCancellation(runId, `Run cancelled by ${user.username}${legacy}`);
  } catch (err) {
    console.error(`cancelRun: could not log cancellation for run ${runId}:`, err);
  }

  return { httpStatus: 200, body: { status: "cancelled", stored_as: storedAs } };
}
