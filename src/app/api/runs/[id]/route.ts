import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getSession } from "@/lib/auth";
import { cancelRun } from "@/lib/cancel-run";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const { id } = await params;

  // Fetch run
  const { data: run, error: runError } = await supabase
    .from("lead_runs")
    .select("*")
    .eq("id", id)
    .single();

  if (runError || !run) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  // Stale run detection: if running for more than 35 minutes, mark as failed
  if (run.status === "running") {
    const runAge = Date.now() - new Date(run.updated_at || run.created_at).getTime();
    if (runAge > 35 * 60 * 1000) {
      await supabase
        .from("lead_runs")
        .update({
          status: "failed",
          error: "The research took too long and was stopped. Please try again with fewer leads or broader criteria.",
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .eq("status", "running");
      run.status = "failed";
      run.error = "The research took too long and was stopped. Please try again with fewer leads or broader criteria.";
    }
  }

  // Fetch leads with sources and outreach
  const { data: leads } = await supabase
    .from("leads")
    .select(`
      *,
      lead_sources (*),
      outreach_drafts (*)
    `)
    .eq("run_id", id)
    .order("created_at", { ascending: true });

  // Fetch tool calls
  const { data: toolCalls } = await supabase
    .from("agent_tool_calls")
    .select("*")
    .eq("run_id", id)
    .order("created_at", { ascending: true });

  return NextResponse.json({
    run,
    leads: leads || [],
    toolCalls: toolCalls || [],
  });
}

// PATCH /api/runs/[id] — cancel a run. Body: { status: "cancelled" }.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (body.status !== "cancelled") {
    return NextResponse.json({ error: 'Only cancellation is supported: send { "status": "cancelled" }.' }, { status: 400 });
  }

  try {
    const result = await cancelRun(
      {
        async getRun(runId) {
          const { data } = await supabase.from("lead_runs").select("status, user_id").eq("id", runId).maybeSingle();
          return data;
        },
        async setStatusIfRunning(runId, status, message) {
          const { data, error } = await supabase
            .from("lead_runs")
            .update({ status, error: message, updated_at: new Date().toISOString() })
            .eq("id", runId)
            .eq("status", "running")
            .select("id");
          if (error?.code === "23514") return "constraint"; // check_violation
          if (error) throw new Error(error.message);
          return data && data.length > 0 ? "updated" : "not_running";
        },
        async logCancellation(runId, detail) {
          const { error } = await supabase.from("agent_tool_calls").insert({
            run_id: runId,
            tool_name: "manual_cancel",
            purpose: "User cancelled the run",
            input_summary: "",
            result_summary: detail,
            status: "success",
          });
          if (error) throw new Error(error.message);
        },
      },
      id,
      user
    );
    return NextResponse.json(result.body, { status: result.httpStatus });
  } catch (err) {
    console.error(`Cancel failed for run ${id}:`, err);
    return NextResponse.json({ error: "Could not cancel the run. Please try again." }, { status: 500 });
  }
}