import { NextRequest, NextResponse, after } from "next/server";
import { supabase } from "@/lib/supabase";
import { getSession, requireRole } from "@/lib/auth";
import { notifyOutreachApproved } from "@/lib/discord";

// PATCH /api/outreach/[id] — human reviewer approves an outreach draft
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  if (!requireRole(user, ["reviewer", "admin"])) {
    return NextResponse.json({ error: "Only reviewers can approve outreach." }, { status: 403 });
  }

  const { id } = await params;

  const { data: draft, error: draftError } = await supabase
    .from("outreach_drafts")
    .select("id, lead_id, status")
    .eq("id", id)
    .single();

  if (draftError || !draft) {
    return NextResponse.json({ error: "Outreach draft not found." }, { status: 404 });
  }

  if (draft.status !== "draft") {
    return NextResponse.json(
      { error: "Only draft outreach can be approved." },
      { status: 409 }
    );
  }

  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select("id, run_id, company_name, qualification_status")
    .eq("id", draft.lead_id)
    .single();

  if (leadError || !lead) {
    return NextResponse.json({ error: "Lead not found." }, { status: 404 });
  }

  if (lead.qualification_status !== "qualified") {
    return NextResponse.json(
      { error: "Outreach can only be approved for qualified leads." },
      { status: 409 }
    );
  }

  const { data: updated, error: updateError } = await supabase
    .from("outreach_drafts")
    .update({ status: "approved" })
    .eq("id", id)
    .eq("status", "draft") // Guard against concurrent approvals
    .select("*")
    .single();

  if (updateError || !updated) {
    return NextResponse.json(
      { error: "Failed to approve outreach. Please try again." },
      { status: 500 }
    );
  }

  const { error: logError } = await supabase.from("agent_tool_calls").insert({
    run_id: lead.run_id,
    tool_name: "manual_approval",
    purpose: `Human reviewer approved outreach for ${lead.company_name}`,
    input_summary: `Outreach ${draft.id} for lead ${lead.id}: draft → approved`,
    result_summary: `Approved by ${user.username}`,
    status: "success",
  });

  if (logError) {
    console.error("Failed to log outreach approval:", logError.message);
  }

  // Optional Discord notice, sent after the response so it never delays or blocks the approval
  after(() =>
    notifyOutreachApproved({
      runId: lead.run_id,
      companyName: lead.company_name,
      approvedBy: user.username,
      requestOrigin: req.nextUrl.origin,
    })
  );

  return NextResponse.json({ outreach: updated });
}
