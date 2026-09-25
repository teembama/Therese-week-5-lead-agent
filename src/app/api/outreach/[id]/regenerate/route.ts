import { NextRequest, NextResponse } from "next/server";
import { getSession, requireRole } from "@/lib/auth";
import { requestRegeneration } from "@/lib/outreach-review";
import { productionReviewDeps } from "@/lib/outreach-review-deps";

// POST /api/outreach/[id]/regenerate — researcher regenerates rejected outreach with a
// Haiku-checked direction (at most once per lead). Body: { direction, validate_only?: true,
// validation_token? }. See src/lib/outreach-review.ts and src/lib/promoted-outreach.ts.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  if (!requireRole(user, ["researcher", "admin"])) {
    return NextResponse.json({ error: "Only researchers can regenerate outreach." }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { id } = await params;
  try {
    const result = await requestRegeneration(productionReviewDeps(req.nextUrl.origin), id, user, body);
    return NextResponse.json(result.body, { status: result.httpStatus });
  } catch (err) {
    console.error(`Outreach regeneration failed for ${id}:`, err);
    const message = err instanceof Error && err.message.startsWith("This action needs a database update") ? err.message : "Could not regenerate the outreach. Please try again.";
    return NextResponse.json({ error: message }, { status: message.startsWith("This action") ? 503 : 500 });
  }
}
