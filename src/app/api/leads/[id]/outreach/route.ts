import { NextRequest, NextResponse } from "next/server";
import { getSession, requireRole } from "@/lib/auth";

// POST /api/leads/[id]/outreach — draft outreach for a qualified lead that has none (a retry
// after generation failed during promotion). See src/lib/promoted-outreach.ts.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  if (!requireRole(user, ["reviewer", "admin"])) {
    return NextResponse.json({ error: "Only reviewers can generate outreach." }, { status: 403 });
  }

  const { id } = await params;
  const { generatePromotedOutreach, productionOutreachDeps } = await import("@/lib/promoted-outreach");
  try {
    const result = await generatePromotedOutreach(productionOutreachDeps(), id);
    if (result.status === "exists") {
      return NextResponse.json({ error: "This lead already has outreach drafts.", status: "exists" }, { status: 409 });
    }
    if (result.status === "failed") {
      return NextResponse.json({ error: result.error, status: "failed" }, { status: result.httpStatus });
    }
    return NextResponse.json({ status: "generated" });
  } catch (err) {
    console.error(`Outreach generation crashed for lead ${id}:`, err);
    return NextResponse.json({ error: "Outreach generation failed. Please try again.", status: "failed" }, { status: 500 });
  }
}
