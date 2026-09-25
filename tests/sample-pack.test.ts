// Outreach sample pack export (src/lib/sample-pack.ts)
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSamplePack, samplePackFilename, icpRows, type SamplePackLead, type SamplePackRun } from "../src/lib/sample-pack";

const run: SamplePackRun = {
  id: "2730a906-1385-43a0-81ae-0c02e7fecb13",
  objective: "Find 3 US B2B SaaS companies with 10 to 100 employees that may need AI automation",
  status: "completed",
  created_at: "2026-09-24T21:11:29.000Z",
  lead_limit: 3,
  refined_icp: {
    target_company_type: "B2B SaaS",
    geography: ["United States"],
    headcount_range: "10-100 employees",
    business_problem: "May need AI automation",
    search_plan: {
      filters: {
        location: "United States",
        employee_range: { min: 10, max: 100 },
        company_sizes: ["11-50", "51-200"],
        industries: ["Software Development"],
      },
      search_terms: [
        { term: "workflow automation", reason: "Directly matches the automation need" },
        { term: "helpdesk", reason: "Support-heavy SaaS niche" },
      ],
    },
  },
};

const outreach = {
  email_1_subject: "Quick question about AdeptForms",
  email_1_body: "Hi [Name],\n\nI noticed you automate paper forms.",
  email_1_personalization: "References the paperless forms product",
  email_2_subject: "Follow-up",
  email_2_body: "Second note.",
  email_2_personalization: "Dashboards",
  email_3_subject: "Last note",
  email_3_body: "Closing the loop.",
  email_3_personalization: "",
  linkedin_message: "Hi [Name] - saw AdeptForms' platform.",
  status: "draft",
};

const leads: SamplePackLead[] = [
  {
    company_name: "AdeptForms",
    company_domain: "adeptforms.com",
    qualification_status: "qualified",
    confidence: 0.6,
    fit_reasons: ["Confirmed B2B SaaS product", "LinkedIn band 11-50"],
    concerns: ["Need for AI automation is inferred"],
    source_urls: ["https://adeptforms.com", "https://www.linkedin.com/company/adeptforms/"],
    source_summary: "Paperless forms platform.",
    lead_sources: [{ url: "https://adeptforms.com", title: "AdeptForms | Paperless Forms", relevant_evidence: "Automated report tracking" }],
    outreach_drafts: [outreach],
  },
  {
    company_name: "Business Evolution",
    company_domain: null,
    qualification_status: "needs_review",
    confidence: 0.3,
    fit_reasons: [],
    concerns: ["No website"],
  },
];

const NOW = new Date("2026-09-25T10:00:00Z");

test("the file is named outreach-sample-pack-[run-id].md", () => {
  assert.equal(samplePackFilename(run.id), `outreach-sample-pack-${run.id}.md`);
});

test("the pack contains the objective, refined ICP and search plan", () => {
  const md = buildSamplePack(run, leads, NOW);
  assert.match(md, /^# Outreach Sample Pack/);
  assert.match(md, /## Qualification objective\n\n> Find 3 US B2B SaaS companies/);
  assert.match(md, /## Refined ICP criteria/);
  assert.match(md, /\| Company type \| B2B SaaS \|/);
  assert.match(md, /\| Business problem \| May need AI automation \|/);
  assert.doesNotMatch(md, /\| Search plan \|/, "the plan is its own section, not an ICP row");
  assert.match(md, /## Search plan/);
  assert.match(md, /- \*\*Employee range:\*\* 10–100 employees/);
  assert.match(md, /- \*\*LinkedIn size bands:\*\* 11-50, 51-200/);
  assert.match(md, /- \*\*Industries:\*\* Software Development/);
  assert.match(md, /\| workflow automation \| Directly matches the automation need \|/);
  assert.match(md, /Nothing in this pack has been sent/);
});

test("each qualified lead has its details, evidence and full outreach; other leads are left out", () => {
  const md = buildSamplePack(run, leads, NOW);
  assert.match(md, /### 1\. AdeptForms\n\n\*\*Domain:\*\* adeptforms\.com · \*\*Status:\*\* qualified · \*\*Confidence:\*\* 60%/);
  assert.match(md, /#### Why it fits\n\n- Confirmed B2B SaaS product\n- LinkedIn band 11-50/);
  assert.match(md, /#### Concerns\n\n- Need for AI automation is inferred/);
  assert.match(md, /#### Source evidence/);
  assert.match(md, /- \[AdeptForms \\?\| Paperless Forms\]\(https:\/\/adeptforms\.com\)\n {2}- Automated report tracking/);
  assert.match(md, /- <https:\/\/www\.linkedin\.com\/company\/adeptforms\/>/, "source URLs without a record are listed too");
  assert.match(md, /\*\*Email 1: Quick question about AdeptForms\*\*\n\n> Hi \[Name\],\n>\n> I noticed you automate paper forms\./);
  assert.match(md, /_Personalization: References the paperless forms product_/);
  assert.match(md, /\*\*Email 3: Last note\*\*/);
  assert.match(md, /\*\*LinkedIn message\*\*\n\n> Hi \[Name\] - saw AdeptForms' platform\./);
  assert.doesNotMatch(md, /Business Evolution/, "needs_review leads are not in the pack");
  assert.match(md, /\| Qualified leads \| 1 of 3 requested \|/);
});

test("non-http source URLs are never turned into links", () => {
  const md = buildSamplePack(run, [{ ...leads[0], lead_sources: [{ url: "javascript:alert(1)", title: "x" }], source_urls: [] }], NOW);
  assert.doesNotMatch(md, /\]\(javascript:/);
  assert.match(md, /`javascript:alert\(1\)`/);
});

test("the ICP rows exclude the search plan and keep a stable label order", () => {
  assert.deepEqual(
    icpRows(run.refined_icp!).map((r) => r.label),
    ["Company type", "Geography", "Company size", "Business problem"]
  );
});
