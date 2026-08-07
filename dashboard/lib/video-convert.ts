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
import path from "node:path";

export class ConvertError extends Error {}

export type ConverterKind = "avconvert" | "ffmpeg";

/** A converter that is known to exist, and where it is. */
export interface ResolvedConverter {
  kind: ConverterKind;
  /** Absolute path wherever we resolved one ourselves. */
  bin: string;
}

const AVCONVERT_BIN = "/usr/bin/avconvert";

/**
 * Where this install keeps binaries it fetched for itself — the same gitignored,
 * per-install folder cloudflared already uses.
 *
 * Computed here rather than imported from `config` on purpose: this module's header
 * promises it stays free of database/HTTP concerns, and every caller can inject a
 * different directory for tests.
 */
export function defaultVendorDir(): string {
  return path.resolve(process.cwd(), "..", "data", "bin");
}

/** Candidate filenames for an executable, newest-first. Windows needs the .exe. */
function executableNames(base: string): string[] {
  return process.platform === "win32" ? [`${base}.exe`, base] : [base];
}

/**
 * This install's own ffmpeg, or null.
 *
 * Returns an ABSOLUTE path. That matters beyond tidiness: the worker and dashboard are
 * started by background launchers (launchd, a Scheduled Task, a Startup shortcut) whose
 * PATH is minimal, so a bare command name can be unresolvable there even when the same
 * name works in a terminal.
 */
export function vendoredFfmpegPath(vendorDir: string): string | null {
  for (const name of executableNames("ffmpeg")) {
    const candidate = path.join(vendorDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Look up an executable on PATH by hand.
 *
 * Windows is why this exists at all: the previous version probed only for a file named
 * exactly `ffmpeg`, but Windows names it `ffmpeg.exe` and `fs.existsSync` does not apply
 * PATHEXT. Anyone who had installed ffmpeg themselves was invisible to this app.
 */
function findOnPath(base: string): string | null {
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of (process.env.PATH || "").split(sep)) {
    if (!dir) continue;
    for (const name of executableNames(base)) {
      try {
        const candidate = path.join(dir, name);
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // ignore unreadable PATH entries
      }
    }
  }
  return null;
}

function resolveAvconvert(): ResolvedConverter | null {
  return fs.existsSync(AVCONVERT_BIN) ? { kind: "avconvert", bin: AVCONVERT_BIN } : null;
}

function resolveFfmpeg(vendorDir: string): ResolvedConverter | null {
  const bin = vendoredFfmpegPath(vendorDir) ?? findOnPath("ffmpeg");
  return bin ? { kind: "ffmpeg", bin } : null;
}

// Cached across calls — findConverter() runs on every video upload, and re-probing the
// filesystem each time would be wasteful. An explicit override always bypasses the cache
// so tests (and callers who know better) aren't stuck with whatever the first call
// happened to detect.
let cachedAuto: ResolvedConverter | null | undefined;

/**
 * Resolve which converter to use, in order: `avconvert` (macOS, always present,
 * preferred) -> this install's vendored ffmpeg -> ffmpeg on PATH -> `null`.
 *
 * `override`:
 * - `"off"` always returns `null`, regardless of what's installed.
 * - `"avconvert"` / `"ffmpeg"` force that KIND, but still require it to exist — forcing a
 *   converter that isn't installed returns `null` so the caller can render the real
 *   "nothing available" message instead of failing later at spawn time.
 * - omitted: probe once and cache the result for subsequent no-override calls.
 */
export function findConverter(
  override?: string,
  vendorDir: string = defaultVendorDir()
): ResolvedConverter | null {
  if (override === "off") return null;
  if (override === "avconvert") return resolveAvconvert();
  if (override === "ffmpeg") return resolveFfmpeg(vendorDir);

  if (cachedAuto === undefined) {
    cachedAuto = resolveAvconvert() ?? resolveFfmpeg(vendorDir);
  }
  return cachedAuto;
}

interface ConvertOpts {
  converter: ResolvedConverter;
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

export function buildArgs(converter: ConverterKind, input: string, output: string): string[] {
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
  const bin = converter.bin;
  const args = buildArgs(converter.kind, inputPath, outputPath);

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
                ? `${converter.kind} timed out after ${timeoutMs}ms converting ${inputPath}`
                : `${converter.kind} failed converting ${inputPath}: ${error.message}`
            )
          );
          return;
        }
        resolve();
      }
    );
  });
}
