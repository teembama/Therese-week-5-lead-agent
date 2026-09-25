// Run lifecycle states. "running" is the only non-terminal state; a run leaves it exactly once.
// Shared by the API routes, the agent runtime and the UI (safe to import from client components).

export const RUN_STATUSES = ["running", "completed", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

// Stored as the run's user-facing message when a user cancels it
export const CANCEL_MESSAGE = "Cancelled by user. Any leads found before cancelling are saved.";

export function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === "string" && (RUN_STATUSES as readonly string[]).includes(value);
}

// Tailwind classes for status badges (design tokens from src/app/globals.css)
export function statusBadgeClass(status: string): string {
  switch (status) {
    case "completed":
      return "bg-success-soft text-success";
    case "failed":
      return "bg-danger-soft text-danger";
    case "cancelled":
      return "bg-neutral-soft text-neutral";
    default:
      return "bg-rose-soft text-rose-deep";
  }
}
