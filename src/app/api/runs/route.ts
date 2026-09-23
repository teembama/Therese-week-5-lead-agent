import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { runAgent } from "@/lib/agent";

const CANDIDATE_POOL_MULTIPLIER = 2;

// POST /api/runs — create run and start agent (validation already done by /api/validate)
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const objective = body.objective as string;
  const leadTarget = (body.leadTarget as number) || 10;

  if (!objective || typeof objective !== "string" || objective.trim().length === 0) {
    return NextResponse.json({ error: "Objective is required." }, { status: 400 });
  }

  const candidateLimit = leadTarget * CANDIDATE_POOL_MULTIPLIER;

  const { data: run, error: insertError } = await supabase
    .from("lead_runs")
    .insert({
      objective: objective.trim(),
      lead_limit: leadTarget,
      candidate_limit: candidateLimit,
      scrape_limit: candidateLimit,
      agent_turn_limit: 25,
    })
    .select("id")
    .single();

  if (insertError || !run) {
    return NextResponse.json({ error: "Failed to create run. Please try again." }, { status: 500 });
  }

  // Start agent in background
  runAgent({
    runId: run.id,
    objective: objective.trim(),
    leadLimit: leadTarget,
    candidateLimit,
    scrapeLimit: candidateLimit,
    agentTurnLimit: 25,
  }).catch((err) => {
    console.error("Agent failed:", err);
    supabase
      .from("lead_runs")
      .update({ status: "failed", error: String(err), updated_at: new Date().toISOString() })
      .eq("id", run.id);
  });

  return NextResponse.json({ run_id: run.id, status: "running" });
}

// GET /api/runs — list all runs
export async function GET() {
  const { data, error } = await supabase
    .from("lead_runs")
    .select("id, objective, status, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}
