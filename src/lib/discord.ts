// Discord webhook notifications (optional). With DISCORD_WEBHOOK_URL unset, every function here
// is a no-op. Nothing here ever throws: a failed notification is logged and the app carries on.

import { supabase } from "./supabase";

const COLOR_GREEN = 0x3fa66a;
const COLOR_ROSE = 0xc0647b;
const TIMEOUT_MS = 5000;

export interface DiscordEmbed {
  title: string;
  url?: string;
  color: number;
  fields: { name: string; value: string; inline?: boolean }[];
  timestamp?: string;
}

interface SendOptions {
  webhookUrl?: string;
  fetch?: typeof fetch;
}

function webhookUrl(): string | undefined {
  return process.env.DISCORD_WEBHOOK_URL?.trim() || undefined;
}

export function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

// Public address of the app, for links in notifications: APP_URL, else Railway's public domain
export function appBaseUrl(fallback?: string): string | null {
  const explicit = process.env.APP_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (railway) return `https://${railway}`;
  return fallback ? fallback.replace(/\/+$/, "") : null;
}

export function runUrl(runId: string, fallbackBase?: string): string | null {
  const base = appBaseUrl(fallbackBase);
  return base ? `${base}/runs/${runId}` : null;
}

// Discord limits: field values 1024 characters, empty values are rejected
function field(name: string, value: string, inline = false) {
  return { name, value: truncate(value || "—", 1024), inline };
}

function linkField(runId: string, url: string | null) {
  return field("Run", url ? `[Open run](${url})` : `\`${runId}\``);
}

export function runCompletedEmbed(data: {
  runId: string;
  objective: string;
  qualified: number;
  awaitingReview: number;
  createdBy: string;
  url: string | null;
}): DiscordEmbed {
  return {
    title: "Research run completed",
    ...(data.url ? { url: data.url } : {}),
    color: COLOR_GREEN,
    fields: [
      field("Objective", truncate(data.objective, 200)),
      field("Qualified leads", String(data.qualified), true),
      field("Awaiting review", String(data.awaitingReview), true),
      field("Created by", data.createdBy, true),
      linkField(data.runId, data.url),
    ],
    timestamp: new Date().toISOString(),
  };
}

export function leadPromotedEmbed(data: {
  runId: string;
  companyName: string;
  promotedBy: string;
  reason?: string | null;
  url: string | null;
}): DiscordEmbed {
  return {
    title: "Lead promoted to qualified",
    ...(data.url ? { url: data.url } : {}),
    color: COLOR_ROSE,
    fields: [
      field("Company", data.companyName, true),
      field("Promoted by", data.promotedBy, true),
      ...(data.reason?.trim() ? [field("Reason", data.reason)] : []),
      linkField(data.runId, data.url),
    ],
    timestamp: new Date().toISOString(),
  };
}

// Posts one embed. Returns whether it was delivered; never throws.
export async function sendDiscordEmbed(embed: DiscordEmbed, options: SendOptions = {}): Promise<boolean> {
  const url = options.webhookUrl ?? webhookUrl();
  if (!url) return false;
  const doFetch = options.fetch ?? fetch;
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Text in the embed comes from users and the agent: never let it ping anyone
      body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`Discord notification failed: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    // The webhook URL is a secret, so only the error's message is logged
    console.error("Discord notification failed:", err instanceof Error ? err.message : String(err));
    return false;
  }
}

// Called when a run's process ends; notifies only if the run's final status is "completed"
export async function notifyRunCompleted(runId: string): Promise<void> {
  if (!webhookUrl()) return;
  try {
    const { data: run, error } = await supabase
      .from("lead_runs")
      .select("id, objective, status, user_id")
      .eq("id", runId)
      .single();
    if (error || !run || run.status !== "completed") return;

    const [leads, owner] = await Promise.all([
      supabase.from("leads").select("qualification_status").eq("run_id", runId),
      run.user_id
        ? supabase.from("users").select("username").eq("id", run.user_id).single()
        : Promise.resolve({ data: null }),
    ]);
    const statuses = (leads.data ?? []).map((l: { qualification_status: string }) => l.qualification_status);

    await sendDiscordEmbed(
      runCompletedEmbed({
        runId,
        objective: run.objective ?? "",
        qualified: statuses.filter((s) => s === "qualified").length,
        awaitingReview: statuses.filter((s) => s === "needs_review").length,
        createdBy: (owner.data as { username?: string } | null)?.username ?? "unknown",
        url: runUrl(runId),
      })
    );
  } catch (err) {
    console.error(`Discord run-completed notification for run ${runId} failed:`, err instanceof Error ? err.message : String(err));
  }
}

export async function notifyLeadPromoted(data: {
  runId: string;
  companyName: string;
  promotedBy: string;
  reason?: string | null;
  // Used for the link when APP_URL / RAILWAY_PUBLIC_DOMAIN are not set
  requestOrigin?: string;
}): Promise<void> {
  if (!webhookUrl()) return;
  await sendDiscordEmbed(leadPromotedEmbed({ ...data, url: runUrl(data.runId, data.requestOrigin) }));
}
