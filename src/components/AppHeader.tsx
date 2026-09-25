"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Button, Modal } from "@/components/ui";

interface SessionUser {
  username: string;
  role: string;
  display_name: string;
}

export function AppHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const onLogin = pathname?.startsWith("/login");

  useEffect(() => {
    if (onLogin) return;
    fetch("/api/auth/session")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setUser(data?.user ?? null))
      .catch(() => setUser(null));
  }, [onLogin, pathname]);

  const handleLogout = async () => {
    setSigningOut(true);
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    setSigningOut(false);
    setConfirmingSignOut(false);
    setUser(null);
    router.push("/login");
    router.refresh();
  };

  return (
    <>
      <header className="border-b border-line bg-canvas/90 backdrop-blur">
        <div className="flex h-16 w-full items-center justify-between px-6 sm:px-8 lg:px-10">
          <div className="flex items-center gap-8">
            <Link href="/" className="flex items-baseline gap-2">
              <span className="text-[15px] font-semibold tracking-tight text-ink">Koya Lead Studio</span>
              <span className="hidden h-1.5 w-1.5 translate-y-[-2px] rounded-full bg-rose sm:inline-block" aria-hidden="true" />
            </Link>
            {!onLogin && (
              <nav aria-label="Main">
                <Link
                  href="/"
                  aria-current={pathname === "/" ? "page" : undefined}
                  className={`relative text-sm font-medium transition-colors ${
                    pathname === "/" ? "text-ink" : "text-muted hover:text-ink"
                  }`}
                >
                  Dashboard
                  {pathname === "/" && (
                    <span className="absolute -bottom-[22px] left-0 right-0 h-0.5 rounded-full bg-rose" aria-hidden="true" />
                  )}
                </Link>
              </nav>
            )}
          </div>
          {!onLogin && user && (
            <div className="flex items-center gap-4 text-sm">
              <span className="hidden text-muted sm:inline">
                {user.display_name}
                <span className="ml-1.5 rounded-full bg-neutral-soft px-2 py-0.5 text-xs text-neutral">{user.role}</span>
              </span>
              <button onClick={() => setConfirmingSignOut(true)} className="font-medium text-rose-deep hover:text-rose-deeper">
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Outside the header: its backdrop-filter would otherwise contain the fixed-position modal */}
      {confirmingSignOut && (
        <Modal title="Sign out" onClose={() => setConfirmingSignOut(false)} busy={signingOut}>
          <p className="text-sm leading-relaxed text-muted">Sign out of Koya Lead Studio?</p>
          <div className="mt-6 flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => setConfirmingSignOut(false)} disabled={signingOut}>
              Cancel
            </Button>
            <Button size="sm" variant="danger" onClick={handleLogout} disabled={signingOut}>
              {signingOut ? "Signing out…" : "Sign out"}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
