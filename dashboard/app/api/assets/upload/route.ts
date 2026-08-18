import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { config } from "@/lib/config";
import { getAssetByHash, upsertAssetByHash } from "@/lib/queries";
import { conformImage, type ConformMode } from "@/lib/conform";
import { readVideoMeta, VideoParseError } from "@/lib/video-meta";
import { validateReel, classifyReelErrors, REEL_MIME_TYPES } from "@/lib/video-spec";
import { findConverter, convertVideo, ConvertError } from "@/lib/video-convert";
import { converterAdvice } from "@/lib/converter-advice";
import { IMAGE_EXT_BY_MIME, resolveUploadMime } from "@/lib/upload-mime";

export const runtime = "nodejs";

const THUMB_MAX = 480;

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided." }, { status: 400 });
  }
  // Read the bytes BEFORE deciding what this file is. `file.type` is supplied by the
  // browser from the OS, not read from the file — on Windows it comes from the registry,
  // and a machine with nothing registered for .webp sends "" for every one of them. Taking
  // it as final rejected genuine WebP files with 415. resolveUploadMime() keeps a declared
  // type we accept and otherwise falls back to the file's own magic bytes.
  const buf = Buffer.from(await file.arrayBuffer());
  const mime = resolveUploadMime(file.type, buf);
  const imageExt = mime ? IMAGE_EXT_BY_MIME[mime] : undefined;
  const videoExt = mime ? REEL_MIME_TYPES[mime] : undefined;
  if (!mime || (!imageExt && !videoExt)) {
    return NextResponse.json(
      { error: "Only JPEG, PNG or WebP images, and MP4 or MOV video, are supported." },
      { status: 415 }
    );
  }
  const ext = imageExt ?? videoExt;
  const isVideo = Boolean(videoExt);

  // Dedup by CONTENT HASH (not filename) — check before writing anything to disk.
  const hash = crypto.createHash("sha256").update(buf).digest("hex");
  const existing = getAssetByHash(hash);
  if (existing) {
    // Re-derive the Reels validator's non-blocking warnings (e.g. "no audio track",
    // letterbox) on dedup too — otherwise re-uploading the same silent/landscape video
    // shows the caution once and never again, even though it's still true every time.
    let warnings: string[] = [];
    if (existing.media_kind === "video") {
      try {
        const meta = readVideoMeta(buf);
        warnings = validateReel(meta, buf.length, mime).warnings;
      } catch {
        // Best-effort only — dedup already succeeded against a previously-validated
        // asset; a re-parse failure here shouldn't block reusing it.
      }
    }
    return NextResponse.json({ asset: existing, deduped: true, warnings });
  }

  // ---- Video: validate, converting when the spec allows it ----------------------
  // classifyReelErrors splits problems into `fatal` (too short/long — trimming is an
  // editorial call this app must never make, and no re-encode adds footage back) and
  // `convertible` (too wide/large/wrong container — a downscale/re-encode genuinely
  // fixes these). `fatal` is checked FIRST and returns immediately: a 15-minute 4K
  // video must be refused in milliseconds, not after a multi-minute transcode that
  // was always going to be refused anyway.
  if (isVideo) {
    let meta;
    try {
      meta = readVideoMeta(buf);
    } catch (err) {
      if (err instanceof VideoParseError) {
        return NextResponse.json({ error: err.message }, { status: 422 });
      }
      throw err;
    }

    const check = classifyReelErrors(meta, buf.length, mime);
    if (check.fatal.length > 0) {
      return NextResponse.json({ error: check.fatal.join(" ") }, { status: 422 });
    }

    const storageRel = `${hash}.${ext}`;

    if (check.convertible.length === 0) {
      // In spec already — today's path, unchanged: no conform derivative, publish_path
      // stays NULL, so the worker's existing _resolve_url precedence falls through to
      // storage_path with no worker change.
      await fs.mkdir(config.assetStorageDir, { recursive: true });
      await fs.writeFile(path.join(config.assetStorageDir, storageRel), buf);

      const { asset, deduped } = upsertAssetByHash({
        content_hash: hash,
        media_kind: "video",
        original_filename: file.name || null,
        storage_path: storageRel,
        public_url: config.publicAssetBaseUrl
          ? `${config.publicAssetBaseUrl.replace(/\/$/, "")}/${storageRel}`
          : null,
        // No thumbnail file: sharp cannot read video and ffmpeg is deliberately not a
        // dependency. Surfaces render a <video> element instead (design spec, Components).
        thumbnail_path: null,
        mime_type: mime,
        width: meta.width,
        height: meta.height,
        byte_size: buf.length,
        publish_path: null,
        duration_ms: meta.duration_ms,
        has_audio: meta.has_audio ? 1 : 0,
      });
      return NextResponse.json({ asset, deduped, warnings: check.warnings });
    }

    // Convertible: too wide, too large, or the wrong container. Try to fix it instead
    // of refusing footage the owner's phone recorded by default.
    const converter = findConverter(config.videoConverter);
    if (!converter) {
      return NextResponse.json(
        { error: `${check.convertible.join(" ")} ${converterAdvice(process.platform)}` },
        { status: 422 }
      );
    }

    const tmpStamp = `${hash}-${process.pid}-${Date.now()}`;
    const inputTmp = path.join(os.tmpdir(), `ss-convert-in-${tmpStamp}.${ext}`);
    const outputTmp = path.join(os.tmpdir(), `ss-convert-out-${tmpStamp}.mp4`);
    const cleanupTemps = async () => {
      await Promise.all([
        fs.rm(inputTmp, { force: true }),
        fs.rm(outputTmp, { force: true }),
      ]);
    };

    await fs.writeFile(inputTmp, buf);
    try {
      await convertVideo(inputTmp, outputTmp, {
        converter,
        timeoutMs: config.videoConvertTimeoutMs,
      });
    } catch (err) {
      await cleanupTemps();
      if (err instanceof ConvertError) {
        // Keep the raw ConvertError (temp file paths, the full converter command line)
        // server-side only — it's useful for debugging but is noise the owner shouldn't
        // have to read in an upload-failure toast. No secrets in it either way; this is
        // purely about signal-to-noise for the 422 body.
        console.error("Video conversion failed:", err.message);
        return NextResponse.json(
          { error: "Converting this video failed — it may be corrupt or in an unsupported format." },
          { status: 422 }
        );
      }
      throw err;
    }

    // Never trust the converter's output blindly — re-parse and re-validate the
    // derivative with the exact same checks the original went through.
    let derivBuf: Buffer;
    let derivMeta;
    try {
      derivBuf = await fs.readFile(outputTmp);
      derivMeta = readVideoMeta(derivBuf);
    } catch (err) {
      await cleanupTemps();
      // Same reasoning as above: log the real cause (absolute temp path, parse error)
      // server-side, return a short owner-facing message.
      console.error(
        "Conversion produced an unreadable derivative:",
        err instanceof VideoParseError ? err.message : String(err)
      );
      return NextResponse.json(
        { error: "Converting this video didn't produce a usable file. Please try a different video." },
        { status: 422 }
      );
    }
    const derivCheck = classifyReelErrors(derivMeta, derivBuf.length, "video/mp4");
    if (derivCheck.fatal.length > 0 || derivCheck.convertible.length > 0) {
      await cleanupTemps();
      return NextResponse.json(
        {
          error:
            `Conversion did not produce a usable video. ` +
            `${[...derivCheck.fatal, ...derivCheck.convertible].join(" ")}`,
        },
        { status: 422 }
      );
    }

    // Everything checks out — write the ORIGINAL to storage_path (retained, untouched)
    // and the DERIVATIVE to pub/<hash>.mp4 (what actually gets published).
    const publishRel = `pub/${hash}.mp4`;
    const publishAbs = path.join(config.assetStorageDir, publishRel);
    await fs.mkdir(config.assetStorageDir, { recursive: true });
    await fs.mkdir(path.dirname(publishAbs), { recursive: true });
    await fs.writeFile(path.join(config.assetStorageDir, storageRel), buf);
    await fs.writeFile(publishAbs, derivBuf);
    await cleanupTemps();

    const { asset, deduped } = upsertAssetByHash({
      content_hash: hash,
      media_kind: "video",
      original_filename: file.name || null,
      storage_path: storageRel,
      // MUST point at the DERIVATIVE (publishRel), not the original (storageRel).
      // worker/publisher.py's _resolve_url gives public_url absolute precedence over
      // publish_path, so on any install with PUBLIC_ASSET_BASE_URL set, handing it the
      // original here would mean Meta gets cURL'd the exact 2160-wide footage this
      // route just proved Reels will refuse — silently defeating the whole conversion.
      // (Contrast the image branch below, which deliberately keeps public_url on the
      // original — see the comment there for why that asymmetry is fine.)
      public_url: config.publicAssetBaseUrl
        ? `${config.publicAssetBaseUrl.replace(/\/$/, "")}/${publishRel}`
        : null,
      thumbnail_path: null,
      mime_type: mime,
      byte_size: buf.length,
      publish_path: publishRel,
      conform_mode: "downscale",
      needs_review: 1,
      // Dimensions/duration/audio describe the DERIVATIVE — that's the file that's
      // actually published, and the cover-frame scrubber is bounded by its duration.
      width: derivMeta.width,
      height: derivMeta.height,
      duration_ms: derivMeta.duration_ms,
      has_audio: derivMeta.has_audio ? 1 : 0,
    });

    return NextResponse.json({
      asset,
      deduped,
      warnings: derivCheck.warnings,
      converted: {
        from: `${meta.width}×${meta.height}`,
        to: `${derivMeta.width}×${derivMeta.height}`,
      },
    });
  }

  const storageRel = `${hash}.${ext}`;
  const thumbRel = `thumbs/${hash}.jpg`;
  const storageAbs = path.join(config.assetStorageDir, storageRel);
  const thumbAbs = path.join(config.assetStorageDir, thumbRel);

  await fs.mkdir(path.dirname(thumbAbs), { recursive: true });
  await fs.writeFile(storageAbs, buf);

  let width: number | null = null;
  let height: number | null = null;
  try {
    const meta = await sharp(buf).metadata();
    width = meta.width ?? null;
    height = meta.height ?? null;
    await sharp(buf)
      .resize(THUMB_MAX, THUMB_MAX, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 78 })
      .toFile(thumbAbs);
  } catch {
    // Thumbnail is a nicety — if sharp chokes, keep the original and move on.
  }

  // Deliberately points at the ORIGINAL, not the (possibly-conformed) publish_path
  // derivative — asymmetric with the video branch above, and intentionally so. An
  // un-cropped image is still a legal Instagram post: Meta accepts any aspect ratio in
  // its own range and will itself crop/letterbox on publish (see video-spec.ts's
  // warnAboveRatio/warnBelowRatio comment for the video equivalent of this behavior).
  // A too-wide VIDEO, by contrast, is hard-refused by Reels — there is no server-side
  // fallback, so public_url must resolve to something Meta will actually accept. If
  // that ever stops being true for images (e.g. a future spec req makes conform
  // mandatory), this needs the same fix as the video branch.
  const publicUrl = config.publicAssetBaseUrl
    ? `${config.publicAssetBaseUrl.replace(/\/$/, "")}/${storageRel}`
    : null;

  // Conform to Instagram's publish spec (crop/pad + resize) and store the derivative
  // alongside the original. Never let a conform failure fail the upload — the worker
  // falls back to the original when publish_path is null.
  let publishPath: string | null = null;
  // Typed via ConformMode (not the narrower "none"|"crop"|"pad") only because that type
  // now includes "downscale" for the video path below — conformImage() itself (called
  // a few lines down) never returns "downscale"; this is a type-compatibility widening,
  // not a behavior change.
  let conformMode: ConformMode = "none";
  let needsReview = 0;
  try {
    const conformed = await conformImage(buf, "crop");
    const publishRel = `pub/${hash}.jpg`;
    const publishAbs = path.join(config.assetStorageDir, publishRel);
    await fs.mkdir(path.dirname(publishAbs), { recursive: true });
    await fs.writeFile(publishAbs, conformed.buffer);
    publishPath = publishRel;
    conformMode = conformed.mode;
    needsReview = conformed.needsReview ? 1 : 0;
  } catch (err) {
    console.error("Image conform failed; falling back to original at publish time.", err);
    publishPath = null;
  }

  const { asset, deduped } = upsertAssetByHash({
    content_hash: hash,
    media_kind: "image",
    original_filename: file.name || null,
    storage_path: storageRel,
    public_url: publicUrl,
    thumbnail_path: thumbRel,
    mime_type: mime,
    width,
    height,
    byte_size: buf.length,
    publish_path: publishPath,
    conform_mode: conformMode,
    needs_review: needsReview,
  });

  return NextResponse.json({ asset, deduped });
}
