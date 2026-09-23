import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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
