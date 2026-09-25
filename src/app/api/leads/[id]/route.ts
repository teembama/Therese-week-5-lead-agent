import { NextRequest, NextResponse, after } from "next/server";
import { supabase } from "@/lib/supabase";
import { getSession, requireRole } from "@/lib/auth";
import { notifyLeadPromoted } from "@/lib/discord";
import Anthropic from "@anthropic-ai/sdk";
import {
  MAX_REASON_LENGTH,
  createValidationToken,
  validatePromotionReason,
  verifyValidationToken,
} from "@/lib/promotion-validation";

// PATCH /api/leads/[id] — human reviewer promotes a needs_review lead to qualified
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  if (!requireRole(user, ["reviewer", "admin"])) {
    return NextResponse.json({ error: "Only reviewers can approve leads." }, { status: 403 });
  }

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
  if (reason.length > MAX_REASON_LENGTH) {
    return NextResponse.json(
      { error: `Please keep the reason under ${MAX_REASON_LENGTH} characters.` },
      { status: 400 }
    );
  }

  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select("id, run_id, company_name, company_domain, qualification_status, concerns, fit_reasons")
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

  // The reason is checked by Claude Haiku (no structural fallback). The UI validates first
  // (validate_only), asks the reviewer to confirm, then sends the token it received so the
  // confirmed request does not need a second model call. Without a valid token, it validates here.
  const validateOnly = body.validate_only === true;
  if (validateOnly || !verifyValidationToken(body.validation_token, lead.id, user.id, reason)) {
    const { data: run } = await supabase.from("lead_runs").select("objective").eq("id", lead.run_id).single();
    const check = await validatePromotionReason(
      {
        companyName: lead.company_name,
        companyDomain: lead.company_domain,
        concerns: Array.isArray(lead.concerns) ? lead.concerns : [],
        fitReasons: Array.isArray(lead.fit_reasons) ? lead.fit_reasons : [],
        objective: run?.objective ?? "",
        reason,
      },
      async (prompt) => {
        const client = new Anthropic();
        const response = await client.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 200,
          messages: [{ role: "user", content: prompt }],
        });
        return response.content[0]?.type === "text" ? response.content[0].text : "";
      }
    );
    if (!check.ok) {
      return NextResponse.json(
        { error: check.error, ...(check.example ? { example: check.example } : {}) },
        { status: check.httpStatus }
      );
    }
  }

  if (validateOnly) {
    return NextResponse.json({ valid: true, validation_token: createValidationToken(lead.id, user.id, reason) });
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
    purpose: `Human reviewer promoted ${lead.company_name} to qualified (reviewer: ${user.username})`,
    input_summary: `Lead ${lead.id}: needs_review → qualified (outreach pending)`,
    result_summary: `Reason: ${reason}`,
    status: "success",
  });

  if (logError) {
    console.error("Failed to log manual review:", logError.message);
  }

  // Optional Discord notice, sent after the response so it never delays the promotion
  after(() =>
    notifyLeadPromoted({
      runId: lead.run_id,
      companyName: lead.company_name,
      promotedBy: user.username,
      reason,
      requestOrigin: req.nextUrl.origin,
    })
  );

  // Draft outreach for the newly qualified lead (evidence is scraped first: needs_review leads
  // have no stored sources). The promotion is already saved; a failure here is reported, not undone.
  const { generatePromotedOutreach, productionOutreachDeps } = await import("@/lib/promoted-outreach");
  const outreach = await generatePromotedOutreach(productionOutreachDeps(), lead.id).catch((err) => {
    console.error(`Outreach generation crashed for lead ${lead.id}:`, err);
    return { status: "failed" as const, httpStatus: 500, error: "Outreach generation failed." };
  });

  return NextResponse.json({
    lead: updated,
    outreach: outreach.status === "failed" ? { status: "failed", error: outreach.error } : { status: outreach.status },
  });
}
