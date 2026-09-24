import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getSession, requireRole } from "@/lib/auth";
import {
  MAX_LEADS,
  DEFAULT_AGENT_TURN_LIMIT,
  parseLeadTarget,
  candidateLimitFor,
} from "@/lib/limits";

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

  const objective = body.objective as string;
  if (!objective || typeof objective !== "string" || objective.trim().length === 0) {
    return NextResponse.json({ error: "Objective is required." }, { status: 400 });
  }

  // The candidate and scrape budgets derive from this, so it must be bounded server-side
  const leadTarget = parseLeadTarget(body.leadTarget ?? MAX_LEADS);
  if (leadTarget === null) {
    return NextResponse.json(
      { error: `Lead target must be a whole number between 1 and ${MAX_LEADS}.` },
      { status: 400 }
    );
  }

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

  const { data, error } = await supabase
    .from("lead_runs")
    .select("id, objective, status, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}