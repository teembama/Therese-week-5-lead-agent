"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Alert, Badge, Button, Card, Label } from "@/components/ui";

interface SessionUser {
  id: string;
  username: string;
  role: string;
  display_name: string;
}

interface Run {
  id: string;
  objective: string;
  status: string;
  created_at: string;
}

const EXAMPLE =
  "Find 5 US B2B SaaS companies with 10 to 100 employees that may need AI automation to streamline their operations.";

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default function Home() {
  const [objective, setObjective] = useState("");
  const [phase, setPhase] = useState<"idle" | "validating" | "starting">("idle");
  const [error, setError] = useState("");
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [user, setUser] = useState<SessionUser | null>(null);
  const validateAbort = useRef<AbortController | null>(null);
  const router = useRouter();

  useEffect(() => {
    fetch("/api/auth/session")
      .then((r) => {
        if (r.status === 401) {
          router.push("/login");
          return null;
        }
        return r.json();
      })
      .then((data) => data && setUser(data.user))
      .catch(console.error);
  }, [router]);

  const canCreateRuns = user?.role === "researcher" || user?.role === "admin";
  const isReviewer = user?.role === "reviewer";

  useEffect(() => {
    fetch("/api/runs")
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then(setRuns)
      .catch((err) => {
        console.error(err);
        setRuns([]);
      });
  }, []);

  const handleSubmit = async () => {
    if (!objective.trim() || phase !== "idle") return;
    setError("");

    // Phase 1: Validate (can be cancelled; nothing has been created yet)
    setPhase("validating");
    const controller = new AbortController();
    validateAbort.current = controller;
    try {
      const valRes = await fetch("/api/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ objective: objective.trim() }),
        signal: controller.signal,
      });
      const valData = await valRes.json();

      if (!valRes.ok) {
        setError(valData.error || "Invalid objective.");
        setPhase("idle");
        return;
      }

      // Phase 2: Start run (no longer cancellable from here; cancel from the run page)
      validateAbort.current = null;
      setPhase("starting");
      const runRes = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          objective: objective.trim(),
          leadTarget: valData.leadTarget,
        }),
      });
      const runData = await runRes.json();

      if (!runRes.ok) {
        setError(runData.error || "Failed to start run.");
        setPhase("idle");
        return;
      }

      if (runData.run_id) {
        router.push(`/runs/${runData.run_id}`);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return; // user cancelled validation
      setError("Failed to connect. Check your connection and try again.");
      setPhase("idle");
    }
  };

  const handleCancelValidation = () => {
    validateAbort.current?.abort();
    validateAbort.current = null;
    setPhase("idle");
    setError("");
  };

  const buttonLabel =
    phase === "validating" ? "Checking your objective…" : phase === "starting" ? "Starting research…" : "Start research";

  return (
    <main className="mx-auto max-w-5xl px-6 py-14 sm:py-20">
      <section className="max-w-2xl">
        <Label>Lead research</Label>
        {isReviewer ? (
          <>
            <h1 className="mt-3 text-4xl font-semibold leading-tight tracking-tight sm:text-[44px]">
              Review and approve outreach.
            </h1>
            <p className="mt-4 text-base leading-relaxed text-muted">
              Research runs appear here once complete. Review the qualified leads, check the evidence, and approve outreach
              drafts before anything goes out.
            </p>
          </>
        ) : (
          <>
            <h1 className="mt-3 text-4xl font-semibold leading-tight tracking-tight sm:text-[44px]">
              Find companies worth talking to.
            </h1>
            <p className="mt-4 text-base leading-relaxed text-muted">
              Describe the companies you are looking for and why. The agent searches LinkedIn, researches each company,
              keeps only those that fit with cited evidence, and drafts outreach for you to review. Nothing is ever sent.
            </p>
          </>
        )}
      </section>

      {canCreateRuns && (
        <Card className="mt-12 p-6 sm:p-8">
          <label htmlFor="objective" className="block text-sm font-medium">
            Qualification objective
          </label>
          <p id="objective-help" className="mt-1 text-sm text-muted">
            Include the type of company, where they are, their size, and the need they might have. Up to 10 qualified leads
            per run.
          </p>
          <textarea
            id="objective"
            aria-describedby="objective-help"
            className="mt-4 min-h-[120px] w-full resize-y rounded-lg border border-line-strong bg-surface px-4 py-3 text-[15px] leading-relaxed text-ink placeholder:text-muted/70 focus:border-rose focus:outline-none focus:ring-2 focus:ring-rose/20 disabled:opacity-60"
            placeholder={EXAMPLE}
            value={objective}
            maxLength={1000}
            onChange={(e) => {
              setObjective(e.target.value);
              if (error) setError("");
            }}
            disabled={phase !== "idle"}
          />
          <div className="mt-2 flex justify-end text-xs text-muted" aria-live="polite">
            {objective.length}/1000
          </div>

          {error && (
            <Alert tone="danger" className="mt-4">
              {error}
            </Alert>
          )}

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Button variant="primary" onClick={handleSubmit} disabled={!objective.trim() || phase !== "idle"}>
              {phase !== "idle" && (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden="true" />
              )}
              {buttonLabel}
            </Button>
            {phase === "validating" && (
              <Button variant="ghost" onClick={handleCancelValidation}>
                Cancel
              </Button>
            )}
            {phase === "idle" && !objective && (
              <button
                type="button"
                onClick={() => setObjective(EXAMPLE)}
                className="text-sm font-medium text-rose-deep hover:text-rose-deeper"
              >
                Use the example
              </button>
            )}
          </div>
        </Card>
      )}

      <section className="mt-16">
        <div className="flex items-baseline justify-between">
          <h2 className="text-xl font-semibold tracking-tight">Past runs</h2>
          {runs && runs.length > 0 && <span className="text-sm text-muted">{runs.length} total</span>}
        </div>

        {runs === null && <p className="mt-6 text-sm text-muted">Loading runs…</p>}
        {runs !== null && runs.length === 0 && (
          <p className="mt-6 text-sm text-muted">No runs yet. Start one above to see it here.</p>
        )}

        {runs && runs.length > 0 && (
          <ul className="mt-6 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {runs.map((run) => (
              <li key={run.id}>
                <button
                  onClick={() => router.push(`/runs/${run.id}`)}
                  className="group flex w-full items-start justify-between gap-6 px-5 py-4 text-left transition-colors hover:bg-canvas"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink group-hover:text-rose-deep">{run.objective}</p>
                    <p className="mt-1 text-xs text-muted">{formatDate(run.created_at)}</p>
                  </div>
                  <Badge status={run.status} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
