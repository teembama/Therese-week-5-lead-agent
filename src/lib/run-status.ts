// Run lifecycle states. "running" is the only non-terminal state; a run leaves it exactly once.
// Shared by the API routes, the agent runtime and the UI (safe to import from client components).

export const RUN_STATUSES = ["running", "completed", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

// Stored as the run's user-facing message when a user cancels it
export const CANCEL_MESSAGE = "Cancelled by user. Any leads found before cancelling are saved.";

export function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === "string" && (RUN_STATUSES as readonly string[]).includes(value);
}

// Tailwind classes for status badges
export function statusBadgeClass(status: string): string {
  switch (status) {
    case "completed":
      return "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400";
    case "failed":
      return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400";
    case "cancelled":
      return "bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-300";
    default:
      return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400";
  }
}
