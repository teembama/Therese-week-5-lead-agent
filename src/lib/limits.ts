// Hard per-run limits shared by run creation (POST /api/runs) and the agent tools.
// The agent reads its limits from the lead_runs record and clamps them to these maximums,
// so neither the browser nor the model can raise them.

export const MAX_LEADS = 10;
// Candidate budget = lead target × 4 (target 5 → 20). Headroom for junk results and rejects.
export const CANDIDATE_POOL_MULTIPLIER = 4;
export const MAX_CANDIDATES = MAX_LEADS * CANDIDATE_POOL_MULTIPLIER;
export const MAX_SCRAPES = MAX_CANDIDATES;
export const MAX_RESULTS_PER_DISCOVERY_CALL = 20;
export const DEFAULT_AGENT_TURN_LIMIT = 25;
export const MAX_AGENT_TURN_LIMIT = 50;
// Backstop on custom tool invocations per run (turns already bound this; this caps parallel fan-out)
export const MAX_TOOL_CALLS_PER_RUN = 120;
// Each URL may be scraped once, plus one retry after a failed attempt
export const MAX_SCRAPE_ATTEMPTS_PER_URL = 2;

// Estimated Apify price per company profile returned by harvestapi/linkedin-company-search (USD)
export const APIFY_COST_PER_RESULT = 0.004;

export function estimateApifyCost(resultsReturned: number): number {
  return Math.round(resultsReturned * APIFY_COST_PER_RESULT * 10000) / 10000;
}

// Same limit /api/validate applies; enforced again at run creation so a direct API call can't skip it
export const MAX_OBJECTIVE_LENGTH = 1000;

// Shared by /api/validate and POST /api/runs so the user sees the same wording either way
export const MAX_LEADS_MESSAGE = `You can request a maximum of ${MAX_LEADS} leads per run.`;
export const LEAD_TARGET_RANGE_MESSAGE = `Lead target must be a whole number between 1 and ${MAX_LEADS}.`;

// A running run whose updated_at is older than this is treated as orphaned (its process died).
// runAgent refreshes updated_at every HEARTBEAT_INTERVAL_MS, so a live run never reaches it.
export const STALE_RUN_MS = 35 * 60 * 1000;
export const HEARTBEAT_INTERVAL_MS = 60 * 1000;

// Structural checks for POST /api/runs (semantic validation stays in /api/validate)
export function parseRunRequest(
  body: Record<string, unknown>
): { ok: true; objective: string; leadTarget: number } | { ok: false; error: string } {
  const objective = typeof body.objective === "string" ? body.objective.trim() : "";
  if (!objective) return { ok: false, error: "Objective is required." };
  if (objective.length > MAX_OBJECTIVE_LENGTH) {
    return { ok: false, error: `Your objective is too long. Keep it under ${MAX_OBJECTIVE_LENGTH} characters.` };
  }

  // Only an absent lead target defaults to the maximum; an explicit null or other value is checked
  const raw = body.leadTarget === undefined ? MAX_LEADS : body.leadTarget;
  if (typeof raw === "number" && Number.isInteger(raw) && raw > MAX_LEADS) {
    return { ok: false, error: MAX_LEADS_MESSAGE };
  }
  const leadTarget = parseLeadTarget(raw);
  if (leadTarget === null) {
    return { ok: false, error: LEAD_TARGET_RANGE_MESSAGE };
  }
  return { ok: true, objective, leadTarget };
}

// Returns the validated lead target, or null if the value is not an integer in 1..MAX_LEADS
export function parseLeadTarget(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 1 || value > MAX_LEADS) return null;
  return value;
}

export function candidateLimitFor(leadTarget: number): number {
  return leadTarget * CANDIDATE_POOL_MULTIPLIER;
}

// Clamps a limit read from the database; anything non-integer falls to the minimum
export function clampLimit(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return min;
  return Math.min(Math.max(value, min), max);
}
