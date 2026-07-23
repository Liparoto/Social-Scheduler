import { NextResponse } from "next/server";
import { retryPublication } from "@/lib/queries";

export const runtime = "nodejs";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ok = retryPublication(Number(id));
  if (!ok) {
    return NextResponse.json(
      { error: "Only a failed publication can be retried." },
      { status: 409 }
    );
  }
  return NextResponse.json({ ok: true });
}
