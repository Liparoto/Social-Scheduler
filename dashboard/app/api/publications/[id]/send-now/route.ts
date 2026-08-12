import { NextResponse } from "next/server";
import { sendPublicationNow } from "@/lib/queries";

export const runtime = "nodejs";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ok = sendPublicationNow(Number(id));
  if (!ok) {
    return NextResponse.json(
      {
        error:
          "This send isn't waiting on a retry — only one the worker has deferred can be sent now.",
      },
      { status: 409 }
    );
  }
  return NextResponse.json({ ok: true });
}
