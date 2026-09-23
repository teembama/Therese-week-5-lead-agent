---
name: icp-refinement
description: Use when refining a vague or specific qualification objective into concrete ICP criteria before searching for companies. Produces structured hard filters, soft preferences, and disqualifiers.
---

# ICP Refinement Guide

Use this guide to turn a vague qualification objective into concrete ICP criteria before the agent searches for companies.

## Goal

The agent should understand who counts as a good-fit company before it spends tool calls on discovery and scraping.

## Minimum Criteria To Clarify

- Target company type
- Industry or niche
- Geography
- Company size or headcount range
- Relevant buyer or operator persona
- Business problem the company may have
- Hard disqualifiers
- Soft preferences

## Hard Filters vs Soft Preferences

Hard filters must be true for a lead to qualify.

Examples:

- Country must be United States
- Company must be B2B
- Headcount must be between 10 and 100

Soft preferences improve fit but should not automatically disqualify a company.

Examples:

- Recently hiring operations roles
- Uses tools that may connect to automation workflows
- Publishes content about scaling operations

## Output Format

The agent should produce a short ICP object before searching:

```json
{
  "target_company_type": "",
  "industries": [],
  "geography": [],
  "headcount_range": "",
  "buyer_persona": "",
  "business_problem": "",
  "hard_filters": [],
  "soft_preferences": [],
  "disqualifiers": []
}
```

## Rules

- Do not treat every user preference as a hard filter.
- Ask for clarification if the objective is too vague to search.
- Preserve specific constraints the user gives.
- Keep the ICP narrow enough to search, but not so narrow that the agent cannot find leads.
