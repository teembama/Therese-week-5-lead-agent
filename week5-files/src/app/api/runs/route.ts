import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { runAgent } from "@/lib/agent";

// POST /api/runs — create a run and start the agent
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { objective } = body;

  if (!objective || typeof objective !== "string" || objective.trim().length === 0) {
    return NextResponse.json({ error: "objective is required" }, { status: 400 });
  }

  // Create run record
  const { data: run, error: insertError } = await supabase
    .from("lead_runs")
    .insert({
      objective: objective.trim(),
      lead_limit: 10,
      candidate_limit: 20,
      scrape_limit: 20,
      agent_turn_limit: 25,
    })
    .select("id")
    .single();

  if (insertError || !run) {
    return NextResponse.json(
      { error: `Failed to create run: ${insertError?.message}` },
      { status: 500 }
    );
  }

  // Start the agent (non-blocking for now — will add streaming later)
  // For Day 1, run synchronously so we can test the loop
  const result = await runAgent({
    runId: run.id,
    objective: objective.trim(),
    leadLimit: 10,
    candidateLimit: 20,
    scrapeLimit: 20,
    agentTurnLimit: 25,
  });

  return NextResponse.json({
    run_id: run.id,
    status: result.status,
    cost: result.cost,
    messages: result.messages,
  });
}

// GET /api/runs — list all runs
export async function GET() {
  const { data, error } = await supabase
    .from("lead_runs")
    .select("id, objective, status, created_at, refined_icp")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}
