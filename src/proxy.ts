import { NextRequest, NextResponse } from "next/server";

// Next.js 16 renamed the `middleware` convention to `proxy`
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow auth routes and static files
  if (
    pathname.startsWith("/login") ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon")
  ) {
    return NextResponse.next();
  }

  // Check for session cookie
  const session = request.cookies.get("koya_session");
  if (!session) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
