import { NextRequest, NextResponse } from "next/server";
import { login } from "@/lib/auth";

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const { username, password } = body;

  if (!username || !password || typeof username !== "string" || typeof password !== "string") {
    return NextResponse.json({ error: "Username and password are required." }, { status: 400 });
  }

  let user;
  try {
    user = await login(username, password);
  } catch (err) {
    console.error("Login failed:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "Sign-in is temporarily unavailable. Please try again later." },
      { status: 500 }
    );
  }

  if (!user) {
    return NextResponse.json({ error: "Invalid username or password." }, { status: 401 });
  }

  return NextResponse.json({
    user: { id: user.id, username: user.username, role: user.role, display_name: user.display_name },
  });
}
