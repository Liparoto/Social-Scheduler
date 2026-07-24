import { NextResponse } from "next/server";
import { holdPublication } from "@/lib/queries";

export const runtime = "nodejs";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ok = holdPublication(Number(id));
  if (!ok) {
    return NextResponse.json(
      { error: "Only a scheduled or awaiting-approval send can be held." },
      { status: 409 }
    );
  }
  return NextResponse.json({ ok: true });
}
