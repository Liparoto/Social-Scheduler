import "server-only";
import fs from "node:fs";
import path from "node:path";

/*
  The dashboard and the Python worker share ONE install config: the .env at the
  repo root (one level above /dashboard). Next only auto-loads .env from its own
  root, so we read the repo-root .env ourselves — keeping a single source of truth.
*/

const REPO_ROOT = path.resolve(process.cwd(), "..");

function loadRootEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const text = fs.readFileSync(path.join(REPO_ROOT, ".env"), "utf8");
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const idx = line.indexOf("=");
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      if (key) out[key] = val;
    }
  } catch {
    /* no .env yet — fall back to defaults */
  }
  return out;
}

const fileEnv = loadRootEnv();

function get(key: string, fallback = ""): string {
  return process.env[key] ?? fileEnv[key] ?? fallback;
}

function resolveRepoPath(p: string): string {
  return path.isAbsolute(p) ? p : path.join(REPO_ROOT, p);
}

// VIDEO_CONVERT_TIMEOUT is seconds in .env (matching the other human-facing interval
// envs like WORKER_POLL_INTERVAL) but consumed in ms by convertVideo()'s execFile
// timeout. Guard against a blank/garbage value resolving to 0 (which would time out
// every conversion instantly) by falling back to the 300s default.
const videoConvertTimeoutSec = Number(get("VIDEO_CONVERT_TIMEOUT", "300"));

// "auto" | "avconvert" | "ffmpeg" | "off" — see lib/video-convert.ts's findConverter().
// Validated the same way asBoolLive() below validates DRY_RUN/KILL_SWITCH: an explicit
// allow-list, matched case-insensitively so "Off"/"OFF" behave like "off" rather than
// silently falling through to auto-detect. "off" is a safety switch — failing OPEN
// (running a conversion the operator meant to disable) on a typo is the wrong direction
// to fail, so an unrecognized value falls back to "auto" (today's default) with a loud
// warning, rather than being guessed at silently. A blank value is the documented way to
// request "auto" (see .env.example) and warns for nothing.
const VALID_VIDEO_CONVERTERS = new Set(["auto", "off", "avconvert", "ffmpeg"]);
function resolveVideoConverter(): string {
  const raw = get("VIDEO_CONVERTER", "auto");
  const normalized = raw.trim().toLowerCase();
  if (normalized === "") return "auto";
  if (VALID_VIDEO_CONVERTERS.has(normalized)) return normalized;
  console.warn(
    `VIDEO_CONVERTER="${raw}" is not one of auto/off/avconvert/ffmpeg — falling back to ` +
      `"auto". If you meant to disable conversion, set VIDEO_CONVERTER=off exactly.`
  );
  return "auto";
}

export const config = {
  repoRoot: REPO_ROOT,
  databasePath: resolveRepoPath(get("DATABASE_PATH", "data/socialscheduler.db")),
  assetStorageDir: resolveRepoPath(get("ASSET_STORAGE_DIR", "data/assets")),
  publicAssetBaseUrl: get("PUBLIC_ASSET_BASE_URL", ""),
  defaultTimezone: get("DEFAULT_TIMEZONE", "UTC"),
  // TikTok OAuth app credentials. These MUST come through get() rather than
  // process.env: Next auto-loads only dashboard/.env, and this install's .env lives at
  // the repo root so the Python worker can share it. Reading process.env directly leaves
  // them undefined no matter how many times the server is restarted.
  //
  // Server-only, and this module is marked "server-only" — the client secret must never
  // reach the browser.
  tiktokClientKey: get("TIKTOK_CLIENT_KEY", ""),
  tiktokClientSecret: get("TIKTOK_CLIENT_SECRET", ""),
  videoConverter: resolveVideoConverter(),
  videoConvertTimeoutMs:
    (Number.isFinite(videoConvertTimeoutSec) && videoConvertTimeoutSec > 0
      ? videoConvertTimeoutSec
      : 300) * 1000,
  // The worker derives a cadence time's band from these (worker/time_of_day.py derive_band).
  // The form reads the SAME values purely to print the band label next to a time, so it can
  // never show a band the worker would disagree with.
  bandTimes: {
    morning: get("TOD_MORNING", "09:00"),
    afternoon: get("TOD_AFTERNOON", "13:00"),
    evening: get("TOD_EVENING", "18:00"),
  },
};

// ---- Live safety-switch reads (DRY_RUN / KILL_SWITCH) -----------------------------
// Unlike config above (read once at module load, fine for paths/URLs that don't change
// while the server runs), DRY_RUN and KILL_SWITCH are safety switches the owner expects
// to flip in .env and have take effect without restarting the dashboard — exactly like
// worker/run.py's load_env(override=True) on every poll. So these two go through a
// live re-read of the .env file rather than the frozen `fileEnv` snapshot above.
//
// A short (<2s) memo avoids re-reading the file multiple times within one render/request,
// but never survives past that — the next request (even moments later, definitely the
// next page load) re-reads the file, so an edit to .env is visible without a restart.
const LIVE_ENV_TTL_MS = 2000;
let liveEnvCache: { data: Record<string, string>; loadedAt: number } | null = null;

function liveEnv(): Record<string, string> {
  const now = Date.now();
  if (!liveEnvCache || now - liveEnvCache.loadedAt > LIVE_ENV_TTL_MS) {
    liveEnvCache = { data: loadRootEnv(), loadedAt: now };
  }
  return liveEnvCache.data;
}

// Same semantics as worker/config.py's _as_bool: an explicit allow-list ("1", "true",
// "yes", "on", case-insensitive) turns the switch on; anything else present (including
// "0", "false", "off", "no", blank, or garbage like "2") turns it off. Only a genuinely
// *absent* key falls back to `defaultValue`.
function asBoolLive(key: string, defaultValue: boolean): boolean {
  // Mirrors worker/config.py's load_env(override=True): a live .env value always wins
  // over whatever's already in process.env, falling back to process.env only when the
  // key isn't present in .env at all.
  const env = liveEnv();
  const raw = key in env ? env[key] : process.env[key];
  if (raw === undefined) return defaultValue;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/** Mirrors worker/config.py's dry_run_active(): live read, default ON (fail-safe) when
 *  the key is absent entirely. */
export function isDryRun(): boolean {
  return asBoolLive("DRY_RUN", true);
}

/** Mirrors worker/config.py's kill_switch_active(): live read, default OFF when the key
 *  is absent entirely. */
export function isKillSwitchActive(): boolean {
  return asBoolLive("KILL_SWITCH", false);
}
