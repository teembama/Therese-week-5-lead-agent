"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

// Small shared UI pieces so every page uses the same tokens (see src/app/globals.css).

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "success";

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: "bg-rose-deep text-white hover:bg-rose-deeper border border-rose-deep",
  secondary: "bg-surface text-ink border border-line-strong hover:border-ink/40",
  ghost: "bg-transparent text-muted hover:text-ink border border-transparent",
  danger: "bg-surface text-danger border border-danger/40 hover:bg-danger-soft",
  success: "bg-surface text-success border border-success/40 hover:bg-success-soft",
};

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md" }) {
  const sizing = size === "sm" ? "px-3 py-1.5 text-xs" : "px-5 py-2.5 text-sm";
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${sizing} ${BUTTON_STYLES[variant]} ${className}`}
    />
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-line bg-surface ${className}`}>{children}</div>;
}

// Eyebrow label above a section
export function Label({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`text-[11px] font-semibold uppercase tracking-[0.12em] text-muted ${className}`}>{children}</p>;
}

const BADGE_STYLES: Record<string, string> = {
  completed: "bg-success-soft text-success",
  qualified: "bg-success-soft text-success",
  approved: "bg-success-soft text-success",
  failed: "bg-danger-soft text-danger",
  cancelled: "bg-neutral-soft text-neutral",
  needs_review: "bg-warning-soft text-warning",
  running: "bg-rose-soft text-rose-deep",
  draft: "bg-neutral-soft text-neutral",
};

const BADGE_LABELS: Record<string, string> = { needs_review: "needs review" };

export function Badge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${
        BADGE_STYLES[status] ?? "bg-neutral-soft text-neutral"
      }`}
    >
      {status === "running" && <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-rose koya-pulse" aria-hidden="true" />}
      {BADGE_LABELS[status] ?? status}
    </span>
  );
}

type Tone = "danger" | "warning" | "neutral" | "success";

const ALERT_STYLES: Record<Tone, string> = {
  danger: "bg-danger-soft text-danger border-danger/20",
  warning: "bg-warning-soft text-warning border-warning/20",
  neutral: "bg-neutral-soft text-neutral border-neutral/15",
  success: "bg-success-soft text-success border-success/20",
};

// Errors are announced to screen readers (role="alert"); other notes are polite status messages
export function Alert({ tone = "danger", children, className = "" }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={`rounded-lg border px-4 py-3 text-sm leading-relaxed ${ALERT_STYLES[tone]} ${className}`}
    >
      {children}
    </div>
  );
}

// Only http(s) links are rendered as links: URLs here come from the agent and scraped pages
export function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export function ExternalLink({ url, children }: { url: string; children?: ReactNode }) {
  const href = safeHref(url);
  if (!href) return <span className="break-all text-muted">{children ?? url}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="break-all text-rose-deep underline decoration-rose/40 underline-offset-2 hover:decoration-rose-deep"
    >
      {children ?? url}
    </a>
  );
}

export function Modal({
  title,
  onClose,
  busy = false,
  children,
}: {
  title: string;
  onClose: () => void;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 px-4 backdrop-blur-[2px]"
      onClick={busy ? undefined : onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-lg rounded-2xl border border-line bg-surface p-6 shadow-[0_20px_60px_-20px_rgb(26_26_26/0.25)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}
