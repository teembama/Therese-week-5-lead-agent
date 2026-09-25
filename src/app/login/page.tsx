"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button } from "@/components/ui";

const inputClass =
  "w-full rounded-lg border border-line-strong bg-surface px-3.5 py-2.5 text-sm text-ink placeholder:text-muted/70 focus:border-rose focus:outline-none focus:ring-2 focus:ring-rose/20 disabled:opacity-50";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    if (!username.trim() || !password) {
      setError("Username and password are required.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Sign in failed. Please try again.");
        setLoading(false);
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setError("Failed to connect. Check your connection and try again.");
      setLoading(false);
    }
  };

  return (
    <main className="mx-auto w-full max-w-sm px-6 py-20 sm:py-28">
      <h1 className="text-3xl font-semibold tracking-tight">Welcome back</h1>
      <p className="mt-2 text-sm text-muted">Sign in to research leads and review outreach.</p>

      <form onSubmit={handleSubmit} className="mt-10 space-y-5" noValidate>
        <div>
          <label htmlFor="username" className="mb-1.5 block text-sm font-medium">
            Username
          </label>
          <input
            id="username"
            type="text"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              if (error) setError("");
            }}
            disabled={loading}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="password" className="mb-1.5 block text-sm font-medium">
            Password
          </label>
          <div className="relative">
            <input
              id="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (error) setError("");
              }}
              disabled={loading}
              className={`${inputClass} pr-11`}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              disabled={loading}
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
              className="absolute inset-y-0 right-0 flex items-center px-3 text-muted hover:text-ink disabled:opacity-50"
            >
              {showPassword ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                  <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                  <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              )}
            </button>
          </div>
        </div>

        {error && <Alert tone="danger">{error}</Alert>}

        <Button type="submit" variant="primary" disabled={loading} className="w-full">
          {loading ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </main>
  );
}
