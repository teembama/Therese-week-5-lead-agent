// Runs once when a Next.js server instance starts (e.g. after a Railway restart or redeploy).
// Resolves runs orphaned by the previous process. It runs in the background so a slow or
// unreachable database never delays or breaks startup; the run list repeats the same check.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const [{ supabase }, { recoverStaleRuns }] = await Promise.all([
    import("./lib/supabase"),
    import("./lib/stale-runs"),
  ]);

  recoverStaleRuns(supabase)
    .then((ids) => {
      if (ids.length) console.warn(`Startup: recovered ${ids.length} stale run(s): ${ids.join(", ")}`);
    })
    .catch((err) => console.error("Startup stale-run recovery failed:", err));
}
