// Builds the "outreach sample pack": a Markdown document of a run's objective, criteria,
// search plan and qualified leads with their evidence and outreach drafts.
// Pure (no browser or network access), so it can be tested and reused.

export interface SamplePackSource {
  url: string;
  title?: string | null;
  summary?: string | null;
  relevant_evidence?: string | null;
}

export interface SamplePackOutreach {
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
  status?: string;
  created_at?: string;
}

export interface SamplePackLead {
  company_name: string;
  company_domain: string | null;
  qualification_status: string;
  confidence: number;
  fit_reasons: string[];
  concerns: string[];
  source_urls?: string[];
  source_summary?: string | null;
  lead_sources?: SamplePackSource[];
  outreach_drafts?: SamplePackOutreach[];
}

export interface SamplePackPlan {
  filters?: {
    location?: string;
    employee_range?: { min?: number; max?: number };
    company_sizes?: string[];
    industries?: string[];
  };
  search_terms?: { term: string; reason: string; type?: string }[];
}

export interface SamplePackRun {
  id: string;
  objective: string;
  status: string;
  created_at: string;
  lead_limit?: number;
  refined_icp: (Record<string, unknown> & { search_plan?: SamplePackPlan }) | null;
}

// --- ICP labels (shared with the run page so both describe the criteria the same way) ---
// The agent's ICP keys vary between runs, so several aliases map to one label.
export const ICP_FIELDS: { label: string; keys: string[] }[] = [
  { label: "Company type", keys: ["company_type", "target_company_type"] },
  { label: "Industries", keys: ["industries", "industry"] },
  { label: "Geography", keys: ["geography", "location", "locations"] },
  { label: "Company size", keys: ["company_size", "headcount_range", "employee_range", "size"] },
  { label: "Buyer persona", keys: ["buyer_persona", "persona"] },
  { label: "Business problem", keys: ["business_problem", "problem"] },
  { label: "Hard filters", keys: ["hard_filters"] },
  { label: "Soft preferences", keys: ["soft_preferences"] },
  { label: "Disqualifiers", keys: ["disqualifiers"] },
];

export function humanizeKey(key: string): string {
  const s = key.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function formatIcpValue(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(formatIcpValue).filter(Boolean).join(", ");
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${humanizeKey(k)}: ${formatIcpValue(v)}`)
      .join("; ");
  }
  return String(value);
}

// Label/value rows for the refined ICP, in a stable order, excluding the search plan
export function icpRows(icp: Record<string, unknown>): { label: string; value: string }[] {
  const knownKeys = new Set([...ICP_FIELDS.flatMap((f) => f.keys), "search_plan"]);
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
  return rows;
}

export function formatRange(range?: { min?: number; max?: number }): string {
  if (!range) return "";
  if (range.min !== undefined && range.max !== undefined) return `${range.min}–${range.max} employees`;
  if (range.min !== undefined) return `${range.min}+ employees`;
  if (range.max !== undefined) return `up to ${range.max} employees`;
  return "";
}

// --- Markdown helpers ---

// Keeps user/agent text on its own lines and stops it from breaking the table layout
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim();
}

function quote(text: string): string {
  return text
    .trim()
    .split(/\r?\n/)
    .map((l) => (l.trim() ? `> ${l}` : ">"))
    .join("\n");
}

function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function link(url: string, label?: string | null): string {
  if (!isHttpUrl(url)) return `\`${url}\``;
  return label ? `[${oneLine(label).replace(/[[\]]/g, "")}](${url})` : `<${url}>`;
}

function bullets(items: string[]): string {
  return items.map((i) => `- ${oneLine(i)}`).join("\n");
}

export function samplePackFilename(runId: string): string {
  return `outreach-sample-pack-${runId}.md`;
}

export function qualifiedLeads<T extends { qualification_status: string }>(leads: T[]): T[] {
  return leads.filter((l) => l.qualification_status === "qualified");
}

export function buildSamplePack(run: SamplePackRun, leads: SamplePackLead[], generatedAt: Date = new Date()): string {
  const qualified = qualifiedLeads(leads);
  const icp = run.refined_icp ?? {};
  const plan = run.refined_icp?.search_plan;
  const out: string[] = [];
  const date = (d: Date) => d.toISOString().slice(0, 10);

  out.push("# Outreach Sample Pack");
  out.push("");
  out.push("**Koya Lead Studio** · research, qualification evidence and outreach drafts for human review.");
  out.push("");
  out.push("| | |");
  out.push("|---|---|");
  out.push(`| Run | \`${run.id}\` |`);
  out.push(`| Run started | ${date(new Date(run.created_at))} |`);
  out.push(`| Generated | ${date(generatedAt)} |`);
  out.push(`| Qualified leads | ${qualified.length}${run.lead_limit ? ` of ${run.lead_limit} requested` : ""} |`);
  out.push("");
  out.push("> These are drafts for review. Nothing in this pack has been sent.");
  out.push("");

  out.push("## Qualification objective");
  out.push("");
  out.push(quote(run.objective));
  out.push("");

  const rows = icpRows(icp);
  if (rows.length) {
    out.push("## Refined ICP criteria");
    out.push("");
    out.push("| Criterion | Value |");
    out.push("|---|---|");
    for (const r of rows) out.push(`| ${r.label} | ${oneLine(r.value)} |`);
    out.push("");
  }

  if (plan) {
    out.push("## Search plan");
    out.push("");
    const f = plan.filters ?? {};
    const filters = [
      ["Location", f.location ?? ""],
      ["Employee range", formatRange(f.employee_range)],
      ["LinkedIn size bands", (f.company_sizes ?? []).join(", ")],
      ["Industries", (f.industries ?? []).join(", ")],
    ].filter(([, v]) => v);
    if (filters.length) {
      out.push("**Filters**");
      out.push("");
      for (const [k, v] of filters) out.push(`- **${k}:** ${oneLine(v)}`);
      out.push("");
    }
    const terms = plan.search_terms ?? [];
    if (terms.length) {
      out.push("**Search terms**");
      out.push("");
      const withType = terms.some((t) => t.type);
      out.push(withType ? "| Term | Type | Reason |" : "| Term | Reason |");
      out.push(withType ? "|---|---|---|" : "|---|---|");
      for (const t of terms) {
        out.push(withType ? `| ${oneLine(t.term)} | ${oneLine(t.type ?? "")} | ${oneLine(t.reason)} |` : `| ${oneLine(t.term)} | ${oneLine(t.reason)} |`);
      }
      out.push("");
    }
  }

  out.push("## Qualified leads");
  out.push("");
  if (qualified.length === 0) out.push("_No qualified leads in this run._");

  qualified.forEach((lead, i) => {
    out.push(`### ${i + 1}. ${oneLine(lead.company_name)}`);
    out.push("");
    const facts = [
      lead.company_domain ? `**Domain:** ${lead.company_domain}` : null,
      `**Status:** ${lead.qualification_status}`,
      `**Confidence:** ${Math.round(lead.confidence * 100)}%`,
    ].filter(Boolean);
    out.push(facts.join(" · "));
    out.push("");

    if (lead.fit_reasons.length) {
      out.push("#### Why it fits");
      out.push("");
      out.push(bullets(lead.fit_reasons));
      out.push("");
    }
    if (lead.concerns.length) {
      out.push("#### Concerns");
      out.push("");
      out.push(bullets(lead.concerns));
      out.push("");
    }

    const sources = lead.lead_sources ?? [];
    const recorded = new Set(sources.map((s) => s.url));
    const otherUrls = (lead.source_urls ?? []).filter((u) => !recorded.has(u));
    if (sources.length || otherUrls.length || lead.source_summary) {
      out.push("#### Source evidence");
      out.push("");
      if (lead.source_summary) {
        out.push(oneLine(lead.source_summary));
        out.push("");
      }
      for (const s of sources) {
        out.push(`- ${link(s.url, s.title)}`);
        const evidence = s.relevant_evidence || s.summary;
        if (evidence) out.push(`  - ${oneLine(evidence)}`);
      }
      for (const u of otherUrls) out.push(`- ${link(u)}`);
      out.push("");
    }

    // The latest draft that was not rejected (a rejected draft is never exported)
    const draft = [...(lead.outreach_drafts ?? [])]
      .filter((d) => d.status !== "rejected")
      .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))
      .at(-1);
    if (draft) {
      out.push(`#### Outreach${draft.status ? ` (${draft.status})` : ""}`);
      out.push("");
      for (const n of [1, 2, 3] as const) {
        const subject = draft[`email_${n}_subject`];
        const body = draft[`email_${n}_body`];
        const personalization = draft[`email_${n}_personalization`];
        if (!subject && !body) continue;
        out.push(`**Email ${n}: ${oneLine(subject || "(no subject)")}**`);
        out.push("");
        out.push(quote(body || ""));
        out.push("");
        if (personalization) {
          out.push(`_Personalization: ${oneLine(personalization)}_`);
          out.push("");
        }
      }
      if (draft.linkedin_message) {
        out.push("**LinkedIn message**");
        out.push("");
        out.push(quote(draft.linkedin_message));
        out.push("");
      }
    } else {
      out.push("_Outreach pending._");
      out.push("");
    }

    if (i < qualified.length - 1) {
      out.push("---");
      out.push("");
    }
  });

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
