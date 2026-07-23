import { NextResponse } from "next/server";
import { requestMetricsRefreshAll } from "@/lib/queries";

export const runtime = "nodejs";

export async function POST() {
  const requested = requestMetricsRefreshAll();
  return NextResponse.json({ requested });
}
