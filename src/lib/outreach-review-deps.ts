import { after } from "next/server";
import { supabase } from "./supabase";
import { callHaiku, validateFeedback } from "./feedback-validation";
import { notifyOutreachReview } from "./discord";
import { isMissingColumn, productionRegenerationDeps, regenerateOutreach } from "./promoted-outreach";
import type { ReviewDeps } from "./outreach-review";

// Supabase/Claude/Discord implementations of ReviewDeps for the outreach review routes
export function productionReviewDeps(requestOrigin: string): ReviewDeps {
  const regen = productionRegenerationDeps();
  return {
    getDraft: regen.getDraft,
    hasRegeneration: regen.hasRegeneration,
    async getLead(leadId) {
      const { data } = await supabase.from("leads").select("id, run_id, company_name, qualification_status").eq("id", leadId).maybeSingle();
      return data ?? null;
    },
    async getObjective(runId) {
      const { data } = await supabase.from("lead_runs").select("objective").eq("id", runId).maybeSingle();
      return (data?.objective as string | undefined) ?? "";
    },
    checkFeedback: (ctx) => validateFeedback(ctx, callHaiku),
    async markRejected(draftId, reason, username) {
      const { data, error } = await supabase
        .from("outreach_drafts")
        .update({ status: "rejected", rejection_reason: reason, rejected_by: username, rejected_at: new Date().toISOString() })
        .eq("id", draftId)
        .eq("status", "draft") // an approval or rejection that landed first wins
        .select("id");
      // Missing columns, or a status check that does not allow "rejected" yet
      if (isMissingColumn(error) || error?.code === "23514") return "migration";
      if (error) throw new Error(error.message);
      return data && data.length > 0 ? "updated" : "not_draft";
    },
    regenerate: (draftId, direction) => regenerateOutreach(regen, draftId, direction),
    async log(row) {
      const { error } = await supabase.from("agent_tool_calls").insert(row);
      if (error) throw new Error(error.message);
    },
    // Sent after the response, so Discord never delays or breaks the action
    notify(event) {
      after(() => notifyOutreachReview({ ...event, requestOrigin }));
    },
  };
}
