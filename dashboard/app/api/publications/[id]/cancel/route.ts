import { NextResponse } from "next/server";
import { cancelPublication } from "@/lib/queries";

export const runtime = "nodejs";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ok = cancelPublication(Number(id));
  if (!ok) {
    return NextResponse.json(
      { error: "Only a scheduled or awaiting-approval send can be canceled." },
      { status: 409 }
    );
  }
  return NextResponse.json({ ok: true });
}
