import { NextResponse } from "next/server";
import { deletePublication } from "@/lib/queries";

export const runtime = "nodejs";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ok = deletePublication(Number(id));
  if (!ok) {
    return NextResponse.json(
      { error: "Only a not-yet-posted send can be deleted." },
      { status: 409 }
    );
  }
  return NextResponse.json({ ok: true });
}
