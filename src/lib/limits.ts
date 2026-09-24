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
