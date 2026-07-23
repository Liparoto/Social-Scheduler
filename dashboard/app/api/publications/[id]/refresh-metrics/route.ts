import { NextResponse } from "next/server";
import { requestMetricsRefresh } from "@/lib/queries";

export const runtime = "nodejs";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = requestMetricsRefresh(Number(id));
  if (result === "not_found") {
    return NextResponse.json({ error: "Publication not found." }, { status: 404 });
  }
  if (result === "not_posted") {
    return NextResponse.json(
      { error: "Only posted (non-dry-run) publications can refresh metrics." },
      { status: 400 }
    );
  }
  return NextResponse.json({ ok: true });
}
