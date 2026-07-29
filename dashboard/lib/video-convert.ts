/**
 * Convert a video that Instagram Reels would otherwise refuse (too wide, e.g. an iPhone's
 * default 4K 2160x3840 recording) down to a size Reels accepts, preserving aspect ratio.
 *
 * Why an OS binary instead of a bundled dependency: `avconvert` ships with every macOS
 * install and needs nothing installed. `ffmpeg` is the fallback for a clone that isn't on
 * macOS, or where `avconvert` is somehow unavailable. Neither is a project dependency —
 * both are probed at runtime and the code degrades to "no conversion available" (`null`)
 * rather than failing to start.
 *
 * Deliberately pure of database/HTTP concerns: paths in, nothing out (or a rejection).
 */
import { execFile, type ExecFileException } from "node:child_process";
import fs from "node:fs";

export class ConvertError extends Error {}

export type Converter = "avconvert" | "ffmpeg";

// Cached across calls — findConverter() runs on every video upload, and re-probing the
// filesystem / spawning `ffmpeg -version` each time would be wasteful. An explicit
// override always bypasses the cache so tests (and callers who know better) aren't stuck
// with whatever the first call happened to detect.
let cachedAuto: Converter | null | undefined;

function probe(): Converter | null {
  if (fs.existsSync("/usr/bin/avconvert")) return "avconvert";
  if (hasFfmpeg()) return "ffmpeg";
  return null;
}

function hasFfmpeg(): boolean {
  const dirs = (process.env.PATH || "").split(path_sep());
  for (const dir of dirs) {
    if (!dir) continue;
    try {
      if (fs.existsSync(`${dir}/ffmpeg`)) return true;
    } catch {
      // ignore unreadable PATH entries
    }
  }
  return false;
}

function path_sep(): string {
  return process.platform === "win32" ? ";" : ":";
}

/**
 * Resolve which converter to use, in order: `avconvert` (macOS, always present, preferred)
 * -> `ffmpeg` (if on PATH) -> `null` (no conversion available).
 *
 * `override`:
 * - `"off"` always returns `null`, regardless of what's installed.
 * - `"avconvert"` / `"ffmpeg"` force that choice without touching the cache.
 * - omitted: probe once and cache the result for subsequent no-override calls.
 */
export function findConverter(override?: string): Converter | null {
  if (override === "off") return null;
  if (override === "avconvert" || override === "ffmpeg") return override;

  if (cachedAuto === undefined) {
    cachedAuto = probe();
  }
  return cachedAuto;
}

interface ConvertOpts {
  converter: Converter;
  timeoutMs: number;
}

// Fits the video inside a 1920x1920 box, preserving aspect ratio, matching what avconvert's
// Preset1920x1080 does for both landscape and portrait input:
// - force_original_aspect_ratio=decrease scales down to fit inside the w/h box without
//   distorting or padding (it never scales up, and never crops).
// - force_divisible_by=2 rounds the resulting dimensions to the nearest even number, which
//   h264 requires. This replaces the old "-2" shorthand, which only kept one derived
//   dimension even and, combined with a width-only cap, let portrait video balloon past a
//   1080x1920 shape (2160x3840 -> 1920x3414 instead of 1080x1920).
const FFMPEG_SCALE_FILTER = "scale=w=1920:h=1920:force_original_aspect_ratio=decrease:force_divisible_by=2";

export function buildArgs(converter: Converter, input: string, output: string): string[] {
  if (converter === "avconvert") {
    return ["-s", input, "-p", "Preset1920x1080", "-o", output, "--replace"];
  }
  return [
    "-y",
    "-nostdin",
    "-loglevel",
    "error",
    "-nostats",
    "-i",
    input,
    "-vf",
    FFMPEG_SCALE_FILTER,
    "-c:v",
    "h264",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    output,
  ];
}

// execFile buffers the child's stdout+stderr in memory and rejects if either exceeds
// `maxBuffer` — which defaults to a mere 1 MB. ffmpeg is verbose on stderr by default (banner,
// full stream metadata, a continuously-rewriting progress line), and even with `-loglevel
// error -nostats` quieting it above, this is a second, independent line of defense: an
// unexpectedly chatty converter (a future flag change, an unusual input, a different ffmpeg
// build) must never cause a spurious failure on an otherwise-successful conversion. We never
// use the output for anything but the error message on failure, so the only requirement is
// "large enough to never be the reason a conversion fails" — 64 MB is far beyond anything
// either converter has been observed to produce, even unquieted.
const MAX_CONVERTER_BUFFER_BYTES = 64 * 1024 * 1024;

function cleanupPartial(output: string): void {
  try {
    fs.rmSync(output, { force: true });
  } catch {
    // best-effort — nothing further we can do if this fails
  }
}

/**
 * Run the chosen converter, resolving on success and rejecting with `ConvertError`
 * otherwise. Uses `execFile` (never `exec`) so arguments are passed as an array — a
 * filename containing spaces or quotes can never be interpreted by a shell.
 *
 * On any failure path (nonzero exit, spawn error, or timeout) the process is killed if
 * still running and any partial output file is deleted before rejecting, so a half-written
 * video is never left on disk to be picked up later as if it were valid.
 */
export function convertVideo(
  inputPath: string,
  outputPath: string,
  opts: ConvertOpts
): Promise<void> {
  const { converter, timeoutMs } = opts;
  const bin = converter === "avconvert" ? "/usr/bin/avconvert" : "ffmpeg";
  const args = buildArgs(converter, inputPath, outputPath);

  return new Promise<void>((resolve, reject) => {
    // execFile's own `timeout` option sends SIGTERM to the child and marks the resulting
    // error `killed: true` if it's still running after `timeoutMs` — this is what actually
    // terminates the process on timeout, not just abandoning the promise. The callback
    // fires for every failure path (nonzero exit, spawn error, or timeout alike), so
    // cleanup only needs to happen in one place.
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: MAX_CONVERTER_BUFFER_BYTES },
      (error: ExecFileException | null) => {
        if (error) {
          cleanupPartial(outputPath);
          reject(
            new ConvertError(
              error.killed
                ? `${converter} timed out after ${timeoutMs}ms converting ${inputPath}`
                : `${converter} failed converting ${inputPath}: ${error.message}`
            )
          );
          return;
        }
        resolve();
      }
    );
  });
}
