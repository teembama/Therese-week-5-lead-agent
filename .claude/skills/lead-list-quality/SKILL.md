---
name: lead-list-quality
description: Use as a final quality gate before completing a run. Checks the lead list for completeness, duplicates, evidence quality, and safety compliance.
---

# Lead-List Quality Guide

Use this guide to check the quality of the final lead list before submission.

## Required Checks

- The list contains 10 qualified companies.
- Each company has a name and domain.
- Each company has qualification reasoning.
- Each company has source context.
- Each company has outreach drafts.
- No personal email finding or email validation was attempted.
- Duplicate companies were removed.
- Companies marked `needs_review` are not counted as qualified leads.

## Suggested Scorecard

| Dimension | What To Check |
| --- | --- |
| ICP Fit | The lead matches the hard filters in the qualification objective. |
| Evidence Quality | The qualification decision uses real source context. |
| Duplicate Rate | The same company does not appear more than once. |
| Outreach Relevance | The email sequence uses company-specific context. |
| Data Completeness | Required fields are present in Supabase. |
| Safety Compliance | The agent did not find emails, validate emails, or send outreach. |

## Pass Standard

The submitted list should include 10 qualified companies that pass the core checks above.

If the agent cannot find 10 qualified companies from the first candidate pool, it should either search again within the tool-call limit or return fewer leads with a clear explanation.
