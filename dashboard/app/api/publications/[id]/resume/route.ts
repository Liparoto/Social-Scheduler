import { NextResponse } from "next/server";
import { resumePublication } from "@/lib/queries";

export const runtime = "nodejs";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ok = resumePublication(Number(id));
  if (!ok) {
    return NextResponse.json(
      { error: "This send isn't currently held." },
      { status: 409 }
    );
  }
  return NextResponse.json({ ok: true });
}
