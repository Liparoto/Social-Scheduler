import { NextRequest, NextResponse } from "next/server";
import { listAssetsWithUsage } from "@/lib/queries";

export const runtime = "nodejs";

/**
 * The library, for the "choose an existing file" picker. Browser-facing, so the field
 * list is deliberately narrow: no storage_path, no content_hash, no public_url.
 *
 * `exclude` drops the slides a post already has, so the picker never offers a file that
 * would come straight back as "already_on_post".
 */
export async function GET(req: NextRequest) {
  // A stray double comma ("1,,3") splits to an empty string, and Number("") is 0 — which
  // passes Number.isInteger — so filtering on isInteger alone would silently exclude asset
  // id 0. Require a positive integer instead; ids start at 1, so this also naturally
  // rejects the empty-string case.
  const exclude = new Set(
    (req.nextUrl.searchParams.get("exclude") ?? "")
      .split(",")
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0)
  );
  const assets = listAssetsWithUsage()
    .filter((a) => !exclude.has(a.id))
    .map((a) => ({
      id: a.id,
      media_kind: a.media_kind,
      original_filename: a.original_filename,
      cover_frame_ms: a.cover_frame_ms,
    }));
  return NextResponse.json({ assets });
}
