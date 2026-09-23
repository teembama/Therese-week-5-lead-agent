// scripts/run-agent.ts
// Runs inside a Vercel Sandbox. Reads the run ID from argv, loads the run config, executes the agent.

import { runAgent } from "../src/lib/agent";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function main() {
  const runId = process.argv[2];
  if (!runId) {
    console.error("Usage: tsx scripts/run-agent.ts <run-id>");
    process.exit(1);
  }

  // Load the run config from Supabase
  const { data: run, error } = await supabase
    .from("lead_runs")
    .select("*")
    .eq("id", runId)
    .single();

  if (error || !run) {
    console.error(`Run ${runId} not found:`, error?.message);
    process.exit(1);
  }

  if (run.status !== "running") {
    console.error(`Run ${runId} is ${run.status}, not running. Exiting.`);
    process.exit(0);
  }

  console.log(`Starting agent for run ${runId}: ${run.objective}`);

  try {
    const result = await runAgent({
      runId: run.id,
      objective: run.objective,
      leadLimit: run.lead_limit,
      candidateLimit: run.candidate_limit,
      scrapeLimit: run.scrape_limit,
      agentTurnLimit: run.agent_turn_limit,
    });

    console.log(`Agent finished: ${result.status}, cost: $${result.cost}`);
    process.exit(result.status === "completed" ? 0 : 1);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`Agent crashed: ${errorMsg}`);

    // Mark run as failed if still running
    await supabase
      .from("lead_runs")
      .update({
        status: "failed",
        error: "The research service encountered an error. Please try again.",
        updated_at: new Date().toISOString(),
      })
      .eq("id", runId)
      .eq("status", "running");

    process.exit(1);
  }
}

main();