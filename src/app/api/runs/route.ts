import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getSession, requireRole } from "@/lib/auth";
import { DEFAULT_AGENT_TURN_LIMIT, parseRunRequest, candidateLimitFor } from "@/lib/limits";
import { recoverStaleRuns } from "@/lib/stale-runs";

// POST /api/runs — create run and start agent (validation already done by /api/validate)
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

  // Structural checks, enforced even when /api/validate was skipped. The candidate and
  // scrape budgets derive from the lead target, so it must be bounded here.
  const parsed = parseRunRequest(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { objective, leadTarget } = parsed;

  const candidateLimit = candidateLimitFor(leadTarget);

  // Idempotency: return an identical run started in the last 30s instead of duplicating it
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

  const { data: run, error: insertError } = await supabase
    .from("lead_runs")
    .insert({
      user_id: user.id,
      objective: objective.trim(),
      lead_limit: leadTarget,
      candidate_limit: candidateLimit,
      scrape_limit: candidateLimit,
      agent_turn_limit: DEFAULT_AGENT_TURN_LIMIT,
    })
    .select("id")
    .single();

  if (insertError || !run) {
    return NextResponse.json({ error: "Failed to create run. Please try again." }, { status: 500 });
  }

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

  return NextResponse.json(data);
}