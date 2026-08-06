import { NextResponse } from "next/server";
import { getInsightsChannel, requestInsightsRefresh } from "@/lib/insights-queries";

export const runtime = "nodejs";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const channelId = Number(id);
  if (!Number.isInteger(channelId)) {
    return NextResponse.json({ error: "Invalid channel id." }, { status: 400 });
  }
  if (!getInsightsChannel(channelId)) {
    return NextResponse.json({ error: "Channel not found." }, { status: 404 });
  }
  // Raises a flag for the worker; the dashboard never calls the Graph API itself.
  requestInsightsRefresh(channelId);
  return NextResponse.json({ ok: true });
}
