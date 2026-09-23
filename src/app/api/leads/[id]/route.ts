import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

// PATCH /api/leads/[id] — human reviewer promotes a needs_review lead to qualified
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { qualification_status, review_reason } = body;

  if (qualification_status !== "qualified") {
    return NextResponse.json(
      { error: "Can only promote a lead to qualified." },
      { status: 400 }
    );
  }

  if (typeof review_reason !== "string" || review_reason.trim().length === 0) {
    return NextResponse.json({ error: "A review reason is required." }, { status: 400 });
  }

  const reason = review_reason.trim();

  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select("id, run_id, company_name, qualification_status")
    .eq("id", id)
    .single();

  if (leadError || !lead) {
    return NextResponse.json({ error: "Lead not found." }, { status: 404 });
  }

  if (lead.qualification_status !== "needs_review") {
    return NextResponse.json(
      { error: "Only leads that need review can be promoted." },
      { status: 409 }
    );
  }

  const { data: updated, error: updateError } = await supabase
    .from("leads")
    .update({
      qualification_status: "qualified",
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("qualification_status", "needs_review") // Guard against concurrent promotions
    .select("*")
    .single();

  if (updateError || !updated) {
    return NextResponse.json(
      { error: "Failed to update lead. Please try again." },
      { status: 500 }
    );
  }

  const { error: logError } = await supabase.from("agent_tool_calls").insert({
    run_id: lead.run_id,
    tool_name: "manual_review",
    purpose: `Human reviewer promoted ${lead.company_name} to qualified`,
    input_summary: `Lead ${lead.id}: needs_review → qualified (outreach pending)`,
    result_summary: `Reason: ${reason}`,
    status: "success",
  });

  if (logError) {
    console.error("Failed to log manual review:", logError.message);
  }

  return NextResponse.json({ lead: updated });
}
