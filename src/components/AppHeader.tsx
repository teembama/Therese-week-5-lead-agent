"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

interface SessionUser {
  username: string;
  role: string;
  display_name: string;
}

export function AppHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const onLogin = pathname?.startsWith("/login");

  useEffect(() => {
    if (onLogin) return;
    fetch("/api/auth/session")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setUser(data?.user ?? null))
      .catch(() => setUser(null));
  }, [onLogin, pathname]);

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    setUser(null);
    router.push("/login");
    router.refresh();
  };

  return (
    <header className="border-b border-line bg-canvas/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-6">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="text-[15px] font-semibold tracking-tight text-ink">Koya Lead Studio</span>
          <span className="hidden h-1.5 w-1.5 translate-y-[-2px] rounded-full bg-rose sm:inline-block" aria-hidden="true" />
        </Link>
        {!onLogin && user && (
          <div className="flex items-center gap-4 text-sm">
            <span className="hidden text-muted sm:inline">
              {user.display_name}
              <span className="ml-1.5 rounded-full bg-neutral-soft px-2 py-0.5 text-xs text-neutral">{user.role}</span>
            </span>
            <button onClick={handleLogout} className="font-medium text-rose-deep hover:text-rose-deeper">
              Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
