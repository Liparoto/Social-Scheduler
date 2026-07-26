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

export const config = {
  repoRoot: REPO_ROOT,
  databasePath: resolveRepoPath(get("DATABASE_PATH", "data/socialscheduler.db")),
  assetStorageDir: resolveRepoPath(get("ASSET_STORAGE_DIR", "data/assets")),
  publicAssetBaseUrl: get("PUBLIC_ASSET_BASE_URL", ""),
  defaultTimezone: get("DEFAULT_TIMEZONE", "UTC"),
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
