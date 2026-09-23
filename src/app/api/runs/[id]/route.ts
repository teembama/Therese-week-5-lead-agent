import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getSession } from "@/lib/auth";

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

// PATCH /api/runs/[id] — cancel a run
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

  const { status, error: errorMsg } = body;

  if (status !== "failed") {
    return NextResponse.json({ error: "Can only cancel a run (set status to failed)." }, { status: 400 });
  }

  const { error } = await supabase
    .from("lead_runs")
    .update({
      status: "failed",
      error: (errorMsg as string) || "Cancelled by user",
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "running");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Best-effort: stop the Sandbox if on Vercel
  if (process.env.VERCEL) {
    try {
      const { Sandbox } = await import("@vercel/sandbox");
      const sandbox = await Sandbox.get({ name: `run-${id.slice(0, 8)}` });
      if (sandbox) await sandbox.stop();
    } catch {
      // Sandbox may already be stopped
    }
  }

  return NextResponse.json({ status: "cancelled" });
}