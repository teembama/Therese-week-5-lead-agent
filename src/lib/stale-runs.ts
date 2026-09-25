import type { SupabaseClient } from "@supabase/supabase-js";
import { STALE_RUN_MS } from "./limits";

// Stale-run recovery. The agent runs inside the web process, so a crash or restart (e.g. a
// Railway redeploy) leaves its run "running" with no process behind it. A live run refreshes
// updated_at every HEARTBEAT_INTERVAL_MS; a run with no update for STALE_RUN_MS is orphaned.
// Nothing is resumed: the run is marked failed and the leads it already saved are kept.

export const STALE_RUN_MESSAGE =
  "This run stopped unexpectedly (the server may have restarted). Any leads found before it stopped are saved. Please start a new run.";

// Marks orphaned runs failed and returns their ids. One conditional UPDATE: it only matches
// rows that are still "running" AND stale at write time, so completed, failed and cancelled runs
// are never touched, a heartbeat that lands first wins, and repeating it is a no-op.
export async function recoverStaleRuns(
  client: SupabaseClient,
  opts: { now?: number; runId?: string } = {}
): Promise<string[]> {
  const now = opts.now ?? Date.now();
  const cutoff = new Date(now - STALE_RUN_MS).toISOString();

  let query = client
    .from("lead_runs")
    .update({ status: "failed", error: STALE_RUN_MESSAGE, updated_at: new Date(now).toISOString() })
    .eq("status", "running")
    .lt("updated_at", cutoff);
  if (opts.runId) query = query.eq("id", opts.runId);

  const { data, error } = await query.select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: { id: string }) => r.id);
}

// Heartbeat for a live run; only touches the run while it is still "running"
export async function heartbeatRun(client: SupabaseClient, runId: string, now: number = Date.now()): Promise<void> {
  const { error } = await client
    .from("lead_runs")
    .update({ updated_at: new Date(now).toISOString() })
    .eq("id", runId)
    .eq("status", "running");
  if (error) throw new Error(error.message);
}
