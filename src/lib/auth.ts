import { cookies } from "next/headers";
import { supabase } from "./supabase";
import bcrypt from "bcryptjs";

interface User {
  id: string;
  username: string;
  role: string;
  display_name: string;
}

const SESSION_COOKIE = "koya_session";
const SESSION_MAX_AGE = 60 * 60 * 24; // 24 hours

export async function login(username: string, password: string): Promise<User | null> {
  const { data: user } = await supabase
    .from("users")
    .select("id, username, password_hash, role, display_name")
    .eq("username", username.toLowerCase().trim())
    .single();

  if (!user) return null;

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return null;

  // Create a simple session token: base64(userId:timestamp:role)
  const token = Buffer.from(`${user.id}:${Date.now()}:${user.role}`).toString("base64");

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE,
    path: "/",
  });

  return { id: user.id, username: user.username, role: user.role, display_name: user.display_name };
}

export async function getSession(): Promise<User | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  try {
    const decoded = Buffer.from(token, "base64").toString();
    const [userId, timestamp] = decoded.split(":");

    // Check session age
    const age = Date.now() - parseInt(timestamp);
    if (age > SESSION_MAX_AGE * 1000) return null;

    const { data: user } = await supabase
      .from("users")
      .select("id, username, role, display_name")
      .eq("id", userId)
      .single();

    return user || null;
  } catch {
    return null;
  }
}

export async function logout() {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}

export function requireRole(user: User | null, allowed: string[]): boolean {
  if (!user) return false;
  return allowed.includes(user.role);
}
