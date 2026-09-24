"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { statusBadgeClass } from "@/lib/run-status";

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

export default function Home() {
  const [objective, setObjective] = useState("");
  const [phase, setPhase] = useState<"idle" | "validating" | "starting">("idle");
  const [error, setError] = useState("");
  const [runs, setRuns] = useState<Run[]>([]);
  const [user, setUser] = useState<SessionUser | null>(null);
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

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    router.push("/login");
    router.refresh();
  };

  const canCreateRuns = user?.role === "researcher" || user?.role === "admin";

  useEffect(() => {
    fetch("/api/runs")
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then(setRuns)
      .catch(console.error);
  }, []);

  const handleSubmit = async () => {
    if (!objective.trim() || phase !== "idle") return;
    setError("");

    // Phase 1: Validate
    setPhase("validating");
    try {
      const valRes = await fetch("/api/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ objective: objective.trim() }),
      });
      const valData = await valRes.json();

      if (!valRes.ok) {
        setError(valData.error || "Invalid objective.");
        setPhase("idle");
        return;
      }

      // Phase 2: Start run
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
    } catch {
      setError("Failed to connect. Check your connection and try again.");
      setPhase("idle");
    }
  };

  const handleCancel = () => {
    setPhase("idle");
    setError("");
  };

  const buttonLabel =
    phase === "validating"
      ? "Validating..."
      : phase === "starting"
      ? "Starting research..."
      : "Start Research";

  return (
    <main className="max-w-3xl mx-auto px-6 py-12">
      <header className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold mb-1">Koya Lead Studio</h1>
          <p className="text-gray-500 text-sm">AI-powered lead research and outreach</p>
        </div>
        {user && (
          <div className="flex items-center gap-3 text-sm">
            <span className="text-gray-500">
              {user.display_name} <span className="text-gray-400">({user.role})</span>
            </span>
            <span className="text-gray-400">|</span>
            <button onClick={handleLogout} className="text-blue-600 hover:underline">
              Logout
            </button>
          </div>
        )}
      </header>

      {canCreateRuns && (
        <div className="mb-10">
          <label className="block text-sm font-medium mb-2">
            Qualification Objective
          </label>
          <textarea
            className="w-full border rounded-lg p-3 text-sm min-h-[100px] focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
            placeholder={'e.g. "Find 10 US B2B SaaS companies with 10 to 100 employees that may need AI automation support."'}
            value={objective}
            onChange={(e) => {
              setObjective(e.target.value);
              if (error) setError("");
            }}
            disabled={phase !== "idle"}
          />
          <p className="text-xs text-gray-500 mt-2">
            Include industry, geography, and company size. Maximum 10 qualified leads per run.
          </p>

          <div className="flex items-center gap-3 mt-3">
            <button
              onClick={handleSubmit}
              disabled={!objective.trim() || phase !== "idle"}
              className="px-6 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-blue-700 transition-colors"
            >
              {buttonLabel}
            </button>
            {phase !== "idle" && (
              <button
                onClick={handleCancel}
                className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
              >
                Cancel
              </button>
            )}
          </div>

          {error && (
            <div className="mt-3 text-sm text-red-400 bg-red-950/30 border border-red-800/50 rounded-lg p-3">
              {error}
            </div>
          )}
        </div>
      )}

      {runs.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-3">Past Runs</h2>
          <div className="space-y-2">
            {runs.map((run) => (
              <button
                key={run.id}
                onClick={() => router.push(`/runs/${run.id}`)}
                className="w-full text-left border rounded-lg p-4 hover:bg-gray-50 dark:hover:bg-gray-900 transition-colors"
              >
                <div className="flex justify-between items-start">
                  <p className="text-sm font-medium truncate pr-4">{run.objective}</p>
                  <span className={`text-xs px-2 py-1 rounded-full whitespace-nowrap ${statusBadgeClass(run.status)}`}>
                    {run.status}
                  </span>
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  {new Date(run.created_at).toLocaleString()}
                </p>
              </button>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
