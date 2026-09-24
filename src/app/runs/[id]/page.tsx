"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

interface LeadSource {
  id: string;
  url: string;
  title: string;
  summary: string;
  relevant_evidence: string;
}

interface OutreachDraft {
  id: string;
  email_1_subject: string;
  email_1_body: string;
  email_1_personalization: string;
  email_2_subject: string;
  email_2_body: string;
  email_2_personalization: string;
  email_3_subject: string;
  email_3_body: string;
  email_3_personalization: string;
  linkedin_message: string;
  status: string;
}

interface Lead {
  id: string;
  company_name: string;
  company_domain: string;
  qualification_status: string;
  confidence: number;
  fit_reasons: string[];
  concerns: string[];
  source_urls: string[];
  source_summary: string;
  lead_sources: LeadSource[];
  outreach_drafts: OutreachDraft[];
}

interface ToolCall {
  id: string;
  tool_name: string;
  purpose: string;
  input_summary: string;
  result_summary: string;
  status: string;
  error_message: string | null;
  created_at: string;
  duration_ms: number | null;
}

interface RunData {
  run: {
    id: string;
    objective: string;
    refined_icp: Record<string, unknown> | null;
    status: string;
    error: string | null;
    created_at: string;
    actual_cost: number | null;
    lead_limit: number;
  };
  leads: Lead[];
  toolCalls: ToolCall[];
}

// --- Progress Steps ---
const STEPS = [
  { key: "refine", label: "Refine ICP" },
  { key: "discover", label: "Discover" },
  { key: "research", label: "Research" },
  { key: "outreach", label: "Outreach" },
];

function getStepStatus(
  toolCalls: ToolCall[],
  leads: Lead[],
  runStatus: string,
  hasIcp: boolean
) {
  const toolNames = toolCalls.map((tc) => tc.tool_name);
  const hasDiscovery = toolNames.includes("discover_companies");
  const hasScrape = toolNames.includes("scrape_company");
  const hasLeads = leads.length > 0;
  const hasOutreach = leads.some((l) => l.outreach_drafts?.length > 0);

  const completed: Record<string, boolean> = {
    refine: hasIcp,
    discover: hasDiscovery,
    research: hasScrape && hasLeads,
    outreach: runStatus === "completed" ? true : hasOutreach && runStatus !== "running",
  };

  // Figure out current status message
  let statusMessage = "";
  if (runStatus === "running") {
    if (!hasIcp) {
      statusMessage = "Analyzing your objective and building target criteria...";
    } else if (!hasDiscovery) {
      statusMessage = "Searching for matching companies...";
    } else if (!hasScrape) {
      statusMessage = "Scraping company websites for evidence...";
    } else if (!hasLeads) {
      statusMessage = "Evaluating companies against qualification criteria...";
    } else if (!hasOutreach) {
      const qualifiedCount = leads.filter((l) => l.qualification_status === "qualified").length;
      const outreachCount = leads.filter((l) => l.outreach_drafts?.length > 0).length;
      statusMessage = `Generating outreach ${outreachCount}/${qualifiedCount}...`;
    } else {
      statusMessage = "Running final quality checks...";
    }
  } else if (runStatus === "completed") {
    const qualifiedCount = leads.filter((l) => l.qualification_status === "qualified").length;
    statusMessage = `Complete — ${qualifiedCount} qualified lead${qualifiedCount !== 1 ? "s" : ""} found.`;
  } else if (runStatus === "failed") {
    statusMessage = "Run failed.";
  }

  return { completed, statusMessage };
}

function ProgressTracker({
  toolCalls,
  leads,
  runStatus,
  hasIcp,
}: {
  toolCalls: ToolCall[];
  leads: Lead[];
  runStatus: string;
  hasIcp: boolean;
}) {
  const { completed, statusMessage } = getStepStatus(toolCalls, leads, runStatus, hasIcp);

  const currentIndex = STEPS.findIndex((s) => !completed[s.key]);
  const activeIndex = currentIndex === -1 ? STEPS.length : currentIndex;

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between py-4">
        {STEPS.map((step, i) => {
          const done = completed[step.key];
          const active = i === activeIndex && runStatus === "running";
          const failed = runStatus === "failed" && i === activeIndex;

          return (
            <div key={step.key} className="flex items-center flex-1 last:flex-none">
              <div className="flex flex-col items-center">
                <div
                  className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold border-2 transition-all ${
                    done
                      ? "bg-green-500 border-green-500 text-white"
                      : failed
                      ? "bg-red-500 border-red-500 text-white"
                      : active
                      ? "border-blue-500 text-blue-500 animate-pulse"
                      : "border-gray-300 text-gray-400 dark:border-gray-600"
                  }`}
                >
                  {done ? "✓" : failed ? "✕" : i + 1}
                </div>
                <span
                  className={`text-xs mt-1.5 ${
                    done
                      ? "text-green-600 dark:text-green-400 font-medium"
                      : active
                      ? "text-blue-500 font-medium"
                      : "text-gray-400"
                  }`}
                >
                  {step.label}
                </span>
              </div>
              {i < STEPS.length - 1 && (
                <div
                  className={`flex-1 h-0.5 mx-2 mb-5 ${
                    done ? "bg-green-500" : "bg-gray-200 dark:bg-gray-700"
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>

      {statusMessage && (
        <p
          className={`text-sm text-center mt-1 ${
            runStatus === "failed"
              ? "text-red-500"
              : runStatus === "completed"
              ? "text-green-600 dark:text-green-400"
              : "text-gray-500 animate-pulse"
          }`}
        >
          {statusMessage}
        </p>
      )}
    </div>
  );
}

const TOOL_LABELS: Record<string, string> = {
  discover_companies: "Apify Search",
  scrape_company: "Firecrawl Scrape",
  save_lead: "Save Lead",
  update_run: "Update Run",
  log_tool_call: "Log",
  manual_review: "Human Review",
  manual_approval: "Human Approval",
};

// --- Research Criteria ---
// The agent's ICP keys vary between runs, so several aliases map to one label.
const ICP_FIELDS: { label: string; keys: string[] }[] = [
  { label: "Company Type", keys: ["company_type", "target_company_type"] },
  { label: "Industries", keys: ["industries", "industry"] },
  { label: "Geography", keys: ["geography", "location", "locations"] },
  { label: "Company Size", keys: ["company_size", "headcount_range", "employee_range", "size"] },
  { label: "Buyer Persona", keys: ["buyer_persona", "persona"] },
  { label: "Business Problem", keys: ["business_problem", "problem"] },
  { label: "Hard Filters", keys: ["hard_filters"] },
  { label: "Soft Preferences", keys: ["soft_preferences"] },
  { label: "Disqualifiers", keys: ["disqualifiers"] },
];

function formatIcpValue(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(formatIcpValue).filter(Boolean).join(", ");
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${humanizeKey(k)}: ${formatIcpValue(v)}`)
      .join("; ");
  }
  return String(value);
}

function humanizeKey(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function IcpDisplay({
  objective,
  icp,
}: {
  objective: string;
  icp: Record<string, unknown>;
}) {
  const [open, setOpen] = useState(false);

  const knownKeys = new Set(ICP_FIELDS.flatMap((f) => f.keys));
  const rows: { label: string; value: string }[] = [];
  for (const field of ICP_FIELDS) {
    const key = field.keys.find((k) => icp[k] != null);
    const value = key ? formatIcpValue(icp[key]) : "";
    if (value) rows.push({ label: field.label, value });
  }
  for (const [key, raw] of Object.entries(icp)) {
    if (knownKeys.has(key)) continue;
    const value = formatIcpValue(raw);
    if (value) rows.push({ label: humanizeKey(key), value });
  }

  return (
    <div className="mb-6 border rounded-lg">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 p-3 text-sm font-medium text-left hover:bg-gray-50 dark:hover:bg-gray-900"
      >
        <span className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
        Research Criteria
      </button>
      {open && (
        <div className="border-t p-4 text-sm space-y-5">
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">
              Your Objective
            </h3>
            <p className="text-gray-700 dark:text-gray-300">{objective}</p>
          </section>
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
              Refined ICP
            </h3>
            <div className="space-y-3">
              {rows.map((row) => (
                <div key={row.label}>
                  <p className="text-xs font-medium text-gray-500">{row.label}</p>
                  <p className="text-gray-700 dark:text-gray-300">{row.value}</p>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function PromoteLeadModal({
  lead,
  onClose,
  onPromoted,
}: {
  lead: Lead;
  onClose: () => void;
  onPromoted: () => void;
}) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!reason.trim()) {
      setError("Please explain why this lead should be qualified.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${lead.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qualification_status: "qualified", review_reason: reason.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error || "Failed to update lead. Please try again.");
        return;
      }
      onPromoted();
    } catch {
      setError("Failed to update lead. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-lg rounded-lg bg-white dark:bg-gray-900 border p-5 text-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold mb-1">Mark as Qualified</h2>
        <p className="text-xs text-gray-500 mb-4">
          {lead.company_name}
          {lead.company_domain && ` · ${lead.company_domain}`}
        </p>

        {lead.concerns.length > 0 && (
          <div className="mb-4">
            <p className="font-medium text-yellow-700 dark:text-yellow-400 mb-1">
              Agent&apos;s Concerns
            </p>
            <ul className="list-disc list-inside text-xs space-y-1">
              {lead.concerns.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </div>
        )}

        <label htmlFor="review-reason" className="block font-medium mb-1">
          Reason for qualifying <span className="text-red-500">*</span>
        </label>
        <textarea
          id="review-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={4}
          placeholder="Explain how the concerns above were addressed..."
          className="w-full rounded border p-2 text-sm bg-transparent"
          disabled={submitting}
        />
        <p className="text-xs text-gray-500 mt-1">
          Outreach is not generated automatically for promoted leads.
        </p>
        {error && <p className="text-xs text-red-500 mt-2">{error}</p>}

        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onClose}
            disabled={submitting}
            className="text-xs px-3 py-1.5 border rounded hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || !reason.trim()}
            className="text-xs px-3 py-1.5 rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
          >
            {submitting ? "Saving..." : "Mark as Qualified"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfirmModal({
  title,
  message,
  confirmLabel,
  cancelLabel,
  tone = "neutral",
  busy = false,
  error,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "red" | "green" | "neutral";
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const toneClass =
    tone === "red"
      ? "bg-red-600 hover:bg-red-700"
      : tone === "green"
      ? "bg-green-600 hover:bg-green-700"
      : "bg-blue-600 hover:bg-blue-700";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
      onClick={busy ? undefined : onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md rounded-lg bg-white dark:bg-gray-900 border p-5 text-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold mb-2">{title}</h2>
        <p className="text-gray-600 dark:text-gray-400">{message}</p>
        {error && <p className="text-xs text-red-500 mt-3">{error}</p>}
        <div className="flex justify-end gap-2 mt-5">
          {cancelLabel && (
            <button
              onClick={onClose}
              disabled={busy}
              className="text-xs px-3 py-1.5 border rounded hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
            >
              {cancelLabel}
            </button>
          )}
          <button
            onClick={onConfirm}
            disabled={busy}
            className={`text-xs px-3 py-1.5 rounded text-white disabled:opacity-50 ${toneClass}`}
          >
            {busy ? "Working..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function RunPage() {
  const params = useParams();
  const [data, setData] = useState<RunData | null>(null);
  const [expandedLead, setExpandedLead] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [activeTab, setActiveTab] = useState<"leads" | "tools">("leads");
  const [promotingLead, setPromotingLead] = useState<Lead | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [promotedNotice, setPromotedNotice] = useState(false);
  const [approving, setApproving] = useState<{ lead: Lead; draft: OutreachDraft } | null>(null);
  const [approveBusy, setApproveBusy] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/auth/session")
      .then((r) => (r.ok ? r.json() : null))
      .then((session) => setRole(session?.user?.role ?? null))
      .catch(console.error);
  }, []);

  const isReviewer = role === "reviewer" || role === "admin";

  const fetchData = useCallback(() => {
    if (!params.id) return;
    fetch(`/api/runs/${params.id}`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then(setData)
      .catch(console.error);
  }, [params.id]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Poll while running
  useEffect(() => {
    if (!data || data.run.status !== "running") return;
    const interval = setInterval(fetchData, 3000);
    return () => clearInterval(interval);
  }, [data?.run?.status, fetchData]);

  const handleCancel = async () => {
    if (!params.id || cancelling) return;
    setCancelling(true);
    try {
      await fetch(`/api/runs/${params.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "failed", error: "Cancelled by user" }),
      });
      fetchData();
    } catch {
      console.error("Failed to cancel");
    } finally {
      setCancelling(false);
      setConfirmingCancel(false);
    }
  };

  const handleApprove = async () => {
    if (!approving || approveBusy) return;
    setApproveBusy(true);
    setApproveError(null);
    try {
      const res = await fetch(`/api/outreach/${approving.draft.id}`, { method: "PATCH" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setApproveError(json.error || "Failed to approve outreach. Please try again.");
        return;
      }
      setApproving(null);
      fetchData();
    } catch {
      setApproveError("Failed to approve outreach. Please try again.");
    } finally {
      setApproveBusy(false);
    }
  };

  if (!data) {
    return (
      <main className="max-w-4xl mx-auto px-6 py-12">
        <p className="text-gray-500">Loading...</p>
      </main>
    );
  }

  const { run, leads, toolCalls } = data;

  // Filter leads: only show qualified + needs_review (if qualified count < target)
  const qualified = leads.filter((l) => l.qualification_status === "qualified");
  const needsReview = leads.filter((l) => l.qualification_status === "needs_review");
  const showNeedsReview = qualified.length < (run.lead_limit || 10);
  const visibleLeads = showNeedsReview
    ? [...qualified, ...needsReview]
    : qualified;

  return (
    <main className="max-w-4xl mx-auto px-6 py-12">
      <Link href="/" className="text-sm text-blue-600 hover:underline">
        ← Back
      </Link>

      <div className="mt-4 mb-6">
        <div className="flex items-center gap-3 mb-2">
          <h1 className="text-xl font-bold">Run Details</h1>
          <span
            className={`text-xs px-2 py-1 rounded-full ${
              run.status === "completed"
                ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
                : run.status === "failed"
                ? "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400"
                : "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400"
            }`}
          >
            {run.status}
          </span>
          {run.status === "running" && role && (
            <button
              onClick={() => setConfirmingCancel(true)}
              disabled={cancelling}
              className="ml-auto text-xs px-3 py-1 border border-red-300 text-red-600 rounded hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20 disabled:opacity-50"
            >
              {cancelling ? "Cancelling..." : "Cancel Run"}
            </button>
          )}
        </div>
        <p className="text-sm text-gray-700 dark:text-gray-300">{run.objective}</p>
        <p className="text-xs text-gray-500 mt-1">
          {new Date(run.created_at).toLocaleString()}
          {run.actual_cost != null && run.actual_cost > 0 && ` · $${run.actual_cost.toFixed(4)}`}
        </p>
        {run.error && (
          <div className="text-sm text-red-400 mt-2 bg-red-950/20 border border-red-800/30 p-3 rounded-lg">
            {run.error}
          </div>
        )}
      </div>

      <ProgressTracker
        toolCalls={toolCalls}
        leads={leads}
        runStatus={run.status}
        hasIcp={!!run.refined_icp}
      />

      {run.refined_icp && <IcpDisplay objective={run.objective} icp={run.refined_icp} />}
      <div className="flex gap-4 border-b mb-4">
        <button
          onClick={() => setActiveTab("leads")}
          className={`pb-2 text-sm font-medium ${
            activeTab === "leads"
              ? "border-b-2 border-blue-600 text-blue-600"
              : "text-gray-500 hover:text-gray-700"
          }`}
        >
          Leads ({qualified.length} qualified
          {showNeedsReview && needsReview.length > 0
            ? `, ${needsReview.length} review`
            : ""}
          )
        </button>
        <button
          onClick={() => setActiveTab("tools")}
          className={`pb-2 text-sm font-medium ${
            activeTab === "tools"
              ? "border-b-2 border-blue-600 text-blue-600"
              : "text-gray-500 hover:text-gray-700"
          }`}
        >
          Tool Calls ({toolCalls.length})
        </button>
      </div>

      {activeTab === "leads" && (
        <section className="mb-8">
          <div className="space-y-2">
            {visibleLeads.map((lead) => (
              <div key={lead.id} className="border rounded-lg overflow-hidden">
                <button
                  onClick={() =>
                    setExpandedLead(expandedLead === lead.id ? null : lead.id)
                  }
                  className="w-full text-left p-4 hover:bg-gray-50 dark:hover:bg-gray-900 transition-colors"
                >
                  <div className="flex justify-between items-center">
                    <div>
                      <span className="font-medium text-sm">{lead.company_name}</span>
                      {lead.company_domain && (
                        <span className="text-xs text-gray-500 ml-2">
                          {lead.company_domain}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-500">
                        {(lead.confidence * 100).toFixed(0)}%
                      </span>
                      <span
                        className={`text-xs px-2 py-1 rounded-full ${
                          lead.qualification_status === "qualified"
                            ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
                            : "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400"
                        }`}
                      >
                        {lead.qualification_status === "qualified" ? "qualified" : "needs review"}
                      </span>
                    </div>
                  </div>
                </button>

                {lead.qualification_status === "needs_review" &&
                  isReviewer &&
                  run.status !== "running" && (
                  <div className="px-4 pb-3 -mt-1 flex justify-end">
                    <button
                      onClick={() => setPromotingLead(lead)}
                      className="text-xs px-3 py-1 border border-green-300 text-green-700 rounded hover:bg-green-50 dark:border-green-800 dark:text-green-400 dark:hover:bg-green-900/20"
                    >
                      Mark as Qualified
                    </button>
                  </div>
                )}

                {expandedLead === lead.id && (
                  <div className="border-t p-4 bg-gray-50 dark:bg-gray-900/50 text-sm space-y-4">
                    {lead.qualification_status === "qualified" &&
                      !lead.outreach_drafts?.[0] &&
                      run.status !== "running" && (
                        <p className="text-xs text-gray-500 italic">Outreach pending.</p>
                      )}
                    {lead.fit_reasons.length > 0 && (
                      <div>
                        <p className="font-medium text-green-700 dark:text-green-400 mb-1">
                          Fit Reasons
                        </p>
                        <ul className="list-disc list-inside text-xs space-y-1">
                          {lead.fit_reasons.map((r, i) => (
                            <li key={i}>{r}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {lead.concerns.length > 0 && (
                      <div>
                        <p className="font-medium text-yellow-700 dark:text-yellow-400 mb-1">
                          Concerns
                        </p>
                        <ul className="list-disc list-inside text-xs space-y-1">
                          {lead.concerns.map((c, i) => (
                            <li key={i}>{c}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {lead.source_summary && (
                      <div>
                        <p className="font-medium mb-1">Source Summary</p>
                        <p className="text-xs text-gray-700 dark:text-gray-300">
                          {lead.source_summary}
                        </p>
                      </div>
                    )}
                    {lead.outreach_drafts?.[0] && (
                      <div>
                        <div className="flex items-center gap-2 mb-2">
                          <p className="font-medium">Outreach Drafts</p>
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full ${
                              lead.outreach_drafts[0].status === "approved"
                                ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
                                : "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300"
                            }`}
                          >
                            {lead.outreach_drafts[0].status || "draft"}
                          </span>
                          {isReviewer &&
                            lead.qualification_status === "qualified" &&
                            lead.outreach_drafts[0].status === "draft" && (
                              <button
                                onClick={() => {
                                  setApproveError(null);
                                  setApproving({ lead, draft: lead.outreach_drafts[0] });
                                }}
                                className="ml-auto text-xs px-3 py-1 border border-green-300 text-green-700 rounded hover:bg-green-50 dark:border-green-800 dark:text-green-400 dark:hover:bg-green-900/20"
                              >
                                Approve
                              </button>
                            )}
                        </div>
                        {[1, 2, 3].map((n) => {
                          const draft = lead.outreach_drafts[0];
                          const subject = draft[
                            `email_${n}_subject` as keyof OutreachDraft
                          ] as string;
                          const body = draft[
                            `email_${n}_body` as keyof OutreachDraft
                          ] as string;
                          const personalization = draft[
                            `email_${n}_personalization` as keyof OutreachDraft
                          ] as string;
                          if (!subject) return null;
                          return (
                            <div
                              key={n}
                              className="mb-3 bg-white dark:bg-gray-800 p-3 rounded border"
                            >
                              <p className="text-xs font-medium">
                                Email {n}: {subject}
                              </p>
                              <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 whitespace-pre-wrap">
                                {body}
                              </p>
                              {personalization && (
                                <p className="text-xs text-blue-600 dark:text-blue-400 mt-1 italic">
                                  Personalization: {personalization}
                                </p>
                              )}
                            </div>
                          );
                        })}
                        {lead.outreach_drafts[0].linkedin_message && (
                          <div className="bg-white dark:bg-gray-800 p-3 rounded border">
                            <p className="text-xs font-medium">LinkedIn Message</p>
                            <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                              {lead.outreach_drafts[0].linkedin_message}
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
            {visibleLeads.length === 0 && run.status === "running" && (
              <p className="text-sm text-gray-500">
                Waiting for the agent to qualify leads...
              </p>
            )}
            {visibleLeads.length === 0 && run.status !== "running" && (
              <p className="text-sm text-gray-500">No leads found.</p>
            )}
          </div>
        </section>
      )}

      {activeTab === "tools" && (
        <section>
          <div className="space-y-1">
            {toolCalls.map((tc) => (
              <div
                key={tc.id}
                className={`flex items-start gap-3 p-2 rounded text-xs ${
                  tc.status === "error" ? "bg-red-50 dark:bg-red-900/10" : ""
                }`}
              >
                <span
                  className={`mt-0.5 w-2 h-2 rounded-full shrink-0 ${
                    tc.status === "success" ? "bg-green-500" : "bg-red-500"
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <span className="font-medium" title={tc.tool_name}>
                    {TOOL_LABELS[tc.tool_name] ?? tc.tool_name}
                  </span>
                  {tc.purpose && (
                    <span className="text-gray-500 ml-2">{tc.purpose}</span>
                  )}
                  {tc.error_message && (
                    <p className="text-red-600 mt-0.5">{tc.error_message}</p>
                  )}
                </div>
                <span className="text-gray-400 shrink-0">
                  {new Date(tc.created_at).toLocaleTimeString()}
                </span>
              </div>
            ))}
            {toolCalls.length === 0 && run.status === "running" && (
              <p className="text-sm text-gray-500">Waiting for tool calls...</p>
            )}
            {toolCalls.length === 0 && run.status !== "running" && (
              <p className="text-sm text-gray-500">No tool calls recorded.</p>
            )}
          </div>
        </section>
      )}

      {promotingLead && (
        <PromoteLeadModal
          lead={promotingLead}
          onClose={() => setPromotingLead(null)}
          onPromoted={() => {
            setPromotingLead(null);
            fetchData();
            setPromotedNotice(true);
          }}
        />
      )}

      {confirmingCancel && (
        <ConfirmModal
          title="Cancel this run?"
          message="Are you sure you want to cancel this run? Any leads already found will be saved, but the research will stop."
          cancelLabel="Keep Running"
          confirmLabel="Cancel Run"
          tone="red"
          busy={cancelling}
          onConfirm={handleCancel}
          onClose={() => setConfirmingCancel(false)}
        />
      )}

      {promotedNotice && (
        <ConfirmModal
          title="Lead promoted"
          message="Lead promoted to qualified. This action has been logged."
          confirmLabel="OK"
          onConfirm={() => setPromotedNotice(false)}
          onClose={() => setPromotedNotice(false)}
        />
      )}

      {approving && (
        <ConfirmModal
          title="Approve outreach"
          message={`Approve this outreach for ${approving.lead.company_name}? Approved outreach is ready for external use.`}
          cancelLabel="Cancel"
          confirmLabel="Approve Outreach"
          tone="green"
          busy={approveBusy}
          error={approveError}
          onConfirm={handleApprove}
          onClose={() => setApproving(null)}
        />
      )}
    </main>
  );
}
