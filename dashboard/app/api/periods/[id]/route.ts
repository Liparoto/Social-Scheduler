import { NextRequest, NextResponse } from "next/server";
import { deletePeriod, getPeriod, updatePeriod } from "@/lib/queries";

export const runtime = "nodejs";

const MONTH_FIELDS = ["start_month", "end_month"] as const;
const DAY_FIELDS = ["start_day", "end_day"] as const;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const periodId = Number(id);
  if (!getPeriod(periodId)) {
    return NextResponse.json({ error: "Period not found." }, { status: 404 });
  }
  const body = await req.json();
  const fields: Record<string, unknown> = {};

  if (typeof body.name === "string") {
    const name = body.name.trim();
    if (!name) {
      return NextResponse.json({ error: "Name cannot be empty." }, { status: 400 });
    }
    fields.name = name;
  }
  if ("recurs_yearly" in body) {
    fields.recurs_yearly = body.recurs_yearly ? 1 : 0;
  }
  for (const key of MONTH_FIELDS) {
    if (key in body) {
      const v = Number(body[key]);
      if (!Number.isInteger(v) || v < 1 || v > 12) {
        return NextResponse.json({ error: `${key} must be 1-12.` }, { status: 400 });
      }
      fields[key] = v;
    }
  }
  for (const key of DAY_FIELDS) {
    if (key in body) {
      const v = Number(body[key]);
      if (!Number.isInteger(v) || v < 1 || v > 31) {
        return NextResponse.json({ error: `${key} must be 1-31.` }, { status: 400 });
      }
      fields[key] = v;
    }
  }
  if ("start_date" in body) {
    if (!ISO_DATE.test(body.start_date)) {
      return NextResponse.json(
        { error: "start_date must be ISO YYYY-MM-DD." },
        { status: 400 }
      );
    }
    fields.start_date = body.start_date;
  }
  if ("end_date" in body) {
    if (!ISO_DATE.test(body.end_date)) {
      return NextResponse.json(
        { error: "end_date must be ISO YYYY-MM-DD." },
        { status: 400 }
      );
    }
    fields.end_date = body.end_date;
  }

  updatePeriod(periodId, fields);
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const periodId = Number(id);
  const ok = deletePeriod(periodId);
  if (!ok) {
    return NextResponse.json({ error: "Period not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
