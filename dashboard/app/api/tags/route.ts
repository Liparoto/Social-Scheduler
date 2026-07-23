import { NextResponse } from "next/server";
import { listTags, createTopicTag } from "@/lib/queries";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const kind = new URL(req.url).searchParams.get("kind");
  if (kind && kind !== "topic" && kind !== "time_of_day") {
    return NextResponse.json({ error: "kind must be topic or time_of_day." }, { status: 400 });
  }
  return NextResponse.json(listTags(kind as "topic" | "time_of_day" | undefined));
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "name is required." }, { status: 400 });
  }
  return NextResponse.json(createTopicTag(name), { status: 201 });
}
