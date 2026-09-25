"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Alert, Badge, Button, Card, ExternalLink, Label, Modal } from "@/components/ui";
import { buildSamplePack, formatRange, icpRows, samplePackFilename } from "@/lib/sample-pack";

interface LeadSource {
  id: string;
  url: string;
  title: string | null;
  summary: string | null;
  relevant_evidence: string | null;
  source_type?: string | null;
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

interface SearchTerm {
  term: string;
  reason: string;
  type?: string;
}

interface SearchPlan {
  filters?: {
    location?: string;
    employee_range?: { min?: number; max?: number };
    company_sizes?: string[];
    industries?: string[];
  };
  names_company_type?: boolean;
  search_terms?: SearchTerm[];
}

interface RunData {
  run: {
    id: string;
    objective: string;
    refined_icp: (Record<string, unknown> & { search_plan?: SearchPlan }) | null;
    status: string;
    error: string | null;
    created_at: string;
    actual_cost: number | null;
    lead_limit: number;
    user_id: string | null;
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

function getStepStatus(toolCalls: ToolCall[], leads: Lead[], runStatus: string, hasIcp: boolean) {
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
      statusMessage = "Analyzing your objective and building target criteria…";
    } else if (!hasDiscovery) {
      statusMessage = "Searching for matching companies…";
    } else if (!hasScrape) {
      statusMessage = "Reading company websites for evidence…";
    } else if (!hasLeads) {
      statusMessage = "Evaluating companies against your criteria…";
    } else if (!hasOutreach) {
      const qualifiedCount = leads.filter((l) => l.qualification_status === "qualified").length;
      const outreachCount = leads.filter((l) => l.outreach_drafts?.length > 0).length;
      statusMessage =
        qualifiedCount === 0 ? "Evaluating companies…" : `Drafting outreach ${outreachCount}/${qualifiedCount}…`;
    } else {
      statusMessage = "Running final quality checks…";
    }
  } else if (runStatus === "completed") {
    const qualifiedCount = leads.filter((l) => l.qualification_status === "qualified").length;
    statusMessage = `Complete — ${qualifiedCount} qualified lead${qualifiedCount !== 1 ? "s" : ""} found.`;
  } else if (runStatus === "failed") {
    statusMessage = "Run failed.";
  } else if (runStatus === "cancelled") {
    statusMessage = "Run cancelled.";
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
    <div className="mt-10">
      <ol className="flex items-start">
        {STEPS.map((step, i) => {
          const done = completed[step.key];
          const active = i === activeIndex && runStatus === "running";
          const failed = runStatus === "failed" && i === activeIndex;
          const stoppedHere = runStatus === "cancelled" && i === activeIndex;
          const state = done ? "done" : failed ? "failed" : stoppedHere ? "cancelled" : active ? "in progress" : "pending";

          return (
            <li key={step.key} className="flex flex-1 items-start last:flex-none">
              <div className="flex flex-col items-center" aria-label={`${step.label}: ${state}`}>
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold transition-colors ${
                    done
                      ? "bg-rose text-white"
                      : failed
                        ? "bg-danger text-canvas"
                        : stoppedHere
                          ? "bg-neutral text-canvas"
                          : active
                            ? "border border-rose bg-surface text-rose-deep koya-pulse"
                            : "border border-line-strong bg-surface text-muted"
                  }`}
                >
                  {done ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : failed ? (
                    "✕"
                  ) : stoppedHere ? (
                    <span className="h-2 w-2 rounded-[2px] bg-canvas" aria-hidden="true" />
                  ) : (
                    i + 1
                  )}
                </div>
                <span className={`mt-2 text-xs ${done || active ? "font-medium text-ink" : "text-muted"}`}>{step.label}</span>
              </div>
              {i < STEPS.length - 1 && (
                <div className={`mx-2 mt-4 h-px flex-1 ${done ? "bg-rose" : "bg-line-strong"}`} aria-hidden="true" />
              )}
            </li>
          );
        })}
      </ol>
      {statusMessage && (
        <p
          role="status"
          aria-live="polite"
          className={`mt-5 text-sm ${
            runStatus === "failed" ? "text-danger" : runStatus === "completed" ? "text-success" : "text-muted"
          }`}
        >
          {statusMessage}
        </p>
      )}
    </div>
  );
}

const TOOL_LABELS: Record<string, string> = {
  discover_companies: "LinkedIn search",
  scrape_company: "Website research",
  save_lead: "Save lead",
  update_run: "Update run",
  log_tool_call: "Log",
  agent_note: "Agent note",
  manual_review: "Human review",
  manual_approval: "Human approval",
  manual_cancel: "Cancelled",
};

const APP_LOGGED_TOOLS = new Set(["update_run", "discover_companies", "scrape_company", "save_lead"]);

// --- Research Criteria ---
// ICP labels and formatting are shared with the sample-pack export (src/lib/sample-pack.ts)

function SearchPlanView({ plan }: { plan: SearchPlan }) {
  const f = plan.filters ?? {};
  const filters: { label: string; value: string }[] = [
    { label: "Location", value: f.location ?? "" },
    { label: "Employee range", value: formatRange(f.employee_range) },
    { label: "LinkedIn size bands", value: (f.company_sizes ?? []).join(", ") },
    { label: "Industries", value: (f.industries ?? []).join(", ") },
  ].filter((x) => x.value);

  return (
    <section>
      <Label>Search plan</Label>
      {filters.length > 0 && (
        <dl className="mt-3 grid gap-x-8 gap-y-3 sm:grid-cols-2">
          {filters.map((x) => (
            <div key={x.label}>
              <dt className="text-xs text-muted">{x.label}</dt>
              <dd className="text-sm">{x.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {(plan.search_terms ?? []).length > 0 && (
        <ul className="mt-5 space-y-3">
          {(plan.search_terms ?? []).map((t) => (
            <li key={t.term} className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
              <span className="inline-flex w-fit shrink-0 items-center gap-2 rounded-full border border-rose/30 bg-rose-soft px-3 py-0.5 text-sm font-medium text-rose-deep">
                {t.term}
                {t.type && <span className="text-[11px] font-normal uppercase tracking-wide text-rose-deep/70">{t.type}</span>}
              </span>
              <span className="text-sm leading-relaxed text-muted">{t.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function IcpDisplay({ objective, icp }: { objective: string; icp: Record<string, unknown> & { search_plan?: SearchPlan } }) {
  const [open, setOpen] = useState(false);
  const rows = icpRows(icp);

  return (
    <Card className="mt-10">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="research-criteria"
        className="flex w-full items-center justify-between px-6 py-4 text-left"
      >
        <span className="text-sm font-semibold">Research criteria</span>
        <span className="text-xs text-muted">{open ? "Hide" : "Show objective, ICP and search plan"}</span>
      </button>
      {open && (
        <div id="research-criteria" className="space-y-8 border-t border-line px-6 py-6">
          <section>
            <Label>Your objective</Label>
            <p className="mt-2 text-sm leading-relaxed">{objective}</p>
          </section>
          {rows.length > 0 && (
            <section>
              <Label>Refined ICP</Label>
              <dl className="mt-3 grid gap-x-8 gap-y-4 sm:grid-cols-2">
                {rows.map((row) => (
                  <div key={row.label}>
                    <dt className="text-xs text-muted">{row.label}</dt>
                    <dd className="text-sm leading-relaxed">{row.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
          {icp.search_plan && <SearchPlanView plan={icp.search_plan} />}
        </div>
      )}
    </Card>
  );
}

function BulletList({ items, tone }: { items: string[]; tone: "fit" | "concern" }) {
  return (
    <ul className="mt-2 space-y-1.5">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2.5 text-sm leading-relaxed">
          <span
            className={`mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full ${tone === "fit" ? "bg-success" : "bg-warning"}`}
            aria-hidden="true"
          />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function Evidence({ lead }: { lead: Lead }) {
  const recorded = new Set((lead.lead_sources ?? []).map((s) => s.url));
  const otherUrls = (lead.source_urls ?? []).filter((u) => !recorded.has(u));
  if ((lead.lead_sources ?? []).length === 0 && otherUrls.length === 0) return null;

  return (
    <section>
      <Label>Source evidence</Label>
      <ul className="mt-3 space-y-3">
        {(lead.lead_sources ?? []).map((s) => (
          <li key={s.id} className="rounded-lg border border-line bg-canvas px-4 py-3">
            {s.title && <p className="text-sm font-medium">{s.title}</p>}
            <p className="text-xs">
              <ExternalLink url={s.url} />
            </p>
            {(s.relevant_evidence || s.summary) && (
              <p className="mt-2 text-sm leading-relaxed text-muted">{s.relevant_evidence || s.summary}</p>
            )}
          </li>
        ))}
        {otherUrls.map((u) => (
          <li key={u} className="text-xs">
            <ExternalLink url={u} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function OutreachView({
  draft,
  canApprove,
  onApprove,
}: {
  draft: OutreachDraft;
  canApprove: boolean;
  onApprove: () => void;
}) {
  return (
    <section>
      <div className="flex items-center gap-3">
        <Label>Outreach drafts</Label>
        <Badge status={draft.status || "draft"} />
        {canApprove && (
          <Button size="sm" variant="success" className="ml-auto" onClick={onApprove}>
            Approve
          </Button>
        )}
      </div>
      <div className="mt-3 space-y-3">
        {[1, 2, 3].map((n) => {
          const subject = draft[`email_${n}_subject` as keyof OutreachDraft] as string;
          const body = draft[`email_${n}_body` as keyof OutreachDraft] as string;
          const personalization = draft[`email_${n}_personalization` as keyof OutreachDraft] as string;
          if (!subject) return null;
          return (
            <div key={n} className="rounded-lg border border-line bg-surface px-4 py-3">
              <p className="text-xs text-muted">Email {n}</p>
              <p className="mt-0.5 text-sm font-medium">{subject}</p>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink/85">{body}</p>
              {personalization && (
                <p className="mt-2 border-l-2 border-rose/50 pl-3 text-xs italic text-muted">Personalization: {personalization}</p>
              )}
            </div>
          );
        })}
        {draft.linkedin_message && (
          <div className="rounded-lg border border-line bg-surface px-4 py-3">
            <p className="text-xs text-muted">LinkedIn message</p>
            <p className="mt-1 text-sm leading-relaxed text-ink/85">{draft.linkedin_message}</p>
          </div>
        )}
      </div>
    </section>
  );
}

function LeadCard({
  lead,
  runStatus,
  isReviewer,
  expanded,
  onToggle,
  onPromote,
  onApprove,
}: {
  lead: Lead;
  runStatus: string;
  isReviewer: boolean;
  expanded: boolean;
  onToggle: () => void;
  onPromote: () => void;
  onApprove: (draft: OutreachDraft) => void;
}) {
  const draft = lead.outreach_drafts?.[0];
  const panelId = `lead-${lead.id}`;
  return (
    <Card className="overflow-hidden">
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={panelId}
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-canvas"
      >
        <div className="min-w-0">
          <p className="truncate text-[15px] font-medium">{lead.company_name}</p>
          {lead.company_domain && <p className="truncate text-xs text-muted">{lead.company_domain}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="text-xs tabular-nums text-muted" title="Confidence">
            {(lead.confidence * 100).toFixed(0)}%
          </span>
          <Badge status={lead.qualification_status} />
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className={`text-muted transition-transform ${expanded ? "rotate-180" : ""}`}
            aria-hidden="true"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </button>

      {lead.qualification_status === "needs_review" && isReviewer && runStatus !== "running" && (
        <div className="-mt-1 flex justify-end px-5 pb-3">
          <Button size="sm" variant="success" onClick={onPromote}>
            Mark as qualified
          </Button>
        </div>
      )}

      {expanded && (
        <div id={panelId} className="space-y-7 border-t border-line px-5 py-6">
          {lead.qualification_status === "qualified" && !draft && runStatus !== "running" && (
            <p className="text-sm italic text-muted">Outreach pending.</p>
          )}
          {lead.fit_reasons.length > 0 && (
            <section>
              <Label>Why it fits</Label>
              <BulletList items={lead.fit_reasons} tone="fit" />
            </section>
          )}
          {lead.concerns.length > 0 && (
            <section>
              <Label>Concerns</Label>
              <BulletList items={lead.concerns} tone="concern" />
            </section>
          )}
          {lead.source_summary && (
            <section>
              <Label>Source summary</Label>
              <p className="mt-2 text-sm leading-relaxed">{lead.source_summary}</p>
            </section>
          )}
          <Evidence lead={lead} />
          {draft && (
            <OutreachView
              draft={draft}
              canApprove={isReviewer && lead.qualification_status === "qualified" && draft.status === "draft"}
              onApprove={() => onApprove(draft)}
            />
          )}
        </div>
      )}
    </Card>
  );
}

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function ToolCallList({ toolCalls, runStatus }: { toolCalls: ToolCall[]; runStatus: string }) {
  if (toolCalls.length === 0) {
    return (
      <p className="text-sm text-muted">{runStatus === "running" ? "Waiting for the first tool call…" : "No tool calls recorded."}</p>
    );
  }
  return (
    <ol className="relative space-y-1 border-l border-line pl-6">
      {toolCalls.map((tc) => {
        const matches = tc.result_summary?.match(/linkedin_total_matches=(\d+)/)?.[1];
        const isNote = tc.tool_name === "agent_note";
        return (
          <li key={tc.id} className="relative py-3">
            <span
              className={`absolute -left-[29px] top-[18px] h-2.5 w-2.5 rounded-full ring-4 ring-canvas ${
                tc.status === "success" ? (isNote ? "bg-line-strong" : "bg-rose") : "bg-danger"
              }`}
              aria-hidden="true"
            />
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-sm font-medium" title={tc.tool_name}>
                {TOOL_LABELS[tc.tool_name] ?? tc.tool_name}
              </span>
              {tc.status !== "success" && <span className="text-xs font-medium text-danger">error</span>}
              {matches && (
                <span className="rounded-full bg-rose-soft px-2 py-0.5 text-xs text-rose-deep">
                  {Number(matches).toLocaleString()} LinkedIn matches
                </span>
              )}
              <span className="ml-auto text-xs tabular-nums text-muted">
                {new Date(tc.created_at).toLocaleTimeString()}
                {tc.duration_ms != null && ` · ${(tc.duration_ms / 1000).toFixed(1)}s`}
              </span>
            </div>
            {/* Application-logged tools carry a fixed purpose that only repeats the label above;
                human actions (review, approval, cancel) carry real detail, e.g. who acted */}
            {tc.purpose && !isNote && !APP_LOGGED_TOOLS.has(tc.tool_name) && (
              <p className="mt-0.5 text-xs text-muted">{tc.purpose}</p>
            )}
            {isNote && tc.purpose && <p className="mt-0.5 text-xs text-muted">About: {tc.purpose}</p>}
            {tc.input_summary && (
              <p className="mt-1.5 break-words text-xs leading-relaxed text-ink/80">
                <span className="text-muted">In: </span>
                {truncate(tc.input_summary)}
              </p>
            )}
            {tc.result_summary && (
              <p className="mt-0.5 break-words text-xs leading-relaxed text-ink/80">
                <span className="text-muted">{isNote ? "Note: " : "Out: "}</span>
                {truncate(tc.result_summary)}
              </p>
            )}
            {tc.error_message && <p className="mt-1 break-words text-xs text-danger">{truncate(tc.error_message)}</p>}
          </li>
        );
      })}
    </ol>
  );
}

function PromoteLeadModal({ lead, onClose, onPromoted }: { lead: Lead; onClose: () => void; onPromoted: () => void }) {
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
    <Modal title="Mark as qualified" onClose={onClose} busy={submitting}>
      <p className="text-sm text-muted">
        {lead.company_name}
        {lead.company_domain && ` · ${lead.company_domain}`}
      </p>

      {lead.concerns.length > 0 && (
        <div className="mt-5">
          <Label>The agent&apos;s concerns</Label>
          <BulletList items={lead.concerns} tone="concern" />
        </div>
      )}

      <label htmlFor="review-reason" className="mt-5 block text-sm font-medium">
        Reason for qualifying <span className="text-danger">*</span>
      </label>
      <textarea
        id="review-reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={4}
        placeholder="Explain how the concerns above were addressed…"
        className="mt-1.5 w-full rounded-lg border border-line-strong bg-surface p-3 text-sm focus:border-rose focus:outline-none focus:ring-2 focus:ring-rose/20"
        disabled={submitting}
      />
      <p className="mt-1.5 text-xs text-muted">Outreach is not generated automatically for promoted leads.</p>
      {error && (
        <Alert tone="danger" className="mt-3">
          {error}
        </Alert>
      )}

      <div className="mt-6 flex justify-end gap-2">
        <Button size="sm" variant="secondary" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" onClick={handleSubmit} disabled={submitting || !reason.trim()}>
          {submitting ? "Saving…" : "Mark as qualified"}
        </Button>
      </div>
    </Modal>
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
  const variant = tone === "red" ? "danger" : tone === "green" ? "success" : "primary";
  return (
    <Modal title={title} onClose={onClose} busy={busy}>
      <p className="text-sm leading-relaxed text-muted">{message}</p>
      {error && (
        <Alert tone="danger" className="mt-4">
          {error}
        </Alert>
      )}
      <div className="mt-6 flex justify-end gap-2">
        {cancelLabel && (
          <Button size="sm" variant="secondary" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </Button>
        )}
        <Button size="sm" variant={variant} onClick={onConfirm} disabled={busy}>
          {busy ? "Working…" : confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

export default function RunPage() {
  const params = useParams();
  const [data, setData] = useState<RunData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedLead, setExpandedLead] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [activeTab, setActiveTab] = useState<"leads" | "tools">("leads");
  const [promotingLead, setPromotingLead] = useState<Lead | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [promotedNotice, setPromotedNotice] = useState(false);
  const [approving, setApproving] = useState<{ lead: Lead; draft: OutreachDraft } | null>(null);
  const [approveBusy, setApproveBusy] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/auth/session")
      .then((r) => (r.ok ? r.json() : null))
      .then((session) => {
        setRole(session?.user?.role ?? null);
        setUserId(session?.user?.id ?? null);
      })
      .catch(console.error);
  }, []);

  const isReviewer = role === "reviewer" || role === "admin";
  // Mirrors the server rule: only the person who started the run, or an admin, can cancel it
  const canCancel = !!data && (role === "admin" || (!!userId && data.run.user_id === userId));

  const fetchData = useCallback(() => {
    if (!params.id) return;
    fetch(`/api/runs/${params.id}`)
      .then((r) => {
        if (!r.ok) throw new Error(r.status === 404 ? "This run could not be found." : "This run could not be loaded.");
        return r.json();
      })
      .then((json) => {
        setData(json);
        setLoadError(null);
      })
      .catch((err) => {
        console.error(err);
        setLoadError(err instanceof Error ? err.message : "This run could not be loaded.");
      });
  }, [params.id]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Poll while running
  useEffect(() => {
    if (!data || data.run.status !== "running") return;
    const interval = setInterval(fetchData, 3000);
    return () => clearInterval(interval);
  }, [data?.run?.status, fetchData]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCancel = async () => {
    if (!params.id || cancelling) return;
    setCancelling(true);
    setCancelError(null);
    try {
      const res = await fetch(`/api/runs/${params.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "cancelled" }),
      });
      const json = await res.json().catch(() => ({}));
      fetchData();
      if (!res.ok) {
        // e.g. the run finished before the cancel reached it
        setCancelError(json.error || "Could not cancel the run. Please try again.");
        return;
      }
      setConfirmingCancel(false);
    } catch {
      setCancelError("Could not cancel the run. Check your connection and try again.");
    } finally {
      setCancelling(false);
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
      <main className="mx-auto max-w-5xl px-6 py-14">
        <Link href="/" className="text-sm font-medium text-rose-deep hover:text-rose-deeper">
          ← All runs
        </Link>
        {loadError ? (
          <Alert tone="danger" className="mt-8">
            {loadError}
          </Alert>
        ) : (
          <p className="mt-8 text-sm text-muted">Loading run…</p>
        )}
      </main>
    );
  }

  const { run, leads, toolCalls } = data;

  // Filter leads: only show qualified + needs_review (if qualified count < target)
  const qualified = leads.filter((l) => l.qualification_status === "qualified");
  const needsReview = leads.filter((l) => l.qualification_status === "needs_review");
  const showNeedsReview = qualified.length < (run.lead_limit || 10);
  const visibleLeads = showNeedsReview ? [...qualified, ...needsReview] : qualified;

  // Sample pack: only for a completed run with at least one qualified lead
  const canExport = run.status === "completed" && qualified.length > 0;
  const handleExport = () => {
    const markdown = buildSamplePack(run, leads);
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = samplePackFilename(run.id);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // The run's message: an error for failures, a neutral note otherwise (e.g. a shortfall)
  const messageTone = run.status === "failed" ? "danger" : run.status === "cancelled" ? "neutral" : "warning";

  const tabClass = (tab: "leads" | "tools") =>
    `-mb-px border-b-2 pb-3 text-sm font-medium transition-colors ${
      activeTab === tab ? "border-rose text-ink" : "border-transparent text-muted hover:text-ink"
    }`;

  return (
    <main className="mx-auto max-w-5xl px-6 py-14">
      <Link href="/" className="text-sm font-medium text-rose-deep hover:text-rose-deeper">
        ← All runs
      </Link>

      <header className="mt-8">
        <div className="flex flex-wrap items-center gap-3">
          <Label>Run</Label>
          <Badge status={run.status} />
          {canExport && (
            <Button size="sm" variant="accent" onClick={handleExport} aria-label="Export sample pack as a Markdown file">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Export sample pack
            </Button>
          )}
          {run.status === "running" && canCancel && (
            <Button
              size="sm"
              variant="danger"
              className="ml-auto"
              onClick={() => setConfirmingCancel(true)}
              disabled={cancelling}
            >
              {cancelling ? "Cancelling…" : "Cancel run"}
            </Button>
          )}
        </div>
        <h1 className="mt-3 max-w-3xl text-2xl font-semibold leading-snug tracking-tight sm:text-[28px]">{run.objective}</h1>
        <p className="mt-3 text-sm text-muted">
          {new Date(run.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
          {run.actual_cost != null && run.actual_cost > 0 && ` · Claude cost $${run.actual_cost.toFixed(4)}`}
        </p>
        {run.error && (
          <Alert tone={messageTone} className="mt-5 max-w-3xl">
            {run.error}
          </Alert>
        )}
      </header>

      <ProgressTracker toolCalls={toolCalls} leads={leads} runStatus={run.status} hasIcp={!!run.refined_icp} />

      {run.refined_icp && <IcpDisplay objective={run.objective} icp={run.refined_icp} />}

      <div className="mt-12 flex gap-8 border-b border-line" role="tablist" aria-label="Run details">
        <button
          role="tab"
          id="tab-leads"
          aria-selected={activeTab === "leads"}
          aria-controls="panel-leads"
          onClick={() => setActiveTab("leads")}
          className={tabClass("leads")}
        >
          Leads{" "}
          <span className="text-muted">
            ({qualified.length} qualified{showNeedsReview && needsReview.length > 0 ? `, ${needsReview.length} to review` : ""})
          </span>
        </button>
        <button
          role="tab"
          id="tab-tools"
          aria-selected={activeTab === "tools"}
          aria-controls="panel-tools"
          onClick={() => setActiveTab("tools")}
          className={tabClass("tools")}
        >
          Activity <span className="text-muted">({toolCalls.length})</span>
        </button>
      </div>

      {activeTab === "leads" && (
        <section id="panel-leads" role="tabpanel" aria-labelledby="tab-leads" className="mt-6 space-y-3">
          {visibleLeads.map((lead) => (
            <LeadCard
              key={lead.id}
              lead={lead}
              runStatus={run.status}
              isReviewer={isReviewer}
              expanded={expandedLead === lead.id}
              onToggle={() => setExpandedLead(expandedLead === lead.id ? null : lead.id)}
              onPromote={() => setPromotingLead(lead)}
              onApprove={(draft) => {
                setApproveError(null);
                setApproving({ lead, draft });
              }}
            />
          ))}
          {visibleLeads.length === 0 && (
            <p className="text-sm text-muted">
              {run.status === "running" ? "Waiting for the agent to qualify leads…" : "No leads found."}
            </p>
          )}
        </section>
      )}

      {activeTab === "tools" && (
        <section id="panel-tools" role="tabpanel" aria-labelledby="tab-tools" className="mt-8">
          <ToolCallList toolCalls={toolCalls} runStatus={run.status} />
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
          message="Any leads already found will be saved, but the research will stop."
          cancelLabel="Keep running"
          confirmLabel="Cancel run"
          tone="red"
          busy={cancelling}
          error={cancelError}
          onConfirm={handleCancel}
          onClose={() => {
            setConfirmingCancel(false);
            setCancelError(null);
          }}
        />
      )}

      {promotedNotice && (
        <ConfirmModal
          title="Lead promoted"
          message="The lead is now qualified. This action has been logged."
          confirmLabel="OK"
          onConfirm={() => setPromotedNotice(false)}
          onClose={() => setPromotedNotice(false)}
        />
      )}

      {approving && (
        <ConfirmModal
          title="Approve outreach"
          message={`Approve this outreach for ${approving.lead.company_name}? Approved outreach is ready for a person to send. Nothing is sent automatically.`}
          cancelLabel="Cancel"
          confirmLabel="Approve outreach"
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
