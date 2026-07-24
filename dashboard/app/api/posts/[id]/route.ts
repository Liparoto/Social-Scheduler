import { NextResponse } from "next/server";
import { deletePost } from "@/lib/queries";

export const runtime = "nodejs";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = deletePost(Number(id));

  if (result === "not_found") {
    return NextResponse.json({ error: "Post not found." }, { status: 404 });
  }
  if (result === "has_live") {
    return NextResponse.json(
      {
        error:
          "This post has sends already posted to Instagram — delete is blocked to protect their records (the Instagram post stays live).",
      },
      { status: 409 }
    );
  }
  return NextResponse.json({ ok: true });
}
