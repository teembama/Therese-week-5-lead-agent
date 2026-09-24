import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getSession, requireRole } from "@/lib/auth";

const CANDIDATE_POOL_MULTIPLIER = 2;

// POST /api/runs — create run and start agent (validation already done by /api/validate)
export async function POST(req: NextRequest) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  if (!requireRole(user, ["researcher", "admin"])) {
    return NextResponse.json({ error: "Only researchers can start runs." }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const objective = body.objective as string;
  const leadTarget = (body.leadTarget as number) || 10;

  if (!objective || typeof objective !== "string" || objective.trim().length === 0) {
    return NextResponse.json({ error: "Objective is required." }, { status: 400 });
  }

  const candidateLimit = leadTarget * CANDIDATE_POOL_MULTIPLIER;

  // Idempotency: return an identical run started in the last 30s instead of duplicating it
  const { data: recent } = await supabase
    .from("lead_runs")
    .select("id")
    .eq("objective", objective.trim())
    .eq("status", "running")
    .gte("created_at", new Date(Date.now() - 30000).toISOString())
    .limit(1);

  if (recent && recent.length > 0) {
    return NextResponse.json({ run_id: recent[0].id, status: "running" });
  }

  const { data: run, error: insertError } = await supabase
    .from("lead_runs")
    .insert({
      user_id: user.id,
      objective: objective.trim(),
      lead_limit: leadTarget,
      candidate_limit: candidateLimit,
      scrape_limit: candidateLimit,
      agent_turn_limit: 25,
    })
    .select("id")
    .single();

  if (insertError || !run) {
    return NextResponse.json({ error: "Failed to create run. Please try again." }, { status: 500 });
  }

  // Start agent — Sandbox on Vercel, in-process locally
  if (process.env.VERCEL) {
    try {
      const { Sandbox } = await import("@vercel/sandbox");

      const repoUrl = process.env.VERCEL_GIT_REPO_OWNER && process.env.VERCEL_GIT_REPO_SLUG
        ? `https://github.com/${process.env.VERCEL_GIT_REPO_OWNER}/${process.env.VERCEL_GIT_REPO_SLUG}.git`
        : "https://github.com/teembama/Therese-week-5-lead-agent.git";

      const sandbox = await Sandbox.create({
        source: {
          type: "git" as const,
          url: repoUrl,
        },
        timeout: 30 * 60 * 1000,
      });

      // Install dependencies
      const install = await sandbox.runCommand({
        cmd: "npm",
        args: ["ci", "--prefer-offline"],
        timeoutMs: 120000,
      });

      if (install.exitCode !== 0) {
        throw new Error("Failed to install dependencies in sandbox");
      }

      // Start agent detached — returns immediately
      sandbox.runCommand({
        cmd: "npx",
        args: ["tsx", "scripts/run-agent.ts", run.id],
        env: {
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
          APIFY_API_TOKEN: process.env.APIFY_API_TOKEN || "",
          FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY || "",
          NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || "",
          SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
        },
        detached: true,
        timeoutMs: 25 * 60 * 1000,
      }).catch((err) => {
        console.error("Sandbox agent error:", err);
        supabase
          .from("lead_runs")
          .update({
            status: "failed",
            error: "The research service encountered an error. Please try again.",
            updated_at: new Date().toISOString(),
          })
          .eq("id", run.id)
          .eq("status", "running");
      });
    } catch (err) {
      console.error("Sandbox launch failed:", err);
      await supabase
        .from("lead_runs")
        .update({
          status: "failed",
          error: "The research service is temporarily unavailable. Please try again shortly.",
          updated_at: new Date().toISOString(),
        })
        .eq("id", run.id);
    }
  } else {
    const { runAgent } = await import("@/lib/agent");
    runAgent({
      runId: run.id,
      objective: objective.trim(),
      leadLimit: leadTarget,
      candidateLimit,
      scrapeLimit: candidateLimit,
      agentTurnLimit: 25,
    }).catch((err) => {
      console.error("Agent failed:", err);
      supabase
        .from("lead_runs")
        .update({ status: "failed", error: String(err), updated_at: new Date().toISOString() })
        .eq("id", run.id);
    });
  }

  return NextResponse.json({ run_id: run.id, status: "running" });
}

// GET /api/runs — list all runs
export async function GET() {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("lead_runs")
    .select("id, objective, status, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}