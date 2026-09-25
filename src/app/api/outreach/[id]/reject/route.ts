import { NextRequest, NextResponse } from "next/server";
import { getSession, requireRole } from "@/lib/auth";
import { rejectOutreach } from "@/lib/outreach-review";
import { productionReviewDeps } from "@/lib/outreach-review-deps";

// POST /api/outreach/[id]/reject — reviewer rejects a draft with a Haiku-checked reason.
// Body: { reason, validate_only?: true, validation_token? }. See src/lib/outreach-review.ts.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  if (!requireRole(user, ["reviewer", "admin"])) {
    return NextResponse.json({ error: "Only reviewers can reject outreach." }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { id } = await params;
  try {
    const result = await rejectOutreach(productionReviewDeps(req.nextUrl.origin), id, user, body);
    return NextResponse.json(result.body, { status: result.httpStatus });
  } catch (err) {
    console.error(`Outreach rejection failed for ${id}:`, err);
    const pending = err instanceof Error && err.message.startsWith("This action needs a database update");
    return NextResponse.json(
      { error: pending ? (err as Error).message : "Could not reject the outreach. Please try again." },
      { status: pending ? 503 : 500 }
    );
  }
}
