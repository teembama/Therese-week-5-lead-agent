"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

interface Run {
  id: string;
  objective: string;
  status: string;
  created_at: string;
}

export default function Home() {
  const [objective, setObjective] = useState("");
  const [loading, setLoading] = useState(false);
  const [runs, setRuns] = useState<Run[]>([]);
  const router = useRouter();

  useEffect(() => {
    fetch("/api/runs")
      .then((r) => r.json())
      .then(setRuns)
      .catch(console.error);
  }, []);

  const handleSubmit = async () => {
    if (!objective.trim() || loading) return;
    setLoading(true);

    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ objective: objective.trim() }),
      });
      const data = await res.json();
      if (data.run_id) {
        router.push(`/runs/${data.run_id}`);
      }
    } catch (err) {
      console.error("Failed to start run:", err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="max-w-3xl mx-auto px-6 py-12">
      <h1 className="text-2xl font-bold mb-2">Koya Lead Studio</h1>
      <p className="text-gray-600 mb-8">Research. Qualify. Personalize.</p>

      <div className="mb-10">
        <label className="block text-sm font-medium mb-2">
          Qualification Objective
        </label>
        <textarea
          className="w-full border rounded-lg p-3 text-sm min-h-[100px] focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="e.g. Find 10 US B2B SaaS companies with 10 to 100 employees that may need AI automation support."
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          disabled={loading}
        />
        <button
          onClick={handleSubmit}
          disabled={!objective.trim() || loading}
          className="mt-3 px-6 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-blue-700 transition-colors"
        >
          {loading ? "Running agent..." : "Start Research"}
        </button>
      </div>

      {runs.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-3">Past Runs</h2>
          <div className="space-y-2">
            {runs.map((run) => (
              <button
                key={run.id}
                onClick={() => router.push(`/runs/${run.id}`)}
                className="w-full text-left border rounded-lg p-4 hover:bg-gray-50 transition-colors"
              >
                <div className="flex justify-between items-start">
                  <p className="text-sm font-medium truncate pr-4">
                    {run.objective}
                  </p>
                  <span
                    className={`text-xs px-2 py-1 rounded-full whitespace-nowrap ${
                      run.status === "completed"
                        ? "bg-green-100 text-green-800"
                        : run.status === "failed"
                        ? "bg-red-100 text-red-800"
                        : "bg-yellow-100 text-yellow-800"
                    }`}
                  >
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
