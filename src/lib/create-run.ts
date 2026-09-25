import { candidateLimitFor, DEFAULT_AGENT_TURN_LIMIT, parseRunRequest } from "./limits";
import { checkObjectiveStructure } from "./objective-validation";

// Run-creation rules for POST /api/runs, kept separate from the route so they can be tested
// without a server. The Haiku semantic check stays in /api/validate; the structural checks run
// here too, so a direct API call cannot skip them.

export const RUN_IN_PROGRESS_MESSAGE =
  "You already have a run in progress. Please wait for it to complete or cancel it.";

// An identical objective from the same user within this window returns the run already started
// (a double click), rather than a second run or a 409
const DUPLICATE_WINDOW_MS = 30_000;

export interface CreateRunDeps {
  findRecentRun(userId: string, objective: string, since: string): Promise<string | null>;
  findRunningRun(userId: string): Promise<string | null>;
  // "running_exists": the database's one-running-run-per-user index rejected the insert (a race)
  insertRun(row: Record<string, unknown>): Promise<{ id: string } | "running_exists">;
}

export interface CreateRunResult {
  httpStatus: number;
  body: Record<string, unknown>;
  // Set when a new run was created and its agent should be started
  startRunId?: string;
}

export async function createRun(
  deps: CreateRunDeps,
  user: { id: string },
  body: Record<string, unknown>,
  now: number = Date.now()
): Promise<CreateRunResult> {
  const parsed = parseRunRequest(body);
  if (!parsed.ok) return { httpStatus: 400, body: { error: parsed.error } };
  const structure = checkObjectiveStructure(parsed.objective);
  if (!structure.ok) return { httpStatus: 400, body: { error: structure.error } };
  const objective = structure.objective;
  const { leadTarget } = parsed;

  const recent = await deps.findRecentRun(user.id, objective, new Date(now - DUPLICATE_WINDOW_MS).toISOString());
  if (recent) return { httpStatus: 200, body: { run_id: recent, status: "running" } };

  const running = await deps.findRunningRun(user.id);
  if (running) return { httpStatus: 409, body: { error: RUN_IN_PROGRESS_MESSAGE, run_id: running } };

  const candidateLimit = candidateLimitFor(leadTarget);
  const inserted = await deps.insertRun({
    user_id: user.id,
    objective,
    lead_limit: leadTarget,
    candidate_limit: candidateLimit,
    scrape_limit: candidateLimit,
    agent_turn_limit: DEFAULT_AGENT_TURN_LIMIT,
  });
  if (inserted === "running_exists") return { httpStatus: 409, body: { error: RUN_IN_PROGRESS_MESSAGE } };

  return { httpStatus: 200, body: { run_id: inserted.id, status: "running" }, startRunId: inserted.id };
}
