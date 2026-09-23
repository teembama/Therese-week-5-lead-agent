import { createHmac, timingSafeEqual } from "crypto";
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
const MIN_SECRET_LENGTH = 32;

// No fallback secret: a missing or weak SESSION_SECRET must fail closed.
function getSecret(): string | null {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) return null;
  return secret;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

// Token format: base64(userId:timestamp:role):hmac_signature
// The signature covers the base64 payload. Neither part can contain ":".
function createToken(userId: string, role: string, secret: string): string {
  const payload = Buffer.from(`${userId}:${Date.now()}:${role}`).toString("base64");
  return `${payload}:${sign(payload, secret)}`;
}

function verifyToken(
  token: string,
  secret: string
): { userId: string; timestamp: number; role: string } | null {
  const parts = token.split(":");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;

  const expected = Buffer.from(sign(payload, secret));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return null;
  }

  const [userId, timestamp, role, ...rest] = Buffer.from(payload, "base64")
    .toString()
    .split(":");
  const issuedAt = Number(timestamp);
  if (!userId || !role || rest.length > 0 || !Number.isInteger(issuedAt)) return null;

  return { userId, timestamp: issuedAt, role };
}

export async function login(username: string, password: string): Promise<User | null> {
  const secret = getSecret();
  if (!secret) {
    throw new Error(`SESSION_SECRET must be set (at least ${MIN_SECRET_LENGTH} characters)`);
  }

  const { data: user } = await supabase
    .from("users")
    .select("id, username, password_hash, role, display_name")
    .eq("username", username.toLowerCase().trim())
    .single();

  if (!user) return null;

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return null;

  const token = createToken(user.id, user.role, secret);

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

  const secret = getSecret();
  if (!secret) return null;

  try {
    const session = verifyToken(token, secret);
    if (!session) return null;

    // Check session age (and reject timestamps from the future)
    const age = Date.now() - session.timestamp;
    if (age < 0 || age > SESSION_MAX_AGE * 1000) return null;

    const { data: user } = await supabase
      .from("users")
      .select("id, username, role, display_name")
      .eq("id", session.userId)
      .single();

    // A role change since login invalidates the session
    if (!user || user.role !== session.role) return null;

    return user;
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
