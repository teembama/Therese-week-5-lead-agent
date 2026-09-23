"use client";

import { useState, useEffect } from "react";
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
  email_2_subject: string;
  email_2_body: string;
  email_3_subject: string;
  email_3_body: string;
  linkedin_message: string;
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
  };
  leads: Lead[];
  toolCalls: ToolCall[];
}

export default function RunPage() {
  const params = useParams();
  const [data, setData] = useState<RunData | null>(null);
  const [expandedLead, setExpandedLead] = useState<string | null>(null);

  useEffect(() => {
    if (params.id) {
      fetch(`/api/runs/${params.id}`)
        .then((r) => r.json())
        .then(setData)
        .catch(console.error);
    }
  }, [params.id]);

  if (!data) {
    return (
      <main className="max-w-4xl mx-auto px-6 py-12">
        <p className="text-gray-500">Loading...</p>
      </main>
    );
  }

  const { run, leads, toolCalls } = data;
  const qualified = leads.filter((l) => l.qualification_status === "qualified");
  const needsReview = leads.filter((l) => l.qualification_status === "needs_review");

  return (
    <main className="max-w-4xl mx-auto px-6 py-12">
      <Link href="/" className="text-sm text-blue-600 hover:underline">
        ← Back
      </Link>

      <div className="mt-4 mb-8">
        <div className="flex items-center gap-3 mb-2">
          <h1 className="text-xl font-bold">Run Details</h1>
          <span
            className={`text-xs px-2 py-1 rounded-full ${
              run.status === "completed"
                ? "bg-green-100 text-green-800"
                : run.status === "failed"
                ? "bg-red-100 text-red-800"
                : "bg-yellow-100 text-yellow-800"
            }`}
          >
            {run.status}
          </span>
        </div>
        <p className="text-sm text-gray-700">{run.objective}</p>
        <p className="text-xs text-gray-500 mt-1">
          {new Date(run.created_at).toLocaleString()}
          {run.actual_cost != null && ` · $${run.actual_cost.toFixed(4)}`}
        </p>
        {run.error && (
          <p className="text-sm text-red-600 mt-2 bg-red-50 p-2 rounded">{run.error}</p>
        )}
      </div>

      {run.refined_icp && (
        <section className="mb-8">
          <h2 className="text-lg font-semibold mb-2">Refined ICP</h2>
          <pre className="bg-gray-50 p-4 rounded-lg text-xs overflow-auto">
            {JSON.stringify(run.refined_icp, null, 2)}
          </pre>
        </section>
      )}

      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-3">
          Leads ({qualified.length} qualified, {needsReview.length} needs review, {leads.length} total)
        </h2>
        <div className="space-y-2">
          {leads.map((lead) => (
            <div key={lead.id} className="border rounded-lg overflow-hidden">
              <button
                onClick={() =>
                  setExpandedLead(expandedLead === lead.id ? null : lead.id)
                }
                className="w-full text-left p-4 hover:bg-gray-50 transition-colors"
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
                          ? "bg-green-100 text-green-800"
                          : lead.qualification_status === "not_qualified"
                          ? "bg-red-100 text-red-800"
                          : "bg-yellow-100 text-yellow-800"
                      }`}
                    >
                      {lead.qualification_status}
                    </span>
                  </div>
                </div>
              </button>

              {expandedLead === lead.id && (
                <div className="border-t p-4 bg-gray-50 text-sm space-y-4">
                  {lead.fit_reasons.length > 0 && (
                    <div>
                      <p className="font-medium text-green-700 mb-1">Fit Reasons</p>
                      <ul className="list-disc list-inside text-xs space-y-1">
                        {lead.fit_reasons.map((r, i) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {lead.concerns.length > 0 && (
                    <div>
                      <p className="font-medium text-red-700 mb-1">Concerns</p>
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
                      <p className="text-xs text-gray-700">{lead.source_summary}</p>
                    </div>
                  )}
                  {lead.outreach_drafts?.[0] && (
                    <div>
                      <p className="font-medium mb-2">Outreach Drafts</p>
                      {[1, 2, 3].map((n) => {
                        const draft = lead.outreach_drafts[0];
                        const subject = draft[`email_${n}_subject` as keyof OutreachDraft] as string;
                        const body = draft[`email_${n}_body` as keyof OutreachDraft] as string;
                        if (!subject) return null;
                        return (
                          <div key={n} className="mb-3 bg-white p-3 rounded border">
                            <p className="text-xs font-medium">Email {n}: {subject}</p>
                            <p className="text-xs text-gray-600 mt-1 whitespace-pre-wrap">{body}</p>
                          </div>
                        );
                      })}
                      {lead.outreach_drafts[0].linkedin_message && (
                        <div className="bg-white p-3 rounded border">
                          <p className="text-xs font-medium">LinkedIn</p>
                          <p className="text-xs text-gray-600 mt-1">
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
          {leads.length === 0 && (
            <p className="text-sm text-gray-500">No leads yet.</p>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">
          Tool Calls ({toolCalls.length})
        </h2>
        <div className="overflow-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left border-b">
                <th className="pb-2 pr-3">Tool</th>
                <th className="pb-2 pr-3">Purpose</th>
                <th className="pb-2 pr-3">Status</th>
                <th className="pb-2">Time</th>
              </tr>
            </thead>
            <tbody>
              {toolCalls.map((tc) => (
                <tr key={tc.id} className="border-b border-gray-100">
                  <td className="py-2 pr-3 font-mono">{tc.tool_name}</td>
                  <td className="py-2 pr-3 text-gray-600 max-w-xs truncate">
                    {tc.purpose}
                  </td>
                  <td className="py-2 pr-3">
                    <span
                      className={
                        tc.status === "success" ? "text-green-600" : "text-red-600"
                      }
                    >
                      {tc.status}
                    </span>
                  </td>
                  <td className="py-2 text-gray-500">
                    {new Date(tc.created_at).toLocaleTimeString()}
                  </td>
                </tr>
              ))}
              {toolCalls.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-4 text-gray-500">
                    No tool calls yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
