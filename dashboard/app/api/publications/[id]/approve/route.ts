import { NextResponse } from "next/server";
import { approvePublication } from "@/lib/queries";

export const runtime = "nodejs";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ok = approvePublication(Number(id));
  if (!ok) {
    return NextResponse.json(
      { error: "Only a publication awaiting approval can be approved." },
      { status: 409 }
    );
  }
  return NextResponse.json({ ok: true });
}
