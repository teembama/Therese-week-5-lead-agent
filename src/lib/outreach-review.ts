import type { FeedbackCheck, FeedbackContext } from "./feedback-validation";
import { MAX_FEEDBACK_LENGTH } from "./feedback-validation";
import { createPurposeToken, verifyPurposeToken } from "./promotion-validation";
import {
  MIGRATION_PENDING_MESSAGE,
  REGENERATION_LIMIT_MESSAGE,
  type RegenerationResult,
  type RejectedDraftRecord,
} from "./promoted-outreach";

// Outreach rejection (reviewer/admin) and regeneration (researcher/admin), kept separate from the
// routes so the rules can be tested without a server. Both texts are checked by Claude Haiku;
// the UI checks first (validate_only), asks for confirmation, then sends the short-lived token it
// received so the confirmed request needs no second model call.

export interface ReviewUser {
  id: string;
  username: string;
}

export interface ReviewDeps {
  getDraft(draftId: string): Promise<RejectedDraftRecord | null>;
  getLead(leadId: string): Promise<{ id: string; run_id: string; company_name: string; qualification_status: string } | null>;
  getObjective(runId: string): Promise<string>;
  hasRegeneration(leadId: string): Promise<boolean>;
  checkFeedback(ctx: FeedbackContext): Promise<FeedbackCheck>;
  // Sets status "rejected" only while the draft is still "draft"
  markRejected(draftId: string, reason: string, username: string): Promise<"updated" | "not_draft" | "migration">;
  regenerate(draftId: string, direction: string): Promise<RegenerationResult>;
  log(row: { run_id: string; tool_name: string; purpose: string; input_summary: string; result_summary: string; status: "success" }): Promise<void>;
  notify(event: { kind: "rejected" | "regenerated"; runId: string; companyName: string; by: string; text: string }): void;
}

export interface ReviewResult {
  httpStatus: number;
  body: Record<string, unknown>;
}

function readText(raw: unknown, label: string): { ok: true; text: string } | { ok: false; result: ReviewResult } {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, result: { httpStatus: 400, body: { error: `A ${label} is required.` } } };
  const text = raw.trim();
  if (text.length > MAX_FEEDBACK_LENGTH) {
    return { ok: false, result: { httpStatus: 400, body: { error: `Please keep the ${label} under ${MAX_FEEDBACK_LENGTH} characters.` } } };
  }
  return { ok: true, text };
}

function feedbackContext(kind: FeedbackContext["kind"], draft: RejectedDraftRecord, companyName: string, objective: string, text: string): FeedbackContext {
  return {
    kind,
    companyName,
    objective,
    drafts: [
      { subject: draft.email_1_subject, body: draft.email_1_body },
      { subject: draft.email_2_subject, body: draft.email_2_body },
      { subject: draft.email_3_subject, body: draft.email_3_body },
    ],
    linkedinMessage: draft.linkedin_message,
    rejectionReason: draft.rejection_reason,
    text,
  };
}

function rejected(check: Exclude<FeedbackCheck, { ok: true }>): ReviewResult {
  return { httpStatus: check.httpStatus, body: { error: check.error, ...(check.example ? { example: check.example } : {}) } };
}

export async function rejectOutreach(deps: ReviewDeps, draftId: string, user: ReviewUser, body: Record<string, unknown>): Promise<ReviewResult> {
  const input = readText(body.reason, "rejection reason");
  if (!input.ok) return input.result;
  const reason = input.text;

  const draft = await deps.getDraft(draftId);
  if (!draft) return { httpStatus: 404, body: { error: "Outreach draft not found." } };
  if (draft.status !== "draft") return { httpStatus: 409, body: { error: "Only draft outreach can be rejected." } };
  const lead = await deps.getLead(draft.lead_id);
  if (!lead) return { httpStatus: 404, body: { error: "Lead not found." } };

  const validateOnly = body.validate_only === true;
  if (validateOnly || !verifyPurposeToken(body.validation_token, "rejection-reason", draft.id, user.id, reason)) {
    const check = await deps.checkFeedback(feedbackContext("rejection", draft, lead.company_name, await deps.getObjective(lead.run_id), reason));
    if (!check.ok) return rejected(check);
  }
  if (validateOnly) {
    return { httpStatus: 200, body: { valid: true, validation_token: createPurposeToken("rejection-reason", draft.id, user.id, reason) } };
  }

  const result = await deps.markRejected(draft.id, reason, user.username);
  if (result === "migration") return { httpStatus: 503, body: { error: MIGRATION_PENDING_MESSAGE } };
  if (result === "not_draft") return { httpStatus: 409, body: { error: "This outreach was already approved or rejected." } };

  await deps
    .log({
      run_id: lead.run_id,
      tool_name: "manual_rejection",
      purpose: `Human reviewer rejected outreach for ${lead.company_name} (reviewer: ${user.username})`,
      input_summary: `Outreach ${draft.id} for lead ${lead.id}: draft → rejected`,
      result_summary: `Reason: ${reason}`.slice(0, 500),
      status: "success",
    })
    .catch((err) => console.error("Failed to log outreach rejection:", err));
  deps.notify({ kind: "rejected", runId: lead.run_id, companyName: lead.company_name, by: user.username, text: reason });
  return { httpStatus: 200, body: { status: "rejected" } };
}

export async function requestRegeneration(deps: ReviewDeps, draftId: string, user: ReviewUser, body: Record<string, unknown>): Promise<ReviewResult> {
  const input = readText(body.direction, "direction for regeneration");
  if (!input.ok) return input.result;
  const direction = input.text;

  const draft = await deps.getDraft(draftId);
  if (!draft) return { httpStatus: 404, body: { error: "Outreach draft not found." } };
  if (draft.status !== "rejected") return { httpStatus: 409, body: { error: "Only rejected outreach can be regenerated." } };
  const lead = await deps.getLead(draft.lead_id);
  if (!lead) return { httpStatus: 404, body: { error: "Lead not found." } };
  // Checked before the model is called, so a request past the limit costs nothing
  if (await deps.hasRegeneration(lead.id)) return { httpStatus: 409, body: { error: REGENERATION_LIMIT_MESSAGE, limit_reached: true } };

  const validateOnly = body.validate_only === true;
  if (validateOnly || !verifyPurposeToken(body.validation_token, "regeneration-direction", draft.id, user.id, direction)) {
    const check = await deps.checkFeedback(feedbackContext("direction", draft, lead.company_name, await deps.getObjective(lead.run_id), direction));
    if (!check.ok) return rejected(check);
  }
  if (validateOnly) {
    return {
      httpStatus: 200,
      body: { valid: true, validation_token: createPurposeToken("regeneration-direction", draft.id, user.id, direction) },
    };
  }

  const result = await deps.regenerate(draft.id, direction);
  if (result.status === "failed") return { httpStatus: result.httpStatus, body: { error: result.error } };
  deps.notify({ kind: "regenerated", runId: result.runId, companyName: result.companyName, by: user.username, text: direction });
  return { httpStatus: 200, body: { status: "generated", draft_id: result.draftId } };
}
