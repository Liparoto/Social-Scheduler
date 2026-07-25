import { NextRequest, NextResponse } from "next/server";
import { createChannel, getChannels } from "@/lib/queries";
import { isPlatform, PLATFORMS } from "@/lib/platforms";

export const runtime = "nodejs";

export function GET() {
  return NextResponse.json({ channels: getChannels() });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const account_name = (body.account_name || "").trim();
  const platform = body.platform;
  if (!account_name) {
    return NextResponse.json({ error: "Account name is required." }, { status: 400 });
  }
  if (!isPlatform(platform)) {
    return NextResponse.json(
      { error: `Platform must be one of: ${PLATFORMS.map((p) => p.value).join(", ")}.` },
      { status: 400 }
    );
  }
  if (
    body.color_hue !== undefined &&
    body.color_hue !== null &&
    (!Number.isInteger(body.color_hue) || body.color_hue < 0 || body.color_hue > 360)
  ) {
    return NextResponse.json(
      { error: "color_hue must be null or an integer between 0 and 360." },
      { status: 400 }
    );
  }
  const id = createChannel({
    platform,
    account_name,
    business_label: body.business_label,
    timezone: body.timezone || "UTC",
    remote_account_id: body.remote_account_id,
    linked_page_id: body.linked_page_id,
    access_token: body.access_token,
    requires_approval: !!body.requires_approval,
    color_hue: body.color_hue ?? null,
  });
  return NextResponse.json({ id }, { status: 201 });
}
