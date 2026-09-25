import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getSession, requireRole } from "@/lib/auth";
import { createRun } from "@/lib/create-run";
import { recoverStaleRuns } from "@/lib/stale-runs";

// POST /api/runs — create a run and start its agent. The Haiku check is done by /api/validate;
// structural checks and the one-running-run-per-user cap are enforced here.
export async function POST(req: NextRequest) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  if (!requireRole(user, ["researcher", "admin"])) {
    return NextResponse.json({ error: "Only researchers can start runs." }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  // Resolve this server's orphaned runs first, so a run whose process died does not count as
  // "in progress" and block the user
  try {
    await recoverStaleRuns(supabase);
  } catch (err) {
    console.error("Stale-run recovery failed:", err);
  }

  // Structural checks (enforced even when /api/validate was skipped), duplicate clicks, and one
  // running run per user: see src/lib/create-run.ts
  let result;
  try {
    result = await createRun(
      {
        async findRecentRun(userId, objective, since) {
          const { data, error } = await supabase
            .from("lead_runs")
            .select("id")
            .eq("user_id", userId)
            .eq("objective", objective)
            .eq("status", "running")
            .gte("created_at", since)
            .limit(1);
          if (error) throw new Error(error.message);
          return data?.[0]?.id ?? null;
        },
        async findRunningRun(userId) {
          const { data, error } = await supabase
            .from("lead_runs")
            .select("id")
            .eq("user_id", userId)
            .eq("status", "running")
            .limit(1);
          if (error) throw new Error(error.message);
          return data?.[0]?.id ?? null;
        },
        async insertRun(row) {
          const { data, error } = await supabase.from("lead_runs").insert(row).select("id").single();
          // unique_violation on lead_runs_one_running_per_user: a concurrent request won the race
          if (error?.code === "23505") return "running_exists";
          if (error || !data) throw new Error(error?.message ?? "no row returned");
          return { id: data.id as string };
        },
      },
      user,
      body
    );
  } catch (err) {
    console.error("Run creation failed:", err);
    return NextResponse.json({ error: "Failed to create run. Please try again." }, { status: 500 });
  }

  if (!result.startRunId) {
    return NextResponse.json(result.body, { status: result.httpStatus });
  }
  const run = { id: result.startRunId };

  // Start agent in-process in the background. It loads its objective and limits from the
  // run record and records its own failures, so only the run id is passed.
  const { runAgent } = await import("@/lib/agent");
  runAgent(run.id).catch((err) => {
    console.error("Agent failed:", err);
  });

  return NextResponse.json({ run_id: run.id, status: "running" });
}

// GET /api/runs — list all runs
export async function GET() {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  // Resolve runs orphaned by a crash/restart before listing them, so none stays "running" forever
  try {
    const recovered = await recoverStaleRuns(supabase);
    if (recovered.length) console.warn(`Recovered ${recovered.length} stale run(s): ${recovered.join(", ")}`);
  } catch (err) {
    console.error("Stale-run recovery failed:", err);
  }

  const { data, error } = await supabase
    .from("lead_runs")
    .select("id, objective, status, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Leads still awaiting review per run, for the "needs review" indicator in the runs list
  const { data: pending, error: pendingError } = await supabase
    .from("leads")
    .select("run_id")
    .eq("qualification_status", "needs_review");
  if (pendingError) console.error("Could not count leads awaiting review:", pendingError.message);
  const pendingByRun = new Map<string, number>();
  for (const row of pending ?? []) pendingByRun.set(row.run_id, (pendingByRun.get(row.run_id) ?? 0) + 1);

  return NextResponse.json((data ?? []).map((run) => ({ ...run, needs_review_count: pendingByRun.get(run.id) ?? 0 })));
}